"""银行账单 PDF 解析（规则优先，不依赖 LLM）。

- 文本层提取：pypdf（懒加载，避免无依赖环境启动失败）
- 按行解析 日期 / 摘要 / 金额 / 收支方向
- 支持：招商银行、工商银行、建设银行、支付宝年度账单（PDF 版）

解析只产出交易建议，绝不直接入库——由上层 preview → confirm 两段式驱动。
"""

from __future__ import annotations

import io
import re
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from app.services.importers.categories import classify

MONEY = Decimal("0.01")
MAX_AMOUNT = Decimal("100000000")
DEFAULT_YEAR = date.today().year

# 支持的银行账单（宽松匹配：名称包含关键词即视为支持）
SUPPORTED_BANKS: tuple[tuple[str, str], ...] = (
    ("招商银行", "cmb"),
    ("工商银行", "icbc"),
    ("建设银行", "ccb"),
    ("支付宝", "alipay"),
)

EXPENSE_KEYWORDS: tuple[str, ...] = ("支出", "借方", "付款", "消费", "扣款")
INCOME_KEYWORDS: tuple[str, ...] = ("收入", "贷方", "存入", "收款", "转入", "入账")

# 日期：2026-08-17 / 2026/08/17 / 2026.08.17 / 2026年08月17日；短日期 MM/DD 用年份上下文补全
_DATE_RE = re.compile(
    r"(?P<year>\d{4})[年/\-\.](?P<month>\d{1,2})[月/\-\.](?P<day>\d{1,2})日?"
)
_SHORT_DATE_RE = re.compile(
    r"(?<!\d)(?P<month>0[1-9]|1[0-2])[/\-](?P<day>0[1-9]|[12]\d|3[01])(?!\d)"
)

# 金额：带货币标记（¥/￥/元）优先，最后回退到行内最后一个数字 token
_CURRENCY_RE = re.compile(
    r"[¥￥]\s*(?P<int>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?P<cents>\d{1,2}))?"
)
_YUAN_RE = re.compile(
    r"(?P<int>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?P<cents>\d{1,2}))?\s*元"
)
_NUMBER_TOKEN_RE = re.compile(
    r"(?<!\d)(?P<int>\d{1,3}(?:,\d{3})+|\d+(?:\.\d{1,2})?)(?!\d)"
)


class BankStatementError(Exception):
    """银行账单解析失败（格式不支持或无可识别交易）。"""


def normalize_bank(bank_name: str) -> str:
    """返回规范化银行标识，未知银行抛 BankStatementError。"""
    name = (bank_name or "").strip()
    if not name:
        raise BankStatementError("暂不支持该银行账单格式")
    for keyword, canonical in SUPPORTED_BANKS:
        if keyword in name:
            return canonical
    raise BankStatementError("暂不支持该银行账单格式")


def _parse_amount(token: str) -> Decimal | None:
    cleaned = token.replace(",", "").strip()
    if not cleaned:
        return None
    try:
        value = Decimal(cleaned)
    except InvalidOperation:
        return None
    if value <= 0 or value > MAX_AMOUNT:
        return None
    return value.quantize(MONEY, rounding=ROUND_HALF_UP)


def _strip(text: str, match: re.Match) -> str:
    return (text[: match.start()] + " " + text[match.end() :]).strip()


def _detect_direction(text: str) -> tuple[str, str | None]:
    for keyword in INCOME_KEYWORDS:
        if keyword in text:
            return "income", keyword
    for keyword in EXPENSE_KEYWORDS:
        if keyword in text:
            return "expense", keyword
    return "expense", None


def _extract_date(text: str, year: int) -> tuple[str, int, str] | None:
    """提取日期，返回 (iso日期, 解析出的年份, 去除日期后的文本)。"""
    match = _DATE_RE.search(text)
    if match:
        try:
            iso = date(
                int(match.group("year")),
                int(match.group("month")),
                int(match.group("day")),
            ).isoformat()
        except ValueError:
            pass
        else:
            return iso, int(match.group("year")), _strip(text, match)
    match = _SHORT_DATE_RE.search(text)
    if match:
        try:
            iso = date(year, int(match.group("month")), int(match.group("day"))).isoformat()
        except ValueError:
            pass
        else:
            return iso, year, _strip(text, match)
    return None


def _extract_amount(text: str) -> tuple[Decimal | None, str]:
    for regex in (_CURRENCY_RE, _YUAN_RE):
        match = regex.search(text)
        if match:
            token = match.group("int") + (
                f".{match.group('cents')}" if match.group("cents") else ""
            )
            value = _parse_amount(token)
            if value is not None:
                return value, _strip(text, match)
    matches = list(_NUMBER_TOKEN_RE.finditer(text))
    if matches:
        match = matches[-1]
        value = _parse_amount(match.group("int"))
        if value is not None:
            return value, _strip(text, match)
    return None, text


def _clean_description(text: str, direction_keyword: str | None) -> str:
    if direction_keyword:
        text = text.replace(direction_keyword, " ")
    text = re.sub(r"[,\s]+", " ", text).strip()
    return text or "未知交易"


def _parse_line(line: str, year: int) -> dict | None:
    line = line.strip()
    if not line:
        return None
    direction, keyword = _detect_direction(line)
    extracted = _extract_date(line, year)
    if extracted is None:
        return None
    iso_date, used_year, remainder = extracted
    amount, remainder = _extract_amount(remainder)
    if amount is None:
        return None
    description = _clean_description(remainder, keyword)
    return {
        "date": iso_date,
        "description": description,
        "amount": amount,
        "type": direction,
        "category": classify(None, None, description, direction),
        "_year": used_year,
    }


def parse_bank_statement(text: str, bank_name: str) -> list[dict]:
    """按行解析账单文本为交易列表；无交易或未知银行抛 BankStatementError。"""
    normalize_bank(bank_name)
    transactions: list[dict] = []
    current_year = DEFAULT_YEAR
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        transaction = _parse_line(line, current_year)
        if transaction is None:
            continue
        current_year = transaction.pop("_year")
        transactions.append(transaction)
    if not transactions:
        raise BankStatementError("未识别到任何交易，暂不支持该银行账单格式")
    return transactions


def extract_pdf_text(data: bytes) -> str:
    """从 PDF 字节提取文本层；解析失败抛 BankStatementError。"""
    if not data:
        raise BankStatementError("PDF 文件为空")
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise BankStatementError("PDF 解析库未安装") from exc
    try:
        reader = PdfReader(io.BytesIO(data))
        pages: list[str] = []
        for page in reader.pages:
            try:
                pages.append(page.extract_text() or "")
            except Exception:
                pages.append("")
        return "\n".join(pages)
    except Exception as exc:
        raise BankStatementError("无法解析该 PDF 文件") from exc
