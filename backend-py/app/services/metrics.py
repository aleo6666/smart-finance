from collections.abc import Mapping
from decimal import Decimal
from typing import TypeAlias


MetricInput: TypeAlias = Decimal | int | None
AggregateInput: TypeAlias = MetricInput | Mapping[str, MetricInput]

ZERO = Decimal("0")

KNOWLEDGE = {
    "savings_rate": "收入中扣除全部支出后可储蓄的比例。",
    "debt_ratio": "总负债占总资产的比例，用于衡量偿债压力。",
    "liquidity_ratio": "数值 3 表示应急金可覆盖 3 个月支出。",
    "debt_to_income": "每月还款额占月收入的比例。",
    "investment_ratio": "投资类资产占总资产的比例。",
    "engel_coefficient": "食品支出占总支出的比例。",
    "free_savings_rate": "收入扣除固定支出后可自由安排的比例。",
    "net_worth": "总资产扣除总负债后的余额。",
}

METRIC_METADATA = {
    "savings_rate": ("储蓄率", "%"),
    "debt_ratio": ("负债率", "%"),
    "liquidity_ratio": ("流动性比率", "月"),
    "debt_to_income": ("负债收入比", "%"),
    "investment_ratio": ("投资资产比率", "%"),
    "engel_coefficient": ("恩格尔系数", "%"),
    "free_savings_rate": ("自由储蓄率", "%"),
    "net_worth": ("净资产", ""),
}


def _decimal(value: MetricInput) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return Decimal(value)
    return None


def _nonnegative(*values: MetricInput) -> tuple[Decimal, ...] | None:
    converted = tuple(_decimal(value) for value in values)
    if any(value is None or value < ZERO for value in converted):
        return None
    return tuple(value for value in converted if value is not None)


def _ratio(numerator: MetricInput, denominator: MetricInput) -> Decimal | None:
    values = _nonnegative(numerator, denominator)
    if values is None:
        return None
    converted_numerator, converted_denominator = values
    if converted_denominator == ZERO:
        return None
    return converted_numerator / converted_denominator


def compute_savings_rate(
    income: MetricInput, expenses: MetricInput
) -> Decimal | None:
    values = _nonnegative(income, expenses)
    if values is None:
        return None
    converted_income, converted_expenses = values
    if converted_income == ZERO:
        return None
    return (converted_income - converted_expenses) / converted_income


def compute_debt_ratio(
    total_liabilities: MetricInput, total_assets: MetricInput
) -> Decimal | None:
    return _ratio(total_liabilities, total_assets)


def compute_liquidity_ratio(
    liquid_assets: MetricInput, monthly_expenses: MetricInput
) -> Decimal | None:
    return _ratio(liquid_assets, monthly_expenses)


def compute_debt_to_income(
    monthly_payment: MetricInput, monthly_income: MetricInput
) -> Decimal | None:
    return _ratio(monthly_payment, monthly_income)


def compute_investment_ratio(
    investment_assets: MetricInput, total_assets: MetricInput
) -> Decimal | None:
    return _ratio(investment_assets, total_assets)


def compute_engel_coefficient(
    food_expenses: MetricInput, total_expenses: MetricInput
) -> Decimal | None:
    return _ratio(food_expenses, total_expenses)


def compute_free_savings_rate(
    income: MetricInput, fixed_expenses: MetricInput
) -> Decimal | None:
    values = _nonnegative(income, fixed_expenses)
    if values is None:
        return None
    converted_income, converted_fixed_expenses = values
    if converted_income == ZERO:
        return None
    return (converted_income - converted_fixed_expenses) / converted_income


def compute_net_worth(
    total_assets: MetricInput, total_liabilities: MetricInput
) -> Decimal | None:
    values = _nonnegative(total_assets, total_liabilities)
    if values is None:
        return None
    converted_assets, converted_liabilities = values
    return converted_assets - converted_liabilities


def _aggregate_value(data: AggregateInput, key: str) -> Decimal | None:
    if isinstance(data, Mapping):
        return _decimal(data.get(key))
    if key == "total":
        return _decimal(data)
    return None


def _metric(key: str, value: Decimal | None) -> dict[str, Decimal | str | None]:
    label, unit = METRIC_METADATA[key]
    return {"value": value, "label": label, "unit": unit}


def compute_metrics(
    income: AggregateInput,
    expenses: AggregateInput,
    fixed_expenses: AggregateInput,
    assets: AggregateInput,
    liabilities: AggregateInput,
) -> dict[str, dict[str, Decimal | str | None]]:
    """Compute all metrics with Decimal values; percentage values are unscaled ratios."""
    total_income = _aggregate_value(income, "total")
    monthly_income = (
        _aggregate_value(income, "monthly")
        if isinstance(income, Mapping)
        else total_income
    )
    total_expenses = _aggregate_value(expenses, "total")
    monthly_expenses = _aggregate_value(expenses, "monthly")
    food_expenses = _aggregate_value(expenses, "food")
    total_assets = _aggregate_value(assets, "total")
    liquid_assets = _aggregate_value(assets, "liquid")
    investment_assets = _aggregate_value(assets, "investment")
    total_liabilities = _aggregate_value(liabilities, "total")
    monthly_payment = _aggregate_value(liabilities, "monthly_payment")

    return {
        "savings_rate": _metric(
            "savings_rate", compute_savings_rate(total_income, total_expenses)
        ),
        "debt_ratio": _metric(
            "debt_ratio", compute_debt_ratio(total_liabilities, total_assets)
        ),
        "liquidity_ratio": _metric(
            "liquidity_ratio",
            compute_liquidity_ratio(liquid_assets, monthly_expenses),
        ),
        "debt_to_income": _metric(
            "debt_to_income",
            compute_debt_to_income(monthly_payment, monthly_income),
        ),
        "investment_ratio": _metric(
            "investment_ratio",
            compute_investment_ratio(investment_assets, total_assets),
        ),
        "engel_coefficient": _metric(
            "engel_coefficient",
            compute_engel_coefficient(food_expenses, total_expenses),
        ),
        "free_savings_rate": _metric(
            "free_savings_rate",
            compute_free_savings_rate(total_income, _aggregate_value(fixed_expenses, "total")),
        ),
        "net_worth": _metric(
            "net_worth", compute_net_worth(total_assets, total_liabilities)
        ),
    }
