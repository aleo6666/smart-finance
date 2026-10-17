"""Category grouping for financial metrics and transaction queries.

Production ledgers use detailed Chinese categories (早餐/午餐/超市采购/水电燃气/
物业费/话费), while older imports use broad English categories (food/housing).
Exact-match sets silently under-count both metrics and filtered queries, so all
category decisions go through these aliases.
"""

from __future__ import annotations

FOOD_CATEGORY_ALIASES = (
    "food",
    "食品",
    "餐饮",
    "早餐",
    "午餐",
    "晚餐",
    "夜宵",
    "咖啡",
    "奶茶",
    "外卖",
    "聚餐",
    "超市",
    "超市采购",
    "买菜",
    "生鲜",
    "水果",
    "零食",
    "食堂",
    "餐厅",
    "烘焙",
    "酒水",
)

FIXED_EXPENSE_CATEGORY_ALIASES = (
    "housing",
    "rent",
    "mortgage",
    "utilities",
    "utility",
    "insurance",
    "property",
    "房租",
    "租金",
    "住房",
    "房贷",
    "水电",
    "水电费",
    "水电燃气",
    "水费",
    "电费",
    "燃气",
    "物业",
    "物业费",
    "话费",
    "手机费",
    "宽带",
    "宽带费",
    "网费",
    "保险",
    "固定支出",
)


def normalize_category(category: object) -> str:
    return str(category or "").strip().lower()


def _matches(category: object, aliases: tuple[str, ...]) -> bool:
    normalized = normalize_category(category)
    if not normalized:
        return False
    return any(alias in normalized for alias in aliases)


def is_food_category(category: object) -> bool:
    return _matches(category, FOOD_CATEGORY_ALIASES)


def is_fixed_expense_category(category: object) -> bool:
    return _matches(category, FIXED_EXPENSE_CATEGORY_ALIASES)


def expand_category(category: str) -> tuple[str, ...]:
    """Return the category values a user-facing group name should match.

    A known group (e.g. ``餐饮``) expands to every alias; an unknown category
    stays exact so existing custom categories keep working.
    """
    if is_food_category(category):
        return FOOD_CATEGORY_ALIASES
    if is_fixed_expense_category(category):
        return FIXED_EXPENSE_CATEGORY_ALIASES
    return (category,)
