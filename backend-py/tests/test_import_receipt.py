"""发票/收据 OCR 记账：建议结构 + 确认后入库 + 凭证路径。"""

from pathlib import Path

from app.api.ocr import get_ocr_engine
from app.core.config import Settings, get_settings


def _register(client, email="alice@example.com", password="secret123") -> str:
    return client.post(
        "/api/auth/email/register-simple",
        json={"email": email, "password": password},
    ).json()["data"]["token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class _FakeEngine:
    def recognize(self, image_bytes: bytes) -> str:
        return "星巴克咖啡\n订单号 20260818-001\n2026-08-18 14:30\n合计 ￥ 45.00\n谢谢惠顾"


def test_receipt_preview_returns_suggestions_and_saves_file(api_client, tmp_path) -> None:
    token = _register(api_client)
    api_client.app.dependency_overrides[get_ocr_engine] = lambda: _FakeEngine()
    api_client.app.dependency_overrides[get_settings] = lambda: Settings(
        upload_dir=str(tmp_path)
    )

    image_bytes = b"\x89PNG\r\n\x1a\n" + b"0" * 400
    response = api_client.post(
        "/api/import/receipt",
        files={"image": ("receipt.png", image_bytes, "image/png")},
        headers=_auth(token),
    )

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["amount"] == "45.00"
    assert data["date"] == "2026-08-18"
    assert data["merchant"] == "星巴克咖啡"
    assert data["category_guess"] == "餐饮"
    assert data["receipt_path"]
    assert Path(data["receipt_path"]).exists()


def test_receipt_confirm_creates_record_with_receipt_path(api_client) -> None:
    token = _register(api_client)

    response = api_client.post(
        "/api/import/receipt/confirm",
        json={
            "receipt_path": "uploads/receipt_test_1.png",
            "type": "expense",
            "category": "餐饮",
            "amount": "45.00",
            "date": "2026-08-18",
            "note": "星巴克咖啡",
        },
        headers=_auth(token),
    )

    assert response.status_code == 200
    record = response.json()["data"]
    assert record["receipt_path"] == "uploads/receipt_test_1.png"
    assert record["amount"] == "45.00"
    assert record["category"] == "餐饮"
    assert record["type"] == "expense"
    assert record["occurred_at"] is not None

    # 已入库，且归属当前用户
    listed = api_client.get("/api/records", headers=_auth(token)).json()["data"]
    assert [item["id"] for item in listed] == [record["id"]]


def test_receipt_confirm_rejects_unsafe_path(api_client) -> None:
    token = _register(api_client)

    response = api_client.post(
        "/api/import/receipt/confirm",
        json={
            "receipt_path": "../../etc/passwd",
            "type": "expense",
            "category": "餐饮",
            "amount": "45.00",
        },
        headers=_auth(token),
    )

    assert response.status_code == 400
