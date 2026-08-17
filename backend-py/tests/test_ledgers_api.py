def _register(client, email="alice@example.com", password="secret123") -> str:
    return client.post(
        "/api/auth/email/register-simple",
        json={"email": email, "password": password},
    ).json()["data"]["token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_default_ledger_exists_after_register(api_client) -> None:
    token = _register(api_client)

    ledgers = api_client.get("/api/ledgers", headers=_auth(token)).json()["data"]

    assert [ledger["name"] for ledger in ledgers] == ["我的账本"]
    assert ledgers[0]["base_currency"] == "CNY"


def test_create_list_update_delete_ledger(api_client) -> None:
    token = _register(api_client)

    created = api_client.post(
        "/api/ledgers",
        json={"name": "家庭账本", "base_currency": "USD", "color": "#ffffff"},
        headers=_auth(token),
    )
    assert created.status_code == 200
    ledger = created.json()["data"]
    assert ledger["name"] == "家庭账本"
    assert ledger["base_currency"] == "USD"
    assert ledger["color"] == "#ffffff"
    assert ledger["icon"] is None

    updated = api_client.put(
        f"/api/ledgers/{ledger['id']}",
        json={"name": "家庭账本·改", "color": "#000000"},
        headers=_auth(token),
    )
    assert updated.status_code == 200
    assert updated.json()["data"]["name"] == "家庭账本·改"

    deleted = api_client.delete(f"/api/ledgers/{ledger['id']}", headers=_auth(token))
    assert deleted.status_code == 200
    names = [
        item["name"]
        for item in api_client.get("/api/ledgers", headers=_auth(token)).json()["data"]
    ]
    assert "家庭账本·改" not in names


def test_create_ledger_requires_name(api_client) -> None:
    token = _register(api_client)

    response = api_client.post(
        "/api/ledgers", json={"name": ""}, headers=_auth(token)
    )

    assert response.status_code == 400
    assert response.json()["success"] is False


def test_cross_user_cannot_touch_others_ledger(api_client) -> None:
    token_a = _register(api_client, "alice@example.com")
    token_b = _register(api_client, "bob@example.com")

    ledger_id = api_client.get("/api/ledgers", headers=_auth(token_a)).json()["data"][0]["id"]

    updated = api_client.put(
        f"/api/ledgers/{ledger_id}", json={"name": "hacked"}, headers=_auth(token_b)
    )
    assert updated.status_code == 404

    deleted = api_client.delete(f"/api/ledgers/{ledger_id}", headers=_auth(token_b))
    assert deleted.status_code == 404

    # Owner's ledger is untouched.
    ledgers = api_client.get("/api/ledgers", headers=_auth(token_a)).json()["data"]
    assert ledgers[0]["name"] == "我的账本"
