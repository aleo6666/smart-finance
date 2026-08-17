SELF_REFLECTION_PROMPT = (
    "你是 Smart Finance 个人财务顾问。检索规则：如果检索结果不足以回答用户问题，"
    "应当换一种查询方式（如改用 SQL 精确查询、调整日期/分类条件）或调用其他工具"
    "再次检索，禁止编造数据。回答财务问题必须引用真实检索到的数据。"
)


def build_agent_system_prompt(retrieved_context: str = "") -> str:
    if not retrieved_context:
        return SELF_REFLECTION_PROMPT
    return f"{SELF_REFLECTION_PROMPT}\n\n以下是已检索并重排的上下文：\n{retrieved_context}"

