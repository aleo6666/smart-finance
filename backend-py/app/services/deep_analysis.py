from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import date, datetime
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
from typing import Any


ZERO = Decimal("0")
MONEY = Decimal("0.01")
RATE = Decimal("0.0001")
PERCENT = Decimal("0.01")
DISCLAIMER = "以上为通用财务建议，不构成投资建议，不推荐具体产品"
RECURRING_CATEGORIES = {
    "rent",
    "subscription",
    "insurance",
    "房租",
    "订阅",
    "保险",
}

INCOME_BENCHMARKS = (
    (Decimal("5000"), "0-4999", Decimal("0.10"), Decimal("0.20"), Decimal("0.30"), Decimal("0.45")),
    (Decimal("10000"), "5000-9999", Decimal("0.15"), Decimal("0.25"), Decimal("0.25"), Decimal("0.40")),
    (Decimal("20000"), "10000-19999", Decimal("0.20"), Decimal("0.30"), Decimal("0.20"), Decimal("0.35")),
    (None, "20000+", Decimal("0.25"), Decimal("0.40"), Decimal("0.15"), Decimal("0.30")),
)
AGE_DEBT_BENCHMARKS = (
    (30, "under-30", ZERO, Decimal("0.35")),
    (40, "30-39", ZERO, Decimal("0.45")),
    (50, "40-49", ZERO, Decimal("0.40")),
    (60, "50-59", ZERO, Decimal("0.30")),
    (None, "60+", ZERO, Decimal("0.20")),
)


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return Decimal(value)
    if isinstance(value, str):
        return Decimal(value)
    raise TypeError("financial calculations require Decimal-compatible values")


def _money(value: Decimal) -> Decimal:
    return value.quantize(MONEY, rounding=ROUND_HALF_UP)


def _with_disclaimer(message: str) -> str:
    return f"{message}。{DISCLAIMER}"


def _date(value: date | datetime | str) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(value[:10])


def _month_key(value: date | datetime | str) -> str:
    parsed = _date(value)
    return f"{parsed.year:04d}-{parsed.month:02d}"


def _shift_month(value: date, delta: int) -> date:
    month_index = value.year * 12 + value.month - 1 + delta
    return date(month_index // 12, month_index % 12 + 1, 1)


def analyze_budget(
    budgets: Mapping[str, Decimal],
    actual_expenses: Mapping[str, Decimal],
    previous_expenses: Mapping[str, Decimal] | None = None,
    previous_overspend_counts: Mapping[str, int] | None = None,
) -> dict:
    """Compare category budgets with actuals and classify recurring overruns."""
    if not budgets:
        return {
            "overspent_categories": None,
            "category_trends": None,
            "reason": "没有可分析的预算数据",
        }
    previous = previous_expenses or {}
    prior_counts = previous_overspend_counts or {}
    overspent: list[dict] = []
    trends: dict[str, dict] = {}

    for category in sorted(set(budgets) | set(actual_expenses)):
        budget = _decimal(budgets.get(category, ZERO)) or ZERO
        actual = _decimal(actual_expenses.get(category, ZERO)) or ZERO
        prior = _decimal(previous.get(category))
        if prior is None or prior == ZERO:
            trends[category] = {
                "current": _money(actual),
                "previous": _money(prior) if prior is not None else None,
                "change_rate": None,
                "reason": "上月无支出数据，无法计算环比",
            }
        else:
            trends[category] = {
                "current": _money(actual),
                "previous": _money(prior),
                "change_rate": ((actual - prior) / prior).quantize(
                    RATE, rounding=ROUND_HALF_UP
                ),
                "reason": None,
            }

        if actual <= budget:
            continue
        over_by = actual - budget
        persistent = prior_counts.get(category, 0) >= 1
        if persistent:
            advice = (
                f"{category}已连续超支；若为必要支出，可将月预算校准至"
                f" {_money(actual)} 元，否则下月需减少 {_money(over_by)} 元"
            )
        else:
            advice = (
                f"{category}本月偶发超支 {_money(over_by)} 元，"
                "下月设置分类限额并复核大额消费"
            )
        overspent.append(
            {
                "category": category,
                "budget": _money(budget),
                "actual": _money(actual),
                "over_by": _money(over_by),
                "issue_type": "persistent" if persistent else "one_off",
                "consecutive_months": prior_counts.get(category, 0) + 1,
                "advice": _with_disclaimer(advice),
            }
        )

    return {
        "overspent_categories": overspent,
        "category_trends": trends,
        "reason": None,
    }


def forecast_cashflow(
    transactions: Sequence[Mapping[str, Any]],
    as_of: date | None = None,
) -> dict:
    """Forecast three months using a six-calendar-month moving average."""
    anchor = as_of or date.today()
    history_months = [_month_key(_shift_month(anchor, delta)) for delta in range(-5, 1)]
    monthly_expenses = {month: ZERO for month in history_months}
    monthly_income = {month: ZERO for month in history_months}
    recurring_groups: dict[tuple[str, str, Decimal], set[str]] = defaultdict(set)

    for transaction in transactions:
        month = _month_key(transaction["occurred_at"])
        if month not in monthly_expenses:
            continue
        amount = _decimal(transaction.get("amount"))
        if amount is None or amount < ZERO:
            continue
        txn_type = transaction.get("type")
        if txn_type == "income":
            monthly_income[month] += amount
        elif txn_type == "expense":
            monthly_expenses[month] += amount
            category = str(transaction.get("category") or "other")
            if category in RECURRING_CATEGORIES:
                merchant = str(
                    transaction.get("merchant")
                    or transaction.get("note")
                    or category
                )
                recurring_groups[(category, merchant, _money(amount))].add(month)

    if not any(value > ZERO for value in monthly_expenses.values()):
        return {
            "forecast": None,
            "recurring_items": None,
            "reason": "近 6 个月没有支出数据",
        }

    divisor = Decimal("6")
    predicted_expenses = _money(sum(monthly_expenses.values(), ZERO) / divisor)
    predicted_income = _money(sum(monthly_income.values(), ZERO) / divisor)
    forecast = []
    for delta in range(1, 4):
        month = _month_key(_shift_month(anchor, delta))
        gap = _money(predicted_income - predicted_expenses)
        forecast.append(
            {
                "month": month,
                "predicted_income": predicted_income,
                "predicted_expenses": predicted_expenses,
                "gap": gap,
                "warning": predicted_expenses > predicted_income,
            }
        )

    recurring_items = [
        {
            "category": category,
            "merchant": merchant,
            "amount": amount,
            "occurrences": len(months),
            "recurring": True,
        }
        for (category, merchant, amount), months in sorted(
            recurring_groups.items(), key=lambda item: item[0]
        )
        if len(months) >= 2
    ]
    return {
        "forecast": forecast,
        "recurring_items": recurring_items,
        "reason": None,
    }


def detect_anomalies(
    transactions: Sequence[Mapping[str, Any]],
    standard_deviations: Decimal = Decimal("2"),
) -> dict:
    """Detect amount outliers, duplicate charges and day-over-day spikes."""
    deviation_count = _decimal(standard_deviations)
    if deviation_count is None or deviation_count <= ZERO:
        raise ValueError("standard_deviations must be positive")
    expenses = [
        transaction
        for transaction in transactions
        if transaction.get("type") == "expense"
        and (_decimal(transaction.get("amount")) or ZERO) >= ZERO
    ]
    if not expenses:
        return {"anomalies": None, "reason": "所选期间没有支出数据"}

    amounts = [_decimal(item["amount"]) or ZERO for item in expenses]
    count = Decimal(len(amounts))
    mean = sum(amounts, ZERO) / count
    variance = sum(((amount - mean) ** 2 for amount in amounts), ZERO) / count
    standard_deviation = variance.sqrt()
    deviation_threshold = deviation_count * standard_deviation
    threshold = mean + deviation_threshold
    anomalies: list[dict] = []
    for transaction, amount in zip(expenses, amounts, strict=True):
        if abs(amount - mean) > deviation_threshold:
            anomalies.append(
                {
                    "type": "statistical_outlier",
                    "transaction_id": transaction.get("id"),
                    "amount": _money(amount),
                    "threshold": _money(threshold),
                    "mean": _money(mean),
                    "deviation_threshold": _money(deviation_threshold),
                    "occurred_at": _date(transaction["occurred_at"]).isoformat(),
                }
            )

    duplicate_groups: dict[tuple[Decimal, str], list[Mapping[str, Any]]] = defaultdict(list)
    for transaction in expenses:
        merchant = str(
            transaction.get("merchant")
            or transaction.get("note")
            or transaction.get("category")
            or ""
        )
        duplicate_groups[(_decimal(transaction["amount"]) or ZERO, merchant)].append(
            transaction
        )
    for (amount, merchant), group in duplicate_groups.items():
        ordered = sorted(group, key=lambda item: _date(item["occurred_at"]))
        matching_ids: list[Any] = []
        for left, right in zip(ordered, ordered[1:]):
            if (_date(right["occurred_at"]) - _date(left["occurred_at"])).days <= 7:
                matching_ids.extend([left.get("id"), right.get("id")])
        if matching_ids:
            anomalies.append(
                {
                    "type": "duplicate_charge",
                    "merchant": merchant,
                    "amount": _money(amount),
                    "transaction_ids": list(dict.fromkeys(matching_ids)),
                    "window_days": 7,
                }
            )

    daily_totals: dict[date, Decimal] = defaultdict(lambda: ZERO)
    for transaction, amount in zip(expenses, amounts, strict=True):
        daily_totals[_date(transaction["occurred_at"])] += amount
    ordered_days = sorted(daily_totals.items())
    for (prior_day, prior_total), (current_day, current_total) in zip(
        ordered_days, ordered_days[1:]
    ):
        if prior_total > ZERO and current_total > prior_total * Decimal("3"):
            anomalies.append(
                {
                    "type": "spending_spike",
                    "date": current_day.isoformat(),
                    "amount": _money(current_total),
                    "previous_date": prior_day.isoformat(),
                    "previous_amount": _money(prior_total),
                    "multiple": (current_total / prior_total).quantize(
                        RATE, rounding=ROUND_HALF_UP
                    ),
                }
            )
    return {"anomalies": anomalies, "reason": None}


def analyze_goals(
    goals: Sequence[Mapping[str, Any]],
    monthly_income: Decimal | None,
    monthly_expenses: Decimal | None,
    as_of: date | None = None,
    free_savings_rate: Decimal | None = None,
) -> dict:
    """Estimate goal completion using current free monthly cash flow."""
    if not goals:
        return {"goals": None, "monthly_saving_capacity": None, "reason": "没有财务目标数据"}
    income = _decimal(monthly_income)
    expenses = _decimal(monthly_expenses)
    free_rate = _decimal(free_savings_rate)
    if income is None or (expenses is None and free_rate is None):
        return {
            "goals": None,
            "monthly_saving_capacity": None,
            "reason": "缺少收入或支出数据，无法评估目标",
        }
    anchor = as_of or date.today()
    if free_rate is not None:
        capacity = max(income * free_rate, ZERO)
    else:
        assert expenses is not None
        capacity = max(income - expenses, ZERO)
    analyzed = []
    for goal in goals:
        target = _decimal(goal["target_amount"]) or ZERO
        current = _decimal(goal.get("current_amount")) or ZERO
        remaining = max(target - current, ZERO)
        progress = (
            min(current / target * Decimal("100"), Decimal("100"))
            if target > ZERO
            else Decimal("100")
        ).quantize(PERCENT, rounding=ROUND_HALF_UP)
        if remaining == ZERO:
            months_needed: int | None = 0
        elif capacity == ZERO:
            months_needed = None
        else:
            months_needed = int(
                (remaining / capacity).to_integral_value(rounding=ROUND_CEILING)
            )
        target_date = _date(goal["target_date"])
        months_available = max(
            (target_date.year - anchor.year) * 12 + target_date.month - anchor.month,
            0,
        )
        feasible = months_needed is not None and months_needed <= months_available
        analyzed.append(
            {
                "id": goal.get("id"),
                "name": goal.get("name"),
                "target_amount": _money(target),
                "current_amount": _money(current),
                "remaining_amount": _money(remaining),
                "target_date": target_date.isoformat(),
                "progress_percent": progress,
                "months_needed": months_needed,
                "months_available": months_available,
                "feasible": feasible,
                "advice": _with_disclaimer(
                    "按目标日期持续跟踪月度储蓄进度"
                    if feasible
                    else "当前月储蓄能力不足，需调整期限、金额或支出"
                ),
            }
        )
    analyzed.sort(key=lambda item: (item["target_date"], item["feasible"]))
    for priority, goal in enumerate(analyzed, start=1):
        goal["priority"] = priority
    return {
        "goals": analyzed,
        "monthly_saving_capacity": _money(capacity),
        "reason": None,
    }


def _comparison(value: Decimal | None, low: Decimal, high: Decimal) -> dict:
    if value is None:
        return {
            "value": None,
            "benchmark": {"min": low, "max": high},
            "status": None,
            "reason": "缺少用户指标数据",
        }
    if value < low:
        status = "below"
    elif value > high:
        status = "above"
    else:
        status = "within"
    return {
        "value": value,
        "benchmark": {"min": low, "max": high},
        "status": status,
        "reason": None,
    }


def compare_benchmarks(
    monthly_income: Decimal | None,
    age: int | None,
    savings_rate: Decimal | None,
    engel_coefficient: Decimal | None,
    debt_ratio: Decimal | None,
) -> dict:
    """Compare user ratios with static anonymous income/age benchmark bands."""
    income = _decimal(monthly_income)
    if income is None or age is None:
        return {
            "income_band": None,
            "age_band": None,
            "comparisons": None,
            "interpretation": None,
            "reason": "缺少月收入或年龄数据，无法选择匿名基准",
        }
    income_row = next(
        row for row in INCOME_BENCHMARKS if row[0] is None or income < row[0]
    )
    age_row = next(row for row in AGE_DEBT_BENCHMARKS if row[0] is None or age < row[0])
    _, income_band, savings_low, savings_high, engel_low, engel_high = income_row
    _, age_band, debt_low, debt_high = age_row
    comparisons = {
        "savings_rate": _comparison(_decimal(savings_rate), savings_low, savings_high),
        "engel_coefficient": _comparison(
            _decimal(engel_coefficient), engel_low, engel_high
        ),
        "debt_ratio": _comparison(_decimal(debt_ratio), debt_low, debt_high),
    }
    labels = {
        "savings_rate": "储蓄率",
        "engel_coefficient": "恩格尔系数",
        "debt_ratio": "负债率",
    }
    interpretations = []
    for key, comparison in comparisons.items():
        if comparison["status"] is None:
            message = f"{labels[key]}数据缺失，暂不能比较"
        elif comparison["status"] == "within":
            message = f"{labels[key]}处于同类匿名基准区间"
        elif comparison["status"] == "below":
            message = f"{labels[key]}低于同类匿名基准区间"
        else:
            message = f"{labels[key]}高于同类匿名基准区间"
        interpretations.append(_with_disclaimer(message))
    return {
        "income_band": income_band,
        "age_band": age_band,
        "comparisons": comparisons,
        "interpretation": interpretations,
        "reason": None,
    }
