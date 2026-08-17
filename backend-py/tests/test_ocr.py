"""OCR 规则化提取单元测试（不依赖 PaddleOCR 推理）。"""

from app.services.ocr import (
    extract_amount,
    extract_date,
    extract_merchant,
    extract_receipt_fields,
    guess_category,
)


def test_extract_receipt_fields_full_receipt() -> None:
    text = "\n".join(
        [
            "星巴克咖啡",
            "订单号 20260818-001",
            "2026-08-18 14:30",
            "合计 ￥ 45.00",
            "谢谢惠顾",
        ]
    )

    fields = extract_receipt_fields(text)

    assert fields["amount"] == "45.00"
    assert fields["date"] == "2026-08-18"
    assert fields["merchant"] == "星巴克咖啡"
    assert fields["category_guess"] == "餐饮"


def test_extract_amount_prefers_total_keyword_line() -> None:
    text = "餐费 12.00\n饮料 8.50\n合计 20.50 元"

    assert extract_amount(text) is not None
    assert str(extract_amount(text)) == "20.50"


def test_extract_amount_handles_thousands_separator() -> None:
    assert str(extract_amount("消费金额 1,299.50 元")) == "1299.50"


def test_extract_date_rejects_invalid_calendar_date() -> None:
    assert extract_date("日期 2026-02-30") is None
    assert extract_date("日期 2026-13-01") is None


def test_guess_category_defaults_to_other() -> None:
    assert guess_category("未知商户消费记录") == "其他"


def test_guess_category_matches_keyword() -> None:
    assert guess_category("麦当劳外带") == "餐饮"
    assert guess_category("滴滴出行打车") == "交通"


def test_extract_merchant_skips_amount_and_date_lines() -> None:
    text = "\n".join(
        [
            "合计 ￥ 45.00",
            "2026-08-18 14:30",
            "全家便利店",
        ]
    )

    assert extract_merchant(text) == "全家便利店"
