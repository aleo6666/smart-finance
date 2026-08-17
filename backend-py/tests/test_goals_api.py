def _register(client, email="alice@example.com", password="secret123") -> str:
    return client.post(
        "/api/auth/email/register-simple",
        json={"email": email, "password": password},
    ).json()["data"]["token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_create_and_list_goal(api_client) -> None:
    token = _register(api_client)

    created = api_client.post(
        "/api/goals",
        json={"name": "买房", "target_amount": "100000.00"},
        headers=_auth(token),
    )
    assert created.status_code == 200
    goal = created.json()["data"]
    assert goal["name"] == "买房"
    assert goal["target_amount"] == "100000.00"
    assert goal["current_amount"] == "0.00"
    assert goal["completed"] == 0
    assert goal["deadline"] == goal["target_date"]
    assert goal["target_date"] is not None

    listed = api_client.get("/api/goals", headers=_auth(token)).json()["data"]
    assert [item["id"] for item in listed] == [goal["id"]]


def test_goal_accepts_legacy_deadline_field(api_client) -> None:
    token = _register(api_client)

    created = api_client.post(
        "/api/goals",
        json={"name": "旅行", "target_amount": "5000.00", "deadline": "2026-12-31"},
        headers=_auth(token),
    ).json()["data"]

    assert created["target_date"] == "2026-12-31"
    assert created["deadline"] == "2026-12-31"


def test_update_goal_amounts_and_completed(api_client) -> None:
    token = _register(api_client)
    goal_id = api_client.post(
        "/api/goals", json={"name": "存钱", "target_amount": "1000.00"}, headers=_auth(token)
    ).json()["data"]["id"]

    updated = api_client.put(
        f"/api/goals/{goal_id}", json={"current_amount": "500.00"}, headers=_auth(token)
    ).json()["data"]
    assert updated["current_amount"] == "500.00"
    assert updated["completed"] == 0

    completed = api_client.put(
        f"/api/goals/{goal_id}", json={"completed": 1}, headers=_auth(token)
    ).json()["data"]
    assert completed["completed"] == 1
    assert completed["current_amount"] == completed["target_amount"]

    deleted = api_client.delete(f"/api/goals/{goal_id}", headers=_auth(token))
    assert deleted.status_code == 200
    assert api_client.get("/api/goals", headers=_auth(token)).json()["data"] == []


def test_cross_user_cannot_touch_others_goal(api_client) -> None:
    token_a = _register(api_client, "alice@example.com")
    token_b = _register(api_client, "bob@example.com")

    goal_id = api_client.post(
        "/api/goals", json={"name": "存钱", "target_amount": "100.00"}, headers=_auth(token_a)
    ).json()["data"]["id"]

    updated = api_client.put(
        f"/api/goals/{goal_id}", json={"name": "hacked"}, headers=_auth(token_b)
    )
    assert updated.status_code == 404

    deleted = api_client.delete(f"/api/goals/{goal_id}", headers=_auth(token_b))
    assert deleted.status_code == 404

    # Owner's goal is untouched.
    goals = api_client.get("/api/goals", headers=_auth(token_a)).json()["data"]
    assert goals[0]["name"] == "存钱"


def test_goal_budgets_endpoints(api_client) -> None:
    token = _register(api_client)

    set_budget = api_client.post(
        "/api/goals/budgets",
        json={"category": "餐饮", "amount": "300.00"},
        headers=_auth(token),
    )
    assert set_budget.status_code == 200
    assert set_budget.json()["data"]["category"] == "餐饮"

    budgets = api_client.get("/api/goals/budgets", headers=_auth(token)).json()["data"]
    assert [item["category"] for item in budgets] == ["餐饮"]
