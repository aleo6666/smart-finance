def _register(client, email="alice@example.com", password="secret123") -> str:
    return client.post(
        "/api/auth/email/register-simple",
        json={"email": email, "password": password},
    ).json()["data"]["token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_create_and_list_total_budget(api_client) -> None:
    token = _register(api_client)

    created = api_client.post(
        "/api/budgets", json={"amount": "1000.00"}, headers=_auth(token)
    )
    assert created.status_code == 200
    budget = created.json()["data"]
    assert budget["category"] is None
    assert budget["amount"] == "1000.00"
    assert budget["period"] == "monthly"
    assert float(budget["spent"]) == 0.0

    listed = api_client.get("/api/budgets", headers=_auth(token)).json()["data"]
    assert [item["id"] for item in listed] == [budget["id"]]


def test_create_category_budget_update_delete(api_client) -> None:
    token = _register(api_client)

    created = api_client.post(
        "/api/budgets",
        json={"category": "餐饮", "amount": "500.00", "period": "yearly"},
        headers=_auth(token),
    ).json()["data"]
    assert created["category"] == "餐饮"
    assert created["period"] == "yearly"

    updated = api_client.put(
        f"/api/budgets/{created['id']}", json={"amount": "600.00"}, headers=_auth(token)
    )
    assert updated.status_code == 200
    assert updated.json()["data"]["amount"] == "600.00"

    deleted = api_client.delete(f"/api/budgets/{created['id']}", headers=_auth(token))
    assert deleted.status_code == 200
    assert api_client.get("/api/budgets", headers=_auth(token)).json()["data"] == []


def test_budget_amount_must_be_positive(api_client) -> None:
    token = _register(api_client)

    zero = api_client.post("/api/budgets", json={"amount": "0"}, headers=_auth(token))
    assert zero.status_code == 400

    negative = api_client.post(
        "/api/budgets", json={"amount": "-10.00"}, headers=_auth(token)
    )
    assert negative.status_code == 400


def test_budget_period_must_be_valid(api_client) -> None:
    token = _register(api_client)

    response = api_client.post(
        "/api/budgets", json={"amount": "100.00", "period": "weekly"}, headers=_auth(token)
    )

    assert response.status_code == 400


def test_cross_user_cannot_touch_others_budget(api_client) -> None:
    token_a = _register(api_client, "alice@example.com")
    token_b = _register(api_client, "bob@example.com")

    budget_id = api_client.post(
        "/api/budgets", json={"amount": "100.00"}, headers=_auth(token_a)
    ).json()["data"]["id"]

    updated = api_client.put(
        f"/api/budgets/{budget_id}", json={"amount": "999.00"}, headers=_auth(token_b)
    )
    assert updated.status_code == 404

    deleted = api_client.delete(f"/api/budgets/{budget_id}", headers=_auth(token_b))
    assert deleted.status_code == 404

    # Owner's budget is untouched.
    budgets = api_client.get("/api/budgets", headers=_auth(token_a)).json()["data"]
    assert budgets[0]["amount"] == "100.00"
