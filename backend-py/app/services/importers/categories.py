"""导入共享的分类映射规则（规则优先，不依赖 LLM）。

内部分类与 T5B OCR 的 ``guess_category`` 保持一致；导入未命中时默认
返回 "未分类"（区别于 OCR 的 "其他"），交由用户确认前修改。
"""

from __future__ import annotations

from app.services.ocr import guess_category

# 支付宝"交易分类" → 内部分类（子串匹配）。
# 微信"交易类型"是交易方式（商户消费/转账/零钱提现）而非消费分类，
# 因此微信不参与外部分类映射，统一交给关键词猜测。
ALIPAY_CATEGORY_MAP: tuple[tuple[str, str], ...] = (
    ("餐饮", "餐饮"),
    ("美食", "餐饮"),
    ("外卖", "餐饮"),
    ("交通", "交通"),
    ("出行", "交通"),
    ("打车", "交通"),
    ("加油", "交通"),
    ("停车", "交通"),
    ("购物", "购物"),
    ("日用", "日用"),
    ("住房", "住房"),
    ("居住", "住房"),
    ("物业", "住房"),
    ("医疗", "医疗"),
    ("健康", "医疗"),
    ("药品", "医疗"),
    ("教育", "教育"),
    ("培训", "教育"),
    ("娱乐", "娱乐"),
    ("休闲", "娱乐"),
    ("旅行", "旅行"),
    ("旅游", "旅行"),
    ("通讯", "通讯"),
    ("话费", "通讯"),
    ("充值", "通讯"),
)

# 收入类分类：商户名/摘要关键词 → 内部分类。
INCOME_CATEGORY_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("工资", ("工资", "薪资", "薪水", "奖金", "补贴", "报销")),
    ("退款", ("退款", "退货")),
    ("理财", ("理财", "利息", "收益", "分红", "基金", "股票")),
)


def map_external_category(platform: str | None, external: str | None) -> str | None:
    """支付宝交易分类 → 内部分类；微信不映射，返回 None。"""
    if platform != "alipay":
        return None
    text = (external or "").strip()
    if not text:
        return None
    for keyword, category in ALIPAY_CATEGORY_MAP:
        if keyword in text:
            return category
    return None


def classify_income(description: str) -> str:
    """收入分类：关键词猜测，未命中 → "其他收入"。"""
    text = (description or "").strip()
    for category, keywords in INCOME_CATEGORY_KEYWORDS:
        if any(keyword in text for keyword in keywords):
            return category
    return "其他收入"


def classify(
    platform: str | None,
    external: str | None,
    description: str,
    direction: str,
) -> str:
    """统一分类入口：收入走 classify_income，支出走 外部分类 → 关键词 → 未分类。"""
    if direction == "income":
        return classify_income(description)
    mapped = map_external_category(platform, external)
    if mapped:
        return mapped
    guessed = guess_category(description)
    return "未分类" if guessed == "其他" else guessed
