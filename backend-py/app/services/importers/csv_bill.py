"""支付宝 / 微信账单 CSV 导入解析（规则优先，不依赖 LLM）。

- 支付宝表头：交易时间,交易分类,交易对方,商品说明,收/支,金额,支付方式...
- 微信表头：交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态...
- 编码：UTF-8 / GBK 自动检测（BOM 处理）
- 金额：字符串 → Decimal（支付宝 "1,234.56" 千分位）
- 方向：收/支 列决定 income/expense；"不计收支"/"/" 等中性记录跳过
- 分类：外部分类映射 + 关键词猜测，未命中 → "未分类"
"""

from __future__ import annotations

import csv
import io
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from app.services.importers.categories import classify

MONEY = Decimal("0.01")
MAX_AMOUNT = Decimal("100000000")

SUPPORTED_PLATFORMS = {"alipay", "wechat"}

_INCOME_MARKERS = {"收入", "收"}
_EXPENSE_MARKERS = {"支出", "支"}


class CsvBillError(Exception):
    """CSV 账单解析失败。"""


def decode_bytes(data: bytes) -> str:
    """按 UTF-8(BOM) → UTF-8 → GB18030/GBK 顺序探测解码。"""
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            return data.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    raise CsvBillError("无法识别账单文件编码")


def _clean_header(cell: str) -> str:
    # 表头首单元格可能带 UTF-8 BOM（U+FEFF）
    return cell.replace("﻿", "").strip().replace(" ", "")


def _find_header_row(rows: list[list[str]]) -> int | None:
    for index, row in enumerate(rows):
        if any("交易时间" in _clean_header(cell) for cell in row):
            return index
    return None


def _find_col(header: list[str], *names: str) -> int | None:
    for name in names:
        for index, cell in enumerate(header):
            if cell == name:
                return index
    for name in names:
        for index, cell in enumerate(header):
            if cell.startswith(name):
                return index
    return None


def _get(row: list[str], col: int | None) -> str:
    if col is None or col >= len(row):
        return ""
    return (row[col] or "").strip()


def _parse_date(token: str) -> str | None:
    text = (token or "").strip().split(" ")[0].split("T")[0]
    text = text.replace("/", "-").replace(".", "-")
    parts = text.split("-")
    if len(parts) != 3:
        return None
    try:
        return date(int(parts[0]), int(parts[1]), int(parts[2])).isoformat()
    except ValueError:
        return None


def _parse_amount(token: str) -> Decimal | None:
    cleaned = (
        (token or "")
        .strip()
        .replace(",", "")
        .replace("¥", "")
        .replace("￥", "")
        .replace("元", "")
        .strip()
    )
    if not cleaned:
        return None
    try:
        value = Decimal(cleaned)
    except InvalidOperation:
        return None
    if value <= 0 or value > MAX_AMOUNT:
        return None
    return value.quantize(MONEY, rounding=ROUND_HALF_UP)


def _parse_direction(token: str) -> str | None:
    text = (token or "").strip()
    if text in _INCOME_MARKERS:
        return "income"
    if text in _EXPENSE_MARKERS:
        return "expense"
    return None


def parse_csv_bill(text: str, platform: str) -> list[dict]:
    """解析账单 CSV 为交易列表；未知平台/缺表头/无交易抛 CsvBillError。"""
    if platform not in SUPPORTED_PLATFORMS:
        raise CsvBillError("暂不支持该平台账单格式")
    rows = [
        row
        for row in csv.reader(io.StringIO(text))
        if any((cell or "").strip() for cell in row)
    ]
    header_idx = _find_header_row(rows)
    if header_idx is None:
        raise CsvBillError("无法识别账单表头（缺少“交易时间”列）")
    header = [_clean_header(cell) for cell in rows[header_idx]]

    time_col = _find_col(header, "交易时间")
    direction_col = _find_col(header, "收/支", "收支")
    counterparty_col = _find_col(header, "交易对方")
    amount_col = _find_col(header, "金额")
    if time_col is None or direction_col is None or amount_col is None:
        raise CsvBillError("账单缺少必要列（交易时间/收/支/金额）")

    if platform == "alipay":
        item_col = _find_col(header, "商品说明")
        external_col = _find_col(header, "交易分类")
    else:
        item_col = _find_col(header, "商品")
        external_col = _find_col(header, "交易类型")

    transactions: list[dict] = []
    for row in rows[header_idx + 1 :]:
        iso_date = _parse_date(_get(row, time_col))
        if iso_date is None:
            continue
        direction = _parse_direction(_get(row, direction_col))
        if direction is None:
            continue
        amount = _parse_amount(_get(row, amount_col))
        if amount is None:
            continue
        item = _get(row, item_col)
        counterparty = _get(row, counterparty_col)
        external = _get(row, external_col)
        summary = " ".join(part for part in (item, counterparty) if part).strip()
        category = classify(platform, external, summary or external, direction)
        transactions.append(
            {
                "date": iso_date,
                "description": summary or "未知交易",
                "amount": amount,
                "type": direction,
                "category": category,
            }
        )
    if not transactions:
        raise CsvBillError("未解析到任何有效交易，请检查账单文件格式")
    return transactions
