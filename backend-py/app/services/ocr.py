"""PaddleOCR 票据识别 + 规则化结构化提取.

OCR 只做建议，绝不直接入库——金额/日期/商户/分类均通过规则提取，
由前端确认后再调 ``POST /api/records`` 记账。
"""

from __future__ import annotations

import io
import logging
import re
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

logger = logging.getLogger(__name__)

MONEY = Decimal("0.01")
MAX_AMOUNT = Decimal("100000")

CATEGORY_KEYWORDS: dict[str, tuple[str, ...]] = {
    "餐饮": ("餐", "饭", "咖啡", "奶茶", "茶", "面", "小吃", "烧烤", "火锅",
             "外卖", "餐厅", "饭店", "麦当劳", "肯德基", "星巴克", "瑞幸"),
    "交通": ("滴滴", "出租", "加油", "停车", "地铁", "公交", "高铁", "火车",
             "机票", "航空", "高速", "etc", "石油", "石化"),
    "购物": ("超市", "商场", "便利店", "百货", "淘宝", "京东", "拼多多",
             "购物", "商超", "屈臣氏"),
    "住房": ("房租", "物业", "水电", "燃气", "水费", "电费", "宽带",
             "家居", "维修"),
    "医疗": ("医院", "药", "诊所", "门诊", "体检", "挂号", "牙科", "眼科"),
    "教育": ("书", "培训", "学费", "课程", "文具", "学校", "考试", "报名"),
    "娱乐": ("电影", "ktv", "唱歌", "游戏", "网吧", "演出", "游乐园"),
    "旅行": ("酒店", "民宿", "景点", "旅行社", "旅游"),
    "通讯": ("话费", "流量", "移动", "联通", "电信", "充值"),
    "日用": ("日用品", "洗衣", "洗护", "纸巾", "清洁", "家政"),
}

CURRENCY_AMOUNT_RE = r"[¥￥]\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?"
YUAN_AMOUNT_RE = r"(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*元"
DATE_RE = r"(\d{4})[年/\-\.](\d{1,2})[月/\-\.](\d{1,2})日?"
TOTAL_KEYWORDS = ("合计", "总计", "应付", "实付", "应收", "消费金额", "总金额", "金额")
IGNORED_MERCHANT_KEYWORDS = ("合计", "总计", "小票", "收据", "谢谢", "欢迎", "找零", "实收")

_CURRENCY_AMOUNT = re.compile(CURRENCY_AMOUNT_RE)
_YUAN_AMOUNT = re.compile(YUAN_AMOUNT_RE)
_DATE = re.compile(DATE_RE)


class OcrUnavailable(Exception):
    """PaddleOCR 未安装或推理失败。"""


class OcrEngine:
    """OCR 引擎接口。测试可注入假实现。"""

    def recognize(self, image_bytes: bytes) -> str:
        raise NotImplementedError


class PaddleOcrEngine(OcrEngine):
    """PaddleOCR CPU 推理封装，懒加载避免无依赖环境启动失败。"""

    def __init__(self, lang: str = "ch") -> None:
        self._lang = lang
        self._ocr = None

    def _load(self):
        if self._ocr is None:
            try:
                from paddleocr import PaddleOCR
            except ImportError as exc:
                raise OcrUnavailable("PaddleOCR 未安装，无法识别票据") from exc
            self._ocr = PaddleOCR(
                use_angle_cls=False, lang=self._lang, show_log=False
            )
        return self._ocr

    def recognize(self, image_bytes: bytes) -> str:
        import numpy as np
        from PIL import Image

        ocr = self._load()
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        result = ocr.ocr(np.array(image), cls=False)
        lines: list[str] = []
        for page in result or []:
            for item in page or []:
                text = item[1][0]
                if text:
                    lines.append(str(text).strip())
        return "\n".join(lines)


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


def _first_amount(line: str) -> Decimal | None:
    for match in _CURRENCY_AMOUNT.finditer(line):
        return _parse_amount(
            match.group(1) + (f".{match.group(2)}" if match.group(2) else "")
        )
    for match in _YUAN_AMOUNT.finditer(line):
        return _parse_amount(
            match.group(1) + (f".{match.group(2)}" if match.group(2) else "")
        )
    return None


def extract_amount(text: str) -> Decimal | None:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for line in lines:
        if any(keyword in line for keyword in TOTAL_KEYWORDS):
            candidate = _first_amount(line)
            if candidate is not None:
                return candidate
    candidates = [_first_amount(line) for line in lines]
    candidates = [candidate for candidate in candidates if candidate is not None]
    return max(candidates) if candidates else None


def extract_date(text: str) -> str | None:
    for match in _DATE.finditer(text):
        year, month, day = (
            int(match.group(1)),
            int(match.group(2)),
            int(match.group(3)),
        )
        try:
            return date(year, month, day).isoformat()
        except ValueError:
            continue
    return None


def extract_merchant(text: str) -> str | None:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for line in lines:
        if _first_amount(line) is not None:
            continue
        if _DATE.search(line):
            continue
        if any(keyword in line for keyword in IGNORED_MERCHANT_KEYWORDS):
            continue
        if len(line) <= 20:
            return line
    return None


def guess_category(text: str) -> str:
    lowered = text.lower()
    for category, keywords in CATEGORY_KEYWORDS.items():
        for keyword in keywords:
            if keyword in lowered:
                return category
    return "其他"


def extract_receipt_fields(text: str) -> dict:
    """从 OCR 文本规则化提取结构化字段，金额以字符串返回（Decimal 内部计算）。"""
    amount = extract_amount(text)
    return {
        "amount": str(amount) if amount is not None else None,
        "date": extract_date(text),
        "merchant": extract_merchant(text),
        "category_guess": guess_category(text),
    }
