PROTECTED_GETS = [
    "/api/records",
    "/api/ledgers",
    "/api/budgets",
    "/api/goals",
    "/api/financial/metrics",
    "/api/financial/overview",
    "/api/analysis/all",
    "/api/reports",
    "/api/reports/history",
    "/api/knowledge/documents",
]


def _register(client, email="alice@example.com", password="secret123") -> str:
    return client.post(
        "/api/auth/email/register-simple",
        json={"email": email, "password": password},
    ).json()["data"]["token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_protected_routes_reject_missing_token(api_client) -> None:
    for path in PROTECTED_GETS:
        response = api_client.get(path)
        assert response.status_code == 401, path
        body = response.json()
        assert body["success"] is False, path
        assert body["error"] == "未登录", path

    # 旧版接口把 user_id 放在 query 里；不能再用它绕过登录。
    for path in [
        "/api/financial/overview",
        "/api/financial/metrics",
        "/api/analysis/all",
        "/api/reports/history",
        "/api/knowledge/documents",
    ]:
        response = api_client.get(f"{path}?user_id=999999")
        assert response.status_code == 401, path
        assert response.json()["error"] == "未登录", path


def test_protected_routes_reject_garbage_token(api_client) -> None:
    for path in PROTECTED_GETS:
        response = api_client.get(path, headers=_auth("not-a-jwt"))
        assert response.status_code == 401, path
        assert response.json()["error"] == "登录已过期", path


def test_protected_routes_reject_tampered_token(api_client) -> None:
    token = _register(api_client)
    tampered = token[:-1] + ("A" if token[-1] != "A" else "B")

    response = api_client.get("/api/records", headers=_auth(tampered))

    assert response.status_code == 401
    assert response.json()["error"] == "登录已过期"
