def _register(client, email="alice@example.com", password="secret123") -> str:
    return client.post(
        "/api/auth/email/register-simple",
        json={"email": email, "password": password},
    ).json()["data"]["token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_create_and_list_record(api_client) -> None:
    token = _register(api_client)

    created = api_client.post(
        "/api/records",
        json={"type": "expense", "category": "餐饮", "amount": "25.50", "note": "午饭"},
        headers=_auth(token),
    )
    assert created.status_code == 200
    record = created.json()["data"]
    assert record["type"] == "expense"
    assert record["category"] == "餐饮"
    assert record["amount"] == "25.50"
    assert record["note"] == "午饭"
    assert record["description"] == "午饭"
    assert record["ledger_id"] == record["ledgerId"]

    listed = api_client.get("/api/records", headers=_auth(token))
    assert listed.status_code == 200
    data = listed.json()["data"]
    assert [item["id"] for item in data] == [record["id"]]
    assert data[0]["date"] is not None


def test_create_record_without_ledger_uses_default_ledger(api_client) -> None:
    token = _register(api_client)

    created = api_client.post(
        "/api/records",
        json={"type": "expense", "category": "交通", "amount": "8.00"},
        headers=_auth(token),
    ).json()["data"]

    assert created["ledger_id"] is not None
    ledgers = api_client.get("/api/ledgers", headers=_auth(token)).json()["data"]
    assert created["ledger_id"] == ledgers[0]["id"]


def test_income_record_supports_income_source(api_client) -> None:
    token = _register(api_client)

    created = api_client.post(
        "/api/records",
        json={"type": "income", "category": "工资", "amount": "10000.00", "income_source": "salary"},
        headers=_auth(token),
    )
    assert created.status_code == 200
    assert created.json()["data"]["income_source"] == "salary"


def test_record_amount_must_be_positive(api_client) -> None:
    token = _register(api_client)

    zero = api_client.post(
        "/api/records",
        json={"type": "expense", "category": "餐饮", "amount": "0"},
        headers=_auth(token),
    )
    assert zero.status_code == 422

    negative = api_client.post(
        "/api/records",
        json={"type": "expense", "category": "餐饮", "amount": "-5.00"},
        headers=_auth(token),
    )
    assert negative.status_code == 422


def test_record_type_must_be_income_or_expense(api_client) -> None:
    token = _register(api_client)

    response = api_client.post(
        "/api/records",
        json={"type": "transfer", "category": "其他", "amount": "10.00"},
        headers=_auth(token),
    )
    assert response.status_code == 422


def test_update_and_delete_own_record(api_client) -> None:
    token = _register(api_client)
    record_id = api_client.post(
        "/api/records",
        json={"type": "expense", "category": "餐饮", "amount": "10.00"},
        headers=_auth(token),
    ).json()["data"]["id"]

    updated = api_client.put(
        f"/api/records/{record_id}",
        json={"amount": "12.00", "category": "娱乐"},
        headers=_auth(token),
    )
    assert updated.status_code == 200
    assert updated.json()["data"]["amount"] == "12.00"
    assert updated.json()["data"]["category"] == "娱乐"

    deleted = api_client.delete(f"/api/records/{record_id}", headers=_auth(token))
    assert deleted.status_code == 200
    assert api_client.get("/api/records", headers=_auth(token)).json()["data"] == []


def test_cross_user_cannot_touch_others_record(api_client) -> None:
    token_a = _register(api_client, "alice@example.com")
    token_b = _register(api_client, "bob@example.com")

    record_id = api_client.post(
        "/api/records",
        json={"type": "expense", "category": "餐饮", "amount": "10.00"},
        headers=_auth(token_a),
    ).json()["data"]["id"]

    updated = api_client.put(
        f"/api/records/{record_id}",
        json={"amount": "999.00"},
        headers=_auth(token_b),
    )
    assert updated.status_code == 404

    deleted = api_client.delete(f"/api/records/{record_id}", headers=_auth(token_b))
    assert deleted.status_code == 404

    # Owner still sees the original record untouched.
    records = api_client.get("/api/records", headers=_auth(token_a)).json()["data"]
    assert records[0]["amount"] == "10.00"


def test_record_stats_aggregates_income_and_expense(api_client) -> None:
    token = _register(api_client)
    api_client.post(
        "/api/records",
        json={"type": "income", "category": "工资", "amount": "5000.00"},
        headers=_auth(token),
    )
    api_client.post(
        "/api/records",
        json={"type": "expense", "category": "餐饮", "amount": "100.00"},
        headers=_auth(token),
    )
    api_client.post(
        "/api/records",
        json={"type": "expense", "category": "餐饮", "amount": "50.00"},
        headers=_auth(token),
    )

    stats = api_client.get("/api/records/stats", headers=_auth(token)).json()["data"]

    assert stats["income"] == "5000.00"
    assert stats["expense"] == "150.00"
    assert stats["count"] == 3
    assert stats["categories"] == [{"category": "餐饮", "amount": "150.00"}]
