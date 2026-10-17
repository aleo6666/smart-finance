from app.services.category_groups import (
    expand_category,
    is_fixed_expense_category,
    is_food_category,
)


def test_food_category_aliases_cover_production_labels() -> None:
    for category in ("food", "食品", "餐饮", "早餐", "午餐", "晚餐", "超市采购", "奶茶"):
        assert is_food_category(category), category


def test_fixed_expense_aliases_cover_production_labels() -> None:
    for category in (
        "housing",
        "房租",
        "房贷",
        "水电",
        "水电燃气",
        "物业费",
        "话费",
        "宽带",
        "保险",
    ):
        assert is_fixed_expense_category(category), category


def test_unknown_categories_remain_exact() -> None:
    assert not is_food_category("交通")
    assert not is_fixed_expense_category("交通")
    assert expand_category("交通") == ("交通",)


def test_known_groups_expand_to_aliases() -> None:
    food_aliases = expand_category("餐饮")
    fixed_aliases = expand_category("房租")

    assert "food" in food_aliases
    assert "午餐" in food_aliases
    assert "房租" in fixed_aliases
    assert "物业费" in fixed_aliases
