from datetime import date, datetime
from decimal import Decimal

from app.services.deep_analysis import (
    analyze_budget,
    analyze_goals,
    compare_benchmarks,
    detect_anomalies,
    forecast_cashflow,
)


def test_analyze_budget_identifies_persistent_overspending_and_trend() -> None:
    result = analyze_budget(
        budgets={"餐饮": Decimal("1000"), "交通": Decimal("500")},
        actual_expenses={"餐饮": Decimal("1300"), "交通": Decimal("400")},
        previous_expenses={"餐饮": Decimal("1100"), "交通": Decimal("500")},
        previous_overspend_counts={"餐饮": 2},
    )

    assert result["reason"] is None
    assert len(result["overspent_categories"]) == 1
    dining = result["overspent_categories"][0]
    assert dining["category"] == "餐饮"
    assert dining["over_by"] == Decimal("300.00")
    assert dining["issue_type"] == "persistent"
    assert result["category_trends"]["餐饮"]["change_rate"] == Decimal("0.1818")
    assert "不构成投资建议，不推荐具体产品" in dining["advice"]


def test_forecast_cashflow_uses_six_month_average_and_marks_recurring() -> None:
    transactions: list[dict] = []
    for month, total in enumerate((100, 200, 300, 400, 500, 600), start=1):
        transactions.extend(
            [
                {
                    "type": "income",
                    "amount": Decimal("1000"),
                    "category": "salary",
                    "occurred_at": datetime(2026, month, 1),
                },
                {
                    "type": "expense",
                    "amount": Decimal("100"),
                    "category": "rent",
                    "merchant": "房东",
                    "occurred_at": datetime(2026, month, 2),
                },
            ]
        )
        if total > 100:
            transactions.append(
                {
                    "type": "expense",
                    "amount": Decimal(total - 100),
                    "category": "other",
                    "merchant": f"merchant-{month}",
                    "occurred_at": datetime(2026, month, 3),
                }
            )

    result = forecast_cashflow(transactions, as_of=date(2026, 6, 30))

    assert result["reason"] is None
    assert len(result["forecast"]) == 3
    assert result["forecast"][0] == {
        "month": "2026-07",
        "predicted_income": Decimal("1000.00"),
        "predicted_expenses": Decimal("350.00"),
        "gap": Decimal("650.00"),
        "warning": False,
    }
    assert result["recurring_items"] == [
        {
            "category": "rent",
            "merchant": "房东",
            "amount": Decimal("100.00"),
            "occurrences": 6,
            "recurring": True,
        }
    ]


def test_detect_anomalies_finds_outlier_duplicate_and_daily_spike() -> None:
    transactions = [
        {
            "id": index,
            "type": "expense",
            "amount": Decimal(amount),
            "merchant": "同一商户" if index in {1, 2} else f"商户{index}",
            "category": "shopping",
            "occurred_at": datetime(2026, 1, index),
        }
        for index, amount in enumerate((100, 100, 100, 100, 100, 1000), start=1)
    ]

    result = detect_anomalies(transactions, standard_deviations=Decimal("2"))

    anomaly_types = {item["type"] for item in result["anomalies"]}
    assert {"statistical_outlier", "duplicate_charge", "spending_spike"} <= anomaly_types
    outlier = next(
        item for item in result["anomalies"] if item["type"] == "statistical_outlier"
    )
    assert outlier["transaction_id"] == 6
    assert outlier["amount"] == Decimal("1000.00")


def test_detect_anomalies_uses_two_sided_standard_deviation() -> None:
    transactions = [
        {
            "id": index,
            "type": "expense",
            "amount": Decimal(amount),
            "merchant": f"商户{index}",
            "category": "shopping",
            "occurred_at": datetime(2026, 2, index),
        }
        for index, amount in enumerate((0, 1000, 1000, 1000, 1000, 1000), start=1)
    ]

    result = detect_anomalies(transactions, standard_deviations=Decimal("2"))

    outliers = [
        item for item in result["anomalies"] if item["type"] == "statistical_outlier"
    ]
    assert [item["transaction_id"] for item in outliers] == [1]


def test_analyze_goals_calculates_progress_feasibility_and_priority() -> None:
    result = analyze_goals(
        goals=[
            {
                "id": 2,
                "name": "旅行",
                "target_amount": Decimal("12000"),
                "current_amount": Decimal("2000"),
                "target_date": date(2027, 1, 1),
            },
            {
                "id": 1,
                "name": "应急金",
                "target_amount": Decimal("10000"),
                "current_amount": Decimal("4000"),
                "target_date": date(2026, 10, 1),
            },
        ],
        monthly_income=Decimal("10000"),
        monthly_expenses=Decimal("7000"),
        as_of=date(2026, 8, 1),
    )

    assert result["reason"] is None
    assert [goal["id"] for goal in result["goals"]] == [1, 2]
    urgent = result["goals"][0]
    assert urgent["progress_percent"] == Decimal("40.00")
    assert urgent["months_needed"] == 2
    assert urgent["feasible"] is True
    assert urgent["priority"] == 1


def test_analyze_goals_prefers_free_savings_rate_for_capacity() -> None:
    result = analyze_goals(
        goals=[
            {
                "id": 1,
                "name": "长期目标",
                "target_amount": Decimal("12000"),
                "current_amount": Decimal("0"),
                "target_date": date(2027, 8, 1),
            }
        ],
        monthly_income=Decimal("10000"),
        monthly_expenses=Decimal("9000"),
        free_savings_rate=Decimal("0.30"),
        as_of=date(2026, 8, 1),
    )

    assert result["monthly_saving_capacity"] == Decimal("3000.00")
    assert result["goals"][0]["months_needed"] == 4


def test_compare_benchmarks_returns_decimal_ranges_and_interpretation() -> None:
    result = compare_benchmarks(
        monthly_income=Decimal("12000"),
        age=35,
        savings_rate=Decimal("0.18"),
        engel_coefficient=Decimal("0.40"),
        debt_ratio=Decimal("0.55"),
    )

    assert result["reason"] is None
    assert result["income_band"] == "10000-19999"
    assert result["age_band"] == "30-39"
    assert result["comparisons"]["savings_rate"]["status"] == "below"
    assert result["comparisons"]["engel_coefficient"]["status"] == "above"
    assert result["comparisons"]["debt_ratio"]["status"] == "above"
    assert all(
        "不构成投资建议，不推荐具体产品" in message
        for message in result["interpretation"]
    )
