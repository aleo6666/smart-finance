from datetime import datetime, timedelta

from jose import jwt

from app.core.config import get_settings


def _register(client, email="alice@example.com", password="secret123"):
    return client.post(
        "/api/auth/email/register-simple",
        json={"email": email, "password": password},
    )


def _login(client, email="alice@example.com", password="secret123"):
    return client.post(
        "/api/auth/email/login", json={"email": email, "password": password}
    )


def test_register_returns_token_and_creates_default_ledger(api_client) -> None:
    response = _register(api_client)

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["data"]["token"]
    assert isinstance(body["data"]["userId"], int)

    token = body["data"]["token"]
    me = api_client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {token}"}
    ).json()
    assert me["success"] is True
    assert me["data"]["user"]["email"] == "alice@example.com"
    assert [ledger["name"] for ledger in me["data"]["ledgers"]] == ["我的账本"]


def test_login_with_correct_password(api_client) -> None:
    _register(api_client)

    response = _login(api_client)

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["data"]["token"]
    assert body["data"]["userId"] == body["data"]["userId"]


def test_login_with_wrong_password_is_rejected(api_client) -> None:
    _register(api_client)

    response = _login(api_client, password="wrong-password")

    assert response.status_code == 401
    assert response.json()["success"] is False


def test_register_with_short_password_is_rejected(api_client) -> None:
    response = _register(api_client, password="12345")

    assert response.status_code == 400
    assert response.json()["success"] is False


def test_register_duplicate_email_is_conflict(api_client) -> None:
    _register(api_client)

    response = _register(api_client)

    assert response.status_code == 409
    assert response.json()["success"] is False


def test_me_returns_current_user_and_ledgers(api_client) -> None:
    token = _register(api_client).json()["data"]["token"]

    response = api_client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["data"]["user"]["email"] == "alice@example.com"
    assert body["data"]["ledgers"] == [
        {
            "id": body["data"]["ledgers"][0]["id"],
            "user_id": body["data"]["user"]["id"],
            "name": "我的账本",
            "icon": None,
            "color": None,
            "base_currency": "CNY",
            "created_at": body["data"]["ledgers"][0]["created_at"],
        }
    ]


def test_me_with_expired_token_is_rejected(api_client) -> None:
    user_id = _register(api_client).json()["data"]["userId"]
    secret = get_settings().jwt_secret.get_secret_value()
    expired = jwt.encode(
        {"user_id": user_id, "exp": datetime.utcnow() - timedelta(minutes=1)},
        secret,
        algorithm="HS256",
    )

    response = api_client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {expired}"}
    )

    assert response.status_code == 401
    assert response.json()["error"] == "登录已过期"
