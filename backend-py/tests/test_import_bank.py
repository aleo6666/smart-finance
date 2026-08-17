"""银行账单 PDF 解析单元测试（模拟 PDF 提取的文本行）。"""

from decimal import Decimal

import pytest

from app.services.importers.bank_statement import (
    BankStatementError,
    normalize_bank,
    parse_bank_statement,
)


def test_normalize_bank_supports_known_banks() -> None:
    for name in ("招商银行", "招商银行信用卡", "工商银行", "建设银行", "支付宝年度账单"):
        assert normalize_bank(name) in {"cmb", "icbc", "ccb", "alipay"}


def test_normalize_bank_rejects_unknown_bank() -> None:
    with pytest.raises(BankStatementError, match="暂不支持该银行账单格式"):
        normalize_bank("某不知名银行")


def test_parse_bank_lines_with_expense_direction() -> None:
    text = "\n".join(
        [
            "招商银行信用卡账单",
            "2026-08-01 超市购物 支出 ¥1,234.56",
            "2026-08-02 滴滴出行 支出 45.00",
        ]
    )

    transactions = parse_bank_statement(text, "招商银行")

    assert len(transactions) == 2
    first, second = transactions
    assert first["date"] == "2026-08-01"
    assert first["amount"] == Decimal("1234.56")
    assert first["type"] == "expense"
    assert first["category"] == "购物"
    assert second["date"] == "2026-08-02"
    assert second["amount"] == Decimal("45.00")
    assert second["type"] == "expense"
    assert second["category"] == "交通"


def test_parse_income_direction() -> None:
    text = "2026年08月17日 工资发放 收入 ¥8,000.00"

    transactions = parse_bank_statement(text, "工商银行")

    assert len(transactions) == 1
    assert transactions[0]["type"] == "income"
    assert transactions[0]["date"] == "2026-08-17"
    assert transactions[0]["amount"] == Decimal("8000.00")
    assert transactions[0]["category"] == "工资"


def test_parse_short_date_uses_year_context() -> None:
    text = "\n".join(
        [
            "2026-08-01 麦当劳 支出 45.00",
            "08/02 星巴克咖啡 支出 36.50",
        ]
    )

    transactions = parse_bank_statement(text, "建设银行")

    assert transactions[1]["date"] == "2026-08-02"
    assert transactions[1]["amount"] == Decimal("36.50")


def test_parse_unrecognizable_text_raises() -> None:
    text = "这是一段没有任何交易记录的文本"

    with pytest.raises(BankStatementError, match="暂不支持该银行账单格式"):
        parse_bank_statement(text, "招商银行")
