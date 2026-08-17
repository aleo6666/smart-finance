from decimal import Decimal

import pytest

from app.services.metrics import (
    KNOWLEDGE,
    compute_debt_ratio,
    compute_debt_to_income,
    compute_engel_coefficient,
    compute_free_savings_rate,
    compute_investment_ratio,
    compute_liquidity_ratio,
    compute_metrics,
    compute_net_worth,
    compute_savings_rate,
)


def test_compute_savings_rate() -> None:
    assert compute_savings_rate(Decimal("10000"), Decimal("7000")) == Decimal(
        "0.3"
    )


def test_compute_debt_ratio() -> None:
    assert compute_debt_ratio(Decimal("20000"), Decimal("100000")) == Decimal(
        "0.2"
    )


def test_compute_liquidity_ratio() -> None:
    assert compute_liquidity_ratio(Decimal("15000"), Decimal("5000")) == Decimal(
        "3"
    )


def test_compute_debt_to_income() -> None:
    assert compute_debt_to_income(Decimal("2000"), Decimal("10000")) == Decimal(
        "0.2"
    )


def test_compute_investment_ratio() -> None:
    assert compute_investment_ratio(
        Decimal("30000"), Decimal("100000")
    ) == Decimal("0.3")


def test_compute_engel_coefficient() -> None:
    assert compute_engel_coefficient(Decimal("1500"), Decimal("6000")) == Decimal(
        "0.25"
    )


def test_compute_free_savings_rate() -> None:
    assert compute_free_savings_rate(
        Decimal("10000"), Decimal("4000")
    ) == Decimal("0.6")


def test_compute_net_worth_can_be_negative() -> None:
    assert compute_net_worth(Decimal("80000"), Decimal("100000")) == Decimal(
        "-20000"
    )


@pytest.mark.parametrize(
    ("function", "arguments"),
    [
        (compute_savings_rate, (Decimal("0"), Decimal("10"))),
        (compute_debt_ratio, (Decimal("10"), Decimal("0"))),
        (compute_liquidity_ratio, (Decimal("10"), Decimal("0"))),
        (compute_debt_to_income, (Decimal("10"), Decimal("0"))),
        (compute_investment_ratio, (Decimal("10"), Decimal("0"))),
        (compute_engel_coefficient, (Decimal("10"), Decimal("0"))),
        (compute_free_savings_rate, (Decimal("0"), Decimal("10"))),
    ],
)
def test_ratio_denominator_zero_returns_none(function, arguments: tuple) -> None:
    assert function(*arguments) is None


@pytest.mark.parametrize(
    "function",
    [
        compute_savings_rate,
        compute_debt_ratio,
        compute_liquidity_ratio,
        compute_debt_to_income,
        compute_investment_ratio,
        compute_engel_coefficient,
        compute_free_savings_rate,
        compute_net_worth,
    ],
)
def test_negative_or_none_input_returns_none(function) -> None:
    assert function(Decimal("-1"), Decimal("10")) is None
    assert function(Decimal("10"), Decimal("-1")) is None
    assert function(None, Decimal("10")) is None
    assert function(Decimal("10"), None) is None


def test_decimal_addition_has_no_float_error() -> None:
    income = Decimal("0.1") + Decimal("0.2")

    assert income == Decimal("0.3")
    assert compute_savings_rate(income, Decimal("0")) == Decimal("1")


def test_compute_metrics_returns_uniform_metadata() -> None:
    result = compute_metrics(
        income={"total": Decimal("30000"), "monthly": Decimal("10000")},
        expenses={
            "total": Decimal("18000"),
            "monthly": Decimal("6000"),
            "food": Decimal("4500"),
        },
        fixed_expenses=Decimal("12000"),
        assets={
            "total": Decimal("100000"),
            "liquid": Decimal("18000"),
            "investment": Decimal("30000"),
        },
        liabilities={
            "total": Decimal("20000"),
            "monthly_payment": Decimal("2000"),
        },
    )

    assert set(result) == {
        "savings_rate",
        "debt_ratio",
        "liquidity_ratio",
        "debt_to_income",
        "investment_ratio",
        "engel_coefficient",
        "free_savings_rate",
        "net_worth",
    }
    assert result["savings_rate"] == {
        "value": Decimal("0.4"),
        "label": "储蓄率",
        "unit": "%",
    }
    assert result["liquidity_ratio"]["value"] == Decimal("3")
    assert result["debt_to_income"]["value"] == Decimal("0.2")
    assert result["net_worth"]["value"] == Decimal("80000")
    assert all(set(metric) == {"value", "label", "unit"} for metric in result.values())


def test_compute_metrics_accepts_decimal_totals() -> None:
    result = compute_metrics(
        income=Decimal("100"),
        expenses=Decimal("40"),
        fixed_expenses=Decimal("25"),
        assets=Decimal("200"),
        liabilities=Decimal("50"),
    )

    assert result["savings_rate"]["value"] == Decimal("0.6")
    assert result["debt_ratio"]["value"] == Decimal("0.25")
    assert result["net_worth"]["value"] == Decimal("150")
    assert result["liquidity_ratio"]["value"] is None


def test_knowledge_contains_chinese_metric_explanations() -> None:
    assert set(KNOWLEDGE) == {
        "savings_rate",
        "debt_ratio",
        "liquidity_ratio",
        "debt_to_income",
        "investment_ratio",
        "engel_coefficient",
        "free_savings_rate",
        "net_worth",
    }
    assert "应急金可覆盖" in KNOWLEDGE["liquidity_ratio"]
