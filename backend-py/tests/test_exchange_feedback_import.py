"""Smoke tests for the legacy-parity modules: exchange rates / user feedback /
bill batch import (对齐旧 Node 后端三模块的 Python 实现).

Exchange 数据通过会话直接播种快照（不依赖外网）；
Feedback / Import 走完整 API 流程。
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from decimal import Decimal

import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.database import get_db
from app.main import create_app
from app.models import Base
from app.models.support import ExchangeRate, ImportBatch


WECHAT_CSV = """微信支付账单明细
微信昵称：测试用户
起始时间：2026-08-01 00:00:00 终止时间：2026-08-31 23:59:59
导出类型：全部
共2笔记录
收入：0.00 支出：60.50 中性交易：0.00
---
交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
2026-08-01 12:30:00,餐饮美食,肯德基,午餐套餐,支出,35.00,微信支付,支付成功,10001,20001,
2026-08-02 09:00:00,交通出行,滴滴出行,快车,支出,25.50,微信支付,支付成功,10002,20002,
"""

GENERIC_CSV = """日期,金额,分类,收支,描述
2026-08-05,88.00,餐饮,支出,朋友聚餐
2026-08-06,50.00,交通,支出,地铁充值
"""


@pytest_asyncio.fixture
async def api_env():
    """TestClient + 可直接写入的 session 工厂（用于播种汇率快照/改批次时间）。"""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    application = create_app(chat_agent=object())

    async def override_get_db():
        async with sessions() as session:
            yield session

    application.dependency_overrides[get_db] = override_get_db
    with TestClient(application) as client:
        yield client, sessions
    await engine.dispose()


def _register(client, email="support@example.com", password="secret123"):
    response = client.post(
        "/api/auth/email/register-simple",
        json={"email": email, "password": password},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _seed_usd_rates(sessions) -> None:
    """播种 USD/CNY 快照：近 5 天 7.40→7.60 阶梯 + 1 小时前 7.80（触发波动/趋势/阈值）。"""

    async def seed():
        now = datetime.now()
        async with sessions() as session:
            rows = []
            for index in range(5):
                day = now - timedelta(days=5 - index, hours=2)
                rate = Decimal("7.40") + Decimal(index) * Decimal("0.05")
                rows.append(ExchangeRate(currency="USD", rate=rate, fetched_at=day))
            rows.append(
                ExchangeRate(
                    currency="USD",
                    rate=Decimal("7.80"),
                    fetched_at=now - timedelta(hours=1),
                )
            )
            session.add_all(rows)
            await session.commit()

    asyncio.run(seed())


# ---------- exchange ----------

def test_exchange_latest_rates(api_env) -> None:
    client, sessions = api_env
    _seed_usd_rates(sessions)

    response = client.get("/api/exchange/latest")
    assert response.status_code == 200
    data = response.json()["data"]
    assert "USD" in data
    assert abs(data["USD"]["rate"] - 7.80) < 0.001
    assert data["USD"]["updatedAt"]
    # (7.80-7.60)/7.60 = 2.63%
    assert data["USD"]["change24h"] is not None
    assert abs(data["USD"]["change24h"] - 2.63) < 0.01


def test_exchange_detail_with_history_trend_and_advice(api_env) -> None:
    client, sessions = api_env
    _seed_usd_rates(sessions)

    response = client.get("/api/exchange/detail/USD")
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["currency"] == "USD"
    assert data["current"] == 7.80
    assert len(data["history"]) == 6
    assert data["history"][0]["rate"] == 7.40
    assert data["trend"]["direction"] == "上涨"
    assert abs(data["trend"]["totalChange"] - 3.31) < 0.01
    assert data["advice"] is not None
    assert data["advice"]["direction"] == "up"
    assert data["weeklyReport"] is not None
    assert data["weeklyReport"]["weekChange"] > 0


def test_exchange_alerts_weekly_and_context(api_env) -> None:
    client, sessions = api_env
    _seed_usd_rates(sessions)

    alerts = client.get("/api/exchange/alerts").json()["data"]
    rules = {alert["rule"] for alert in alerts}
    assert "volatility" in rules
    assert "trend" in rules
    assert "threshold_high" in rules

    weekly = client.get("/api/exchange/weekly").json()["data"]
    assert "USD" in weekly["currencies"]

    context = client.get("/api/exchange/context").json()["data"]
    assert "## 当前汇率（CNY）" in context
    assert "USD" in context


# ---------- feedback ----------

def test_feedback_submit_list_and_status(api_env) -> None:
    client, _ = api_env
    token = _register(client)["token"]
    headers = _auth(token)

    submitted = client.post(
        "/api/feedback",
        data={"type": "bug", "content": "记账页面发现一个bug，报错崩溃了"},
        headers=headers,
    )
    assert submitted.status_code == 200
    data = submitted.json()["data"]
    assert data["type"] == "bug"
    assert data["priority"] == "P0"

    listing = client.get("/api/feedback", headers=headers).json()
    assert len(listing["data"]) == 1

    status = client.get(f"/api/feedback/status/{data['id']}", headers=headers).json()
    assert status["data"]["content"].startswith("记账页面")


def test_feedback_empty_content_rejected(api_env) -> None:
    client, _ = api_env
    token = _register(client)["token"]
    response = client.post(
        "/api/feedback", data={"content": "   "}, headers=_auth(token)
    )
    assert response.status_code == 400


def test_feedback_screenshot_upload_and_size_limit(api_env) -> None:
    client, _ = api_env
    token = _register(client)["token"]
    headers = _auth(token)

    uploaded = client.post(
        "/api/feedback",
        data={"type": "suggestion", "content": "希望增加深色模式"},
        files={"screenshot": ("shot.png", b"fake-png-bytes", "image/png")},
        headers=headers,
    )
    assert uploaded.status_code == 200
    assert uploaded.json()["data"]["image_path"].endswith(".png")

    too_big = client.post(
        "/api/feedback",
        data={"type": "suggestion", "content": "超限截图"},
        files={"screenshot": ("big.png", b"x" * (5 * 1024 * 1024 + 1), "image/png")},
        headers=headers,
    )
    assert too_big.status_code == 400


def test_feedback_survey(api_env) -> None:
    client, _ = api_env
    token = _register(client)["token"]
    headers = _auth(token)

    check = client.get("/api/feedback/survey", headers=headers).json()
    assert check["data"]["showSurvey"] is False

    submitted = client.post(
        "/api/feedback/survey",
        json={"rating": 5, "comment": "很好用"},
        headers=headers,
    )
    assert submitted.status_code == 200
    listing = client.get("/api/feedback", headers=headers).json()
    assert any(item["type"] == "survey" for item in listing["data"])


def test_feedback_admin_all_and_update(api_env) -> None:
    client, _ = api_env
    token = _register(client)["token"]
    headers = _auth(token)

    created = client.post(
        "/api/feedback",
        data={"type": "ux", "content": "界面不好用"},
        headers=headers,
    ).json()["data"]

    admin = client.get("/api/feedback/admin/all", headers=headers).json()
    assert len(admin["data"]) == 1

    updated = client.put(
        f"/api/feedback/admin/{created['id']}",
        json={"status": "resolved", "admin_reply": "已处理"},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["data"]["status"] == "resolved"
    assert updated.json()["data"]["admin_reply"] == "已处理"


# ---------- import: upload / paste ----------

def test_import_upload_wechat_batch(api_env) -> None:
    client, _ = api_env
    token = _register(client)["token"]
    headers = _auth(token)

    response = client.post(
        "/api/import/upload",
        data={},
        files={"file": ("wechat.csv", WECHAT_CSV.encode("utf-8"), "text/csv")},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["sourceType"] == "wechat"
    assert data["status"] == "preview"
    assert data["totalCount"] == 2
    assert data["validCount"] == 2
    assert len(data["records"]) == 2
    record = data["records"][0]
    assert record["type"] == "expense"
    assert record["amount"] == 35.0
    assert record["category"] == "餐饮"
    assert record["merchant"] == "肯德基"
    assert record["selected"] is True


def test_import_paste_generic(api_env) -> None:
    client, _ = api_env
    token = _register(client)["token"]
    headers = _auth(token)

    response = client.post(
        "/api/import/paste",
        json={"content": GENERIC_CSV, "file_name": "paste.csv"},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["sourceType"] == "generic"
    assert data["validCount"] == 2
    assert data["records"][0]["category"] == "餐饮"

    empty = client.post(
        "/api/import/paste", json={"content": "  "}, headers=headers
    )
    assert empty.status_code == 400


# ---------- import: lifecycle ----------

def test_import_batches_list_detail_and_edit(api_env) -> None:
    client, _ = api_env
    token = _register(client)["token"]
    headers = _auth(token)

    created = client.post(
        "/api/import/upload",
        data={},
        files={"file": ("wechat.csv", WECHAT_CSV.encode("utf-8"), "text/csv")},
        headers=headers,
    ).json()["data"]
    batch_id = created["id"]
    record_id = created["records"][0]["id"]

    listing = client.get("/api/import/batches?page=1&pageSize=10", headers=headers).json()
    assert listing["data"]["total"] == 1
    assert listing["data"]["list"][0]["id"] == batch_id

    detail = client.get(f"/api/import/{batch_id}", headers=headers).json()["data"]
    assert len(detail["records"]) == 2

    edited = client.put(
        f"/api/import/{batch_id}/records/{record_id}",
        json={"category": "工作餐", "merchant": "KFC"},
        headers=headers,
    )
    assert edited.status_code == 200
    edited_record = next(r for r in edited.json()["data"]["records"] if r["id"] == record_id)
    assert edited_record["category"] == "工作餐"
    assert edited_record["merchant"] == "KFC"

    deselected = client.post(
        f"/api/import/{batch_id}/select",
        json={"recordIds": [record_id], "selected": False},
        headers=headers,
    ).json()["data"]
    assert next(r for r in deselected["records"] if r["id"] == record_id)["selected"] is False


def test_import_confirm_creates_transactions(api_env) -> None:
    client, _ = api_env
    token = _register(client)["token"]
    headers = _auth(token)

    created = client.post(
        "/api/import/upload",
        data={},
        files={"file": ("wechat.csv", WECHAT_CSV.encode("utf-8"), "text/csv")},
        headers=headers,
    ).json()["data"]
    batch_id = created["id"]

    confirmed = client.post(
        f"/api/import/{batch_id}/confirm",
        json={"selectedIds": None},
        headers=headers,
    )
    assert confirmed.status_code == 200, confirmed.text
    result = confirmed.json()["data"]
    assert result["importedCount"] == 2
    assert len(result["recordIds"]) == 2

    detail = client.get(f"/api/import/{batch_id}", headers=headers).json()["data"]
    assert detail["status"] == "imported"
    assert all(r["status"] == "imported" and r["recordId"] for r in detail["records"])

    records = client.get("/api/records", headers=headers).json()["data"]
    assert len(records) == 2

    # 已导入批次不可重复确认
    again = client.post(
        f"/api/import/{batch_id}/confirm",
        json={"selectedIds": None},
        headers=headers,
    )
    assert again.status_code == 400


def test_import_duplicate_detection(api_env) -> None:
    client, _ = api_env
    token = _register(client)["token"]
    headers = _auth(token)

    first = client.post(
        "/api/import/upload",
        data={},
        files={"file": ("wechat.csv", WECHAT_CSV.encode("utf-8"), "text/csv")},
        headers=headers,
    ).json()["data"]
    client.post(f"/api/import/{first['id']}/confirm", json={}, headers=headers)

    # 再次上传同一份账单 → 全部标记重复且默认不选中
    second = client.post(
        "/api/import/upload",
        data={},
        files={"file": ("wechat.csv", WECHAT_CSV.encode("utf-8"), "text/csv")},
        headers=headers,
    ).json()["data"]
    assert second["duplicateCount"] == 2
    assert all(r["isDuplicate"] for r in second["records"])
    assert all(r["similarity"] >= 0.85 for r in second["records"])
    assert all(r["selected"] is False for r in second["records"])


def test_import_rollback_removes_transactions(api_env) -> None:
    client, _ = api_env
    token = _register(client)["token"]
    headers = _auth(token)

    created = client.post(
        "/api/import/upload",
        data={},
        files={"file": ("wechat.csv", WECHAT_CSV.encode("utf-8"), "text/csv")},
        headers=headers,
    ).json()["data"]
    batch_id = created["id"]
    client.post(f"/api/import/{batch_id}/confirm", json={}, headers=headers)

    rolled = client.post(f"/api/import/{batch_id}/rollback", headers=headers)
    assert rolled.status_code == 200
    assert rolled.json()["data"]["rolledBackCount"] == 2

    detail = client.get(f"/api/import/{batch_id}", headers=headers).json()["data"]
    assert detail["status"] == "rolled_back"
    assert detail["importedCount"] == 0
    assert all(r["status"] == "rolled_back" for r in detail["records"])

    records = client.get("/api/records", headers=headers).json()["data"]
    assert records == []

    # 已回滚批次不可再回滚
    again = client.post(f"/api/import/{batch_id}/rollback", headers=headers)
    assert again.status_code == 400


def test_import_rollback_after_24h_rejected(api_env) -> None:
    client, sessions = api_env
    token = _register(client)["token"]
    headers = _auth(token)

    created = client.post(
        "/api/import/upload",
        data={},
        files={"file": ("wechat.csv", WECHAT_CSV.encode("utf-8"), "text/csv")},
        headers=headers,
    ).json()["data"]
    batch_id = created["id"]
    client.post(f"/api/import/{batch_id}/confirm", json={}, headers=headers)

    async def age_batch():
        async with sessions() as session:
            batch = await session.get(ImportBatch, batch_id)
            batch.imported_at = datetime.now() - timedelta(hours=25)
            await session.commit()

    asyncio.run(age_batch())

    response = client.post(f"/api/import/{batch_id}/rollback", headers=headers)
    assert response.status_code == 400
    assert "24 小时" in response.json()["error"]


def test_import_batch_ownership_isolated(api_env) -> None:
    client, _ = api_env
    other = _register(client, email="other@example.com")["token"]

    created = client.post(
        "/api/import/upload",
        data={},
        files={"file": ("wechat.csv", WECHAT_CSV.encode("utf-8"), "text/csv")},
        headers=_auth(_register(client, email="owner@example.com")["token"]),
    ).json()["data"]
    batch_id = created["id"]

    # 他人不可见/不可操作
    assert client.get(f"/api/import/{batch_id}", headers=_auth(other)).status_code == 404
    assert client.post(f"/api/import/{batch_id}/confirm", json={}, headers=_auth(other)).status_code == 400
