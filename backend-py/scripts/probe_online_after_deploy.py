"""Production read-only probe for the 2026-10-17 P0/P1 fixes.

Usage:
    SMART_FINANCE_BASE=https://lisheng666.xyz \
    SMART_FINANCE_EMAIL=... SMART_FINANCE_PASSWORD=... \
    .venv/Scripts/python.exe scripts/probe_online_after_deploy.py

The script never writes ledger data. The one chat request writes conversation
history (same documented side effect as the earlier online verification).
"""

from __future__ import annotations

import json
import os
import sys

import httpx

BASE = os.environ.get("SMART_FINANCE_BASE", "https://lisheng666.xyz").rstrip("/")
EMAIL = os.environ.get("SMART_FINANCE_EMAIL", "")
PASSWORD = os.environ.get("SMART_FINANCE_PASSWORD", "")

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str) -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")


def get(client: httpx.Client, path: str, *, headers: dict[str, str] | None = None):
    return client.get(f"{BASE}{path}", headers=headers or {})


def main() -> int:
    if not EMAIL or not PASSWORD:
        print("Set SMART_FINANCE_EMAIL and SMART_FINANCE_PASSWORD first.", file=sys.stderr)
        return 2

    with httpx.Client(timeout=40, follow_redirects=True) as client:
        health = get(client, "/api/health")
        record("health", health.status_code == 200, f"HTTP {health.status_code}")

        ready = get(client, "/api/health/ready")
        ready_body = ready.json() if ready.status_code == 200 else {}
        record(
            "health/ready",
            ready.status_code == 200 and ready_body.get("status") == "ready",
            f"HTTP {ready.status_code} status={ready_body.get('status')}",
        )

        unauth_paths = [
            "/api/financial/overview?user_id=999999",
            "/api/financial/metrics?user_id=999999",
            "/api/analysis/all?user_id=999999",
            "/api/knowledge/documents?user_id=999999",
            "/api/reports?user_id=999999",
            "/api/records?limit=1",
        ]
        for path in unauth_paths:
            response = get(client, path)
            record(
                f"anonymous {path.split('?')[0]}",
                response.status_code == 401,
                f"HTTP {response.status_code} (expected 401)",
            )

        login = client.post(
            f"{BASE}/api/auth/email/login",
            json={"email": EMAIL, "password": PASSWORD},
        )
        login_body = login.json() if login.status_code == 200 else {}
        token = login_body.get("data", {}).get("token")
        user_id = login_body.get("data", {}).get("userId")
        record(
            "login",
            login.status_code == 200 and bool(token) and isinstance(user_id, int),
            f"HTTP {login.status_code} userId={user_id}",
        )
        if not token or not user_id:
            print(json.dumps([r for r in results if not r[1]], ensure_ascii=False))
            return 1

        auth = {"Authorization": f"Bearer {token}"}

        me = get(client, "/api/auth/me", headers=auth)
        record("authenticated /api/auth/me", me.status_code == 200, f"HTTP {me.status_code}")

        own = get(client, "/api/financial/overview", headers=auth)
        foreign = get(
            client, "/api/financial/overview?user_id=999999", headers=auth
        )
        own_body = own.json() if own.status_code == 200 else {}
        foreign_body = foreign.json() if foreign.status_code == 200 else {}
        record(
            "financial/overview token identity",
            own.status_code == 200
            and own_body.get("user_id") == user_id
            and foreign.status_code == 200
            and foreign_body.get("user_id") == user_id,
            f"own={own_body.get('user_id')} foreign={foreign_body.get('user_id')} token={user_id}",
        )

        metrics = get(
            client, "/api/financial/metrics?user_id=999999", headers=auth
        )
        metrics_body = metrics.json() if metrics.status_code == 200 else {}
        record(
            "financial/metrics token identity",
            metrics.status_code == 200 and metrics_body.get("user_id") == user_id,
            f"HTTP {metrics.status_code} user_id={metrics_body.get('user_id')}",
        )

        chat = client.post(
            f"{BASE}/api/chat",
            headers=auth,
            json={"message": "2026年8月餐饮支出是多少？"},
        )
        chat_body = chat.json() if chat.status_code == 200 else {}
        data = chat_body.get("data", {})
        answer = str(data.get("message", ""))
        intent = data.get("intent")
        sources = data.get("sources") or []
        record(
            "date query is not a record",
            chat.status_code == 200
            and intent in {"query", "analysis"}
            and "没听懂金额" not in answer,
            f"HTTP {chat.status_code} intent={intent}",
        )
        record(
            "query returns sources",
            chat.status_code == 200 and bool(sources),
            f"sources={len(sources)}",
        )

    failed = [item for item in results if not item[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
