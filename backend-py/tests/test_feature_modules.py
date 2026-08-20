"""Smoke tests for the new feature modules (assets/debts/investments/
subscriptions/tax/insurance/health-score/notifications/family/privacy)
and the extended auth endpoints (refresh/logout/delete-account)."""


def _register(client, email="user@example.com", password="secret123"):
    response = client.post(
        "/api/auth/email/register-simple",
        json={"email": email, "password": password},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


# ---------- auth: refresh / logout / delete-account ----------

def test_auth_refresh_issues_new_token(api_client) -> None:
    data = _register(api_client)
    response = api_client.post(
        "/api/auth/refresh", headers=_auth(data["token"])
    )
    assert response.status_code == 200
    assert response.json()["data"]["token"]


def test_auth_logout_returns_ok(api_client) -> None:
    data = _register(api_client)
    response = api_client.post(
        "/api/auth/logout", headers=_auth(data["token"])
    )
    assert response.status_code == 200
    assert response.json()["success"] is True


def test_delete_account_removes_user(api_client) -> None:
    data = _register(api_client)
    response = api_client.delete(
        "/api/auth/account", headers=_auth(data["token"])
    )
    assert response.status_code == 200
    # token 对应的用户已删除，/me 应返回 401
    me = api_client.get("/api/auth/me", headers=_auth(data["token"]))
    assert me.status_code == 401


# ---------- assets ----------

def test_assets_crud_and_overview(api_client) -> None:
    token = _register(api_client)["token"]
    headers = _auth(token)

    created = api_client.post(
        "/api/assets",
        json={"type": "bank_deposit", "name": "招行活期", "amount": "50000.00"},
        headers=headers,
    )
    assert created.status_code == 200
    asset_id = created.json()["data"]["id"]

    overview = api_client.get("/api/assets/overview", headers=headers).json()
    assert overview["data"]["total_assets"] == "50000.00"
    assert overview["data"]["net_worth"] == "50000.00"

    liability = api_client.post(
        "/api/assets/liabilities",
        json={"type": "credit_card", "name": "信用卡", "amount": "3000.00"},
        headers=headers,
    )
    assert liability.status_code == 200
    overview = api_client.get("/api/assets/overview", headers=headers).json()
    assert overview["data"]["total_liabilities"] == "3000.00"
    assert overview["data"]["net_worth"] == "47000.00"

    updated = api_client.put(
        f"/api/assets/{asset_id}",
        json={"amount": "60000.00"},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["data"]["amount"] == "60000.00"

    deleted = api_client.delete(f"/api/assets/{asset_id}", headers=headers)
    assert deleted.status_code == 200


# ---------- debts ----------

def test_debts_plan_overview(api_client) -> None:
    token = _register(api_client)["token"]
    headers = _auth(token)

    response = api_client.post(
        "/api/debts",
        json={
            "type": "mortgage",
            "name": "房贷",
            "amount": "1200000.00",
            "interest_rate": "0.045",
            "monthly_payment": "8000.00",
        },
        headers=headers,
    )
    assert response.status_code == 200
    plan = response.json()["data"]
    assert plan["payoff_months"] is not None
    assert plan["monthly_interest"]

    overview = api_client.get("/api/debts/overview", headers=headers).json()
    assert overview["data"]["total_debt"] == "1200000.00"
    assert overview["data"]["total_monthly_payment"] == "8000.00"
    assert len(overview["data"]["repayment_plan"]) == 1


# ---------- investments ----------

def test_investments_crud_and_overview(api_client) -> None:
    token = _register(api_client)["token"]
    headers = _auth(token)

    created = api_client.post(
        "/api/investments",
        json={
            "name": "沪深300ETF",
            "symbol": "510300",
            "type": "fund",
            "quantity": "1000",
            "cost_price": "4.0000",
            "current_price": "4.5000",
        },
        headers=headers,
    )
    assert created.status_code == 200
    item = created.json()["data"]
    assert item["cost_value"] == "4000.00"
    assert item["current_value"] == "4500.00"
    assert item["profit"] == "500.00"

    overview = api_client.get("/api/investments/overview", headers=headers).json()
    assert overview["data"]["total_cost"] == "4000.00"
    assert overview["data"]["total_profit"] == "500.00"

    deleted = api_client.delete(f"/api/investments/{item['id']}", headers=headers)
    assert deleted.status_code == 200


# ---------- subscriptions ----------

def test_subscriptions_crud_and_overview(api_client) -> None:
    token = _register(api_client)["token"]
    headers = _auth(token)

    created = api_client.post(
        "/api/subscriptions",
        json={
            "name": "视频会员",
            "category": "娱乐",
            "amount": "25.00",
            "billing_cycle": "monthly",
            "next_billing_date": "2026-08-25",
        },
        headers=headers,
    )
    assert created.status_code == 200

    overview = api_client.get("/api/subscriptions/overview", headers=headers).json()
    assert overview["data"]["monthly_equivalent"] == "25.00"
    assert overview["data"]["yearly_equivalent"] == "300.00"

    upcoming = api_client.get("/api/subscriptions/upcoming", headers=headers).json()
    assert len(upcoming["data"]) == 1

    deleted = api_client.delete(
        f"/api/subscriptions/{created.json()['data']['id']}", headers=headers
    )
    assert deleted.status_code == 200


# ---------- tax ----------

def test_tax_calculate_and_records(api_client) -> None:
    token = _register(api_client)["token"]
    headers = _auth(token)

    response = api_client.post(
        "/api/tax/calculate",
        json={
            "year": 2026,
            "month": 8,
            "income": "20000.00",
            "bonus": "30000.00",
            "social_insurance": "2000.00",
            "special_deduction": "1000.00",
        },
        headers=headers,
    )
    assert response.status_code == 200
    data = response.json()["data"]
    # 应税所得 = 20000 - 5000 - 2000 - 1000 = 12000 → 税率 10%，扣除 210
    assert data["taxable_income"] == "12000.00"
    assert data["monthly_tax"] == "990.00"
    # 年终奖 30000/12=2500 → 3% 档 → 900
    assert data["bonus_tax"] == "900.00"

    records = api_client.get("/api/tax/records", headers=headers).json()
    assert len(records["data"]) == 1


# ---------- insurance ----------

def test_insurance_crud_and_overview(api_client) -> None:
    token = _register(api_client)["token"]
    headers = _auth(token)

    created = api_client.post(
        "/api/insurance",
        json={
            "name": "百万医疗险",
            "type": "医疗",
            "company": "示例保险",
            "insured_amount": "2000000.00",
            "annual_premium": "400.00",
            "end_date": "2026-09-01",
        },
        headers=headers,
    )
    assert created.status_code == 200

    overview = api_client.get("/api/insurance/overview", headers=headers).json()
    assert overview["data"]["total_insured"] == "2000000.00"
    assert overview["data"]["total_annual_premium"] == "400.00"
    assert len(overview["data"]["expiring_soon"]) == 1

    deleted = api_client.delete(
        f"/api/insurance/{created.json()['data']['id']}", headers=headers
    )
    assert deleted.status_code == 200


# ---------- health score ----------

def test_health_score_returns_dimensions(api_client) -> None:
    token = _register(api_client)["token"]
    response = api_client.get("/api/health-score", headers=_auth(token))
    assert response.status_code == 200
    analysis = response.json()["data"]["analysis"]
    assert len(analysis["dimensions"]) == 7
    assert isinstance(analysis["total_score"], str)


# ---------- notifications + legacy reminders ----------

def test_notifications_and_legacy_reminders(api_client) -> None:
    token = _register(api_client)["token"]
    headers = _auth(token)

    count = api_client.get("/api/notifications/count", headers=headers).json()
    assert count["data"]["count"] == 0

    # 兼容路径
    legacy = api_client.get("/api/reminders/count", headers=headers)
    assert legacy.status_code == 200
    assert legacy.json()["data"]["count"] == 0
    highlights = api_client.get("/api/reminders/highlights", headers=headers)
    assert highlights.status_code == 200

    read_all = api_client.put("/api/reminders/read-all", headers=headers)
    assert read_all.status_code == 200


# ---------- family ----------

def test_family_create_invite_join_and_share(api_client) -> None:
    owner = _register(api_client, email="owner@example.com")["token"]
    member = _register(api_client, email="member@example.com")["token"]

    created = api_client.post(
        "/api/family/teams", json={"name": "我的家庭"}, headers=_auth(owner)
    )
    assert created.status_code == 200
    team_id = created.json()["data"]["id"]
    invite_code = created.json()["data"]["invite_code"]

    added = api_client.post(
        f"/api/family/teams/{team_id}/members",
        json={"email": "member@example.com"},
        headers=_auth(owner),
    )
    assert added.status_code == 200

    # member 视角确认加入
    teams = api_client.get("/api/family/teams", headers=_auth(member)).json()
    assert any(t["id"] == team_id for t in teams["data"])

    detail = api_client.get(
        f"/api/family/teams/{team_id}", headers=_auth(member)
    ).json()
    assert len(detail["data"]["members"]) == 2

    # owner 共享默认账本给家庭
    me = api_client.get("/api/auth/me", headers=_auth(owner)).json()
    ledger_id = me["data"]["ledgers"][0]["id"]
    share = api_client.post(
        "/api/family/ledgers",
        json={"team_id": team_id, "ledger_id": ledger_id},
        headers=_auth(owner),
    )
    assert share.status_code == 200

    # member 可见共享账本
    shared = api_client.get("/api/family/ledgers", headers=_auth(member)).json()
    assert len(shared["data"]) == 1
    assert shared["data"][0]["ledger_id"] == ledger_id

    # member 可读共享账本交易（空列表）
    records = api_client.get(
        f"/api/family/ledgers/{ledger_id}/records", headers=_auth(member)
    )
    assert records.status_code == 200

    # owner 解散
    disband = api_client.delete(
        f"/api/family/teams/{team_id}", headers=_auth(owner)
    )
    assert disband.status_code == 200


def test_family_join_by_invite_code(api_client) -> None:
    owner = _register(api_client, email="owner2@example.com")["token"]
    joiner = _register(api_client, email="joiner@example.com")["token"]

    created = api_client.post(
        "/api/family/teams", json={"name": "家庭B"}, headers=_auth(owner)
    ).json()["data"]
    code = created["invite_code"]

    joined = api_client.post(
        "/api/family/teams/join",
        json={"invite_code": code},
        headers=_auth(joiner),
    )
    assert joined.status_code == 200
    assert joined.json()["data"]["role"] == "member"


# ---------- privacy ----------

def test_privacy_consents_and_data_export(api_client) -> None:
    token = _register(api_client)["token"]
    headers = _auth(token)

    consent = api_client.post(
        "/api/privacy/consents",
        json={"consent_type": "privacy_policy", "version": "v1", "granted": True},
        headers=headers,
    )
    assert consent.status_code == 200
    assert consent.json()["data"]["granted"] is True

    export = api_client.get("/api/privacy/data", headers=headers).json()
    assert export["data"]["user"]["email"] == "user@example.com"
    assert export["data"]["statistics"]["transaction_count"] == 0
