"""支付宝/微信账单 CSV 解析单元测试（含中文/BOM/GBK）。"""

from decimal import Decimal

import pytest

from app.services.importers.csv_bill import CsvBillError, decode_bytes, parse_csv_bill

ALIPAY_HEADER = "交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态"
WECHAT_HEADER = "交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态"


def _register(client, email="alice@example.com", password="secret123") -> str:
    return client.post(
        "/api/auth/email/register-simple",
        json={"email": email, "password": password},
    ).json()["data"]["token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_parse_alipay_csv() -> None:
    text = "\n".join(
        [
            "支付宝交易记录明细查询",
            ALIPAY_HEADER,
            "2026-08-17 12:30:00,餐饮美食,麦当劳,,汉堡套餐,支出,45.00,支付宝,交易成功",
            "2026-08-17 18:00:00,交通出行,滴滴出行,,打车费,支出,23.50,余额宝,交易成功",
        ]
    )

    transactions = parse_csv_bill(text, "alipay")

    assert len(transactions) == 2
    assert transactions[0]["date"] == "2026-08-17"
    assert transactions[0]["type"] == "expense"
    assert transactions[0]["amount"] == Decimal("45.00")
    assert transactions[0]["category"] == "餐饮"
    assert transactions[1]["category"] == "交通"


def test_parse_alipay_income_and_thousands_separator() -> None:
    text = "\n".join(
        [
            ALIPAY_HEADER,
            "2026-08-15 09:00:00,其他,某公司,,工资入账,收入,\"8,000.00\",银行卡,交易成功",
        ]
    )

    transactions = parse_csv_bill(text, "alipay")

    assert transactions[0]["type"] == "income"
    assert transactions[0]["amount"] == Decimal("8000.00")
    assert transactions[0]["category"] == "工资"


def test_parse_alipay_unmapped_category_defaults_to_uncategorized() -> None:
    text = "\n".join(
        [
            ALIPAY_HEADER,
            "2026-08-17 12:30:00,其他,某不知名公司,,某商品,支出,10.00,支付宝,交易成功",
        ]
    )

    transactions = parse_csv_bill(text, "alipay")

    assert transactions[0]["category"] == "未分类"


def test_parse_wechat_csv_with_bom() -> None:
    text = "﻿" + "\n".join(
        [
            "微信支付账单明细",
            WECHAT_HEADER,
            "2026-08-16 10:00:00,商户消费,全家便利店,零食,支出,12.30,零钱,支付成功",
            "2026-08-16 11:00:00,商户消费,滴滴出行,打车,支出,30.00,零钱,支付成功",
        ]
    )

    transactions = parse_csv_bill(text, "wechat")

    assert len(transactions) == 2
    assert transactions[0]["category"] == "购物"
    assert transactions[1]["category"] == "交通"


def test_parse_wechat_skips_neutral_direction() -> None:
    text = "\n".join(
        [
            WECHAT_HEADER,
            "2026-08-16 09:00:00,零钱提现,微信零钱,提现,/,100.00,零钱,成功",
            "2026-08-16 10:00:00,商户消费,全家便利店,零食,支出,12.30,零钱,支付成功",
        ]
    )

    transactions = parse_csv_bill(text, "wechat")

    assert len(transactions) == 1
    assert transactions[0]["amount"] == Decimal("12.30")


def test_decode_bytes_handles_gbk() -> None:
    gbk_bytes = "交易时间,交易分类\n2026-08-17 12:00:00,餐饮美食".encode("gbk")

    decoded = decode_bytes(gbk_bytes)

    assert "交易时间" in decoded


def test_parse_unknown_platform_raises() -> None:
    with pytest.raises(CsvBillError, match="暂不支持该平台账单格式"):
        parse_csv_bill(ALIPAY_HEADER, "unknown")


def test_parse_missing_header_raises() -> None:
    with pytest.raises(CsvBillError, match="无法识别账单表头"):
        parse_csv_bill("没有表头的一行,无,数据", "alipay")


def test_csv_preview_then_confirm_full_flow(api_client) -> None:
    token = _register(api_client)
    content = "\n".join(
        [
            ALIPAY_HEADER,
            "2026-08-17 12:30:00,餐饮美食,麦当劳,,汉堡套餐,支出,45.00,支付宝,交易成功",
        ]
    ).encode("utf-8")

    preview = api_client.post(
        "/api/import/csv-bill/preview",
        files={"file": ("bill.csv", content, "text/csv")},
        data={"platform": "alipay"},
        headers=_auth(token),
    )
    assert preview.status_code == 200
    body = preview.json()["data"]
    assert body["count"] == 1
    assert body["transactions"][0]["amount"] == "45.00"
    assert body["transactions"][0]["category"] == "餐饮"

    # 预览绝不入库
    assert api_client.get("/api/records", headers=_auth(token)).json()["data"] == []

    confirm = api_client.post(
        "/api/import/csv-bill/confirm",
        json={"platform": "alipay", "transactions": body["transactions"]},
        headers=_auth(token),
    )
    assert confirm.status_code == 200
    assert confirm.json()["data"]["created"] == 1

    records = api_client.get("/api/records", headers=_auth(token)).json()["data"]
    assert len(records) == 1
    assert records[0]["amount"] == "45.00"
    assert records[0]["category"] == "餐饮"
