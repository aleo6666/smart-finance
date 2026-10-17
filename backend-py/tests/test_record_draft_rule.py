"""规则记账提取器单测：常见语句零 LLM 直通，歧义/多笔降级。"""
from decimal import Decimal

import pytest

from app.agents.nodes.record_draft import rule_extract_record


class TestRuleExtractRecord:
    def test_lunch_25(self):
        d = rule_extract_record("今天午餐花了25元")
        assert d is not None
        assert d["type"] == "expense"
        assert d["category"] == "餐饮"
        assert d["amount"] == Decimal("25.00")
        assert d["occurred_at"]  # 今天 → 有日期

    def test_metro_3_no_unit(self):
        d = rule_extract_record("地铁3块")
        assert d is not None
        assert d["category"] == "交通"
        assert d["amount"] == Decimal("3.00")
        assert d["occurred_at"] == ""  # 无日期词

    def test_breakfast_8_no_unit(self):
        d = rule_extract_record("早餐8")
        assert d is not None
        assert d["category"] == "餐饮"
        assert d["amount"] == Decimal("8.00")

    def test_salary_income(self):
        d = rule_extract_record("工资到账8000")
        assert d is not None
        assert d["type"] == "income"
        assert d["amount"] == Decimal("8000.00")

    def test_rent(self):
        d = rule_extract_record("交房租2000元")
        assert d is not None
        assert d["category"] == "居住"
        assert d["amount"] == Decimal("2000.00")

    def test_taxi(self):
        d = rule_extract_record("打车30元")
        assert d is not None
        assert d["category"] == "交通"
        assert d["amount"] == Decimal("30.00")

    def test_yesterday(self):
        d = rule_extract_record("昨天晚餐吃了45元")
        assert d is not None
        assert d["category"] == "餐饮"
        assert d["amount"] == Decimal("45.00")
        assert d["occurred_at"]  # 昨天 → 有日期

    def test_note_cleaned(self):
        d = rule_extract_record("午餐25元")
        assert d is not None
        assert d["note"] == "午餐"

    def test_multi_amount_falls_back(self):
        # 多金额（多笔拆分）→ 降级 LLM
        assert rule_extract_record("午餐25元打车30元") is None

    def test_no_amount_falls_back(self):
        assert rule_extract_record("今天午餐花了钱") is None

    def test_zero_amount_falls_back(self):
        assert rule_extract_record("花了0元") is None

    def test_unknown_category_with_note(self):
        # 类别未命中但 note 有实质内容 → 归"其他"（可接受）
        d = rule_extract_record("给猫买罐头45元")
        assert d is not None
        assert d["category"] == "其他"
        assert d["amount"] == Decimal("45.00")

    def test_empty_text(self):
        assert rule_extract_record("") is None
        assert rule_extract_record("   ") is None

    def test_per_person_total(self):
        # 「人均 80，两个人」= 总支出 160（不是 80）
        d = rule_extract_record("昨天和朋友吃饭人均80，两个人")
        assert d is not None
        assert d["amount"] == Decimal("160.00")
        assert d["category"] == "餐饮"

    def test_aa_split_my_share(self):
        # 「AA，我付了 240，三个人」= 我的份额 80（不是 240）
        d = rule_extract_record("AA 制，我付了 240，三个人")
        assert d is not None
        assert d["amount"] == Decimal("80.00")

    def test_company_reimbursement_is_expense(self):
        # 「公司报销打车费」是员工先垫付，type=expense，不是 income
        d = rule_extract_record("公司报销打车费120")
        assert d is not None
        assert d["type"] == "expense"
        assert d["category"] == "交通"
        assert d["amount"] == Decimal("120.00")

    def test_date_is_not_treated_as_amount(self):
        d = rule_extract_record("2026年8月午餐25元")
        assert d is not None
        assert d["amount"] == Decimal("25.00")
