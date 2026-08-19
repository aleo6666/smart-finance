"""Constrained ReAct loop node for exploratory financial analysis.

The loop keeps the model on a short leash: it may only call the deterministic
analysis tools, may only quote numbers that actually appear in the collected
``dataset_refs`` (evidence chain V2.1), and every LLM/tool call is bounded by
``asyncio.wait_for(timeout=tool_timeout)``. Intermediate observations stay out
of ``messages`` so the conversation context does not bloat; only the final
analysis lands as a single ``AIMessage`` plus the external ``analysis`` field.
"""

from __future__ import annotations

import asyncio
import logging
import re
from decimal import Decimal
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_core.tools import BaseTool

from app.core.llm import parse_json_object

logger = logging.getLogger(__name__)

ANALYST_SYSTEM_PROMPT = (
    "你是财务分析决策器。基于用户问题与已有观察，输出一步决策（只返回 JSON，不要 Markdown）：\n"
    '- 若已获得足够数据，输出 {"final": true, "analysis": "分析文本"}\n'
    '- 否则输出 {"final": false, "tool": "<工具名>", "args": {<参数>}}\n'
    "可用工具：get_ratio_analysis / get_cashflow_trend / get_expense_breakdown / "
    "simulate_scenario。\n"
    "规则：只能调用确定性分析工具取数；分析文本只能引用观察到的真实数字；不提供投资建议。"
)

ANALYSIS_TIMEOUT_FALLBACK = "分析超时，请缩小问题范围"
ANALYSIS_MAX_ITERATIONS_FALLBACK = "分析步骤过多，未能收敛，请缩小问题范围"
FALLBACK_ANALYSIS = "基于真实数据，本次分析未能形成有效结论，请补充数据或缩小问题范围"

_NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")
_SENTENCE_SPLIT_RE = re.compile(r"[。！？!?；;\n]+")


def extract_numbers(text: str) -> list[Decimal]:
    """Return every decimal token found in ``text`` as a Decimal."""
    return [Decimal(match) for match in _NUMBER_RE.findall(text)]


def collect_numbers(value: Any, out: set[Decimal]) -> None:
    """Recursively collect every number reachable inside a ref structure."""
    if isinstance(value, Decimal):
        out.add(value)
    elif isinstance(value, bool):
        return
    elif isinstance(value, (int, float)):
        out.add(Decimal(str(value)))
    elif isinstance(value, str):
        for match in _NUMBER_RE.findall(value):
            out.add(Decimal(match))
    elif isinstance(value, dict):
        for child in value.values():
            collect_numbers(child, out)
    elif isinstance(value, (list, tuple)):
        for child in value:
            collect_numbers(child, out)


def validate_analysis_against_refs(analysis: str, dataset_refs: list[dict]) -> str:
    """Drop any sentence whose numbers cannot be found in ``dataset_refs``.

    Falls back to a deterministic template when nothing survives, so the model
    can never hand a fabricated number back to the user.
    """
    allowed: set[Decimal] = set()
    for ref in dataset_refs:
        collect_numbers(ref, allowed)
    sentences = [
        sentence.strip()
        for sentence in _SENTENCE_SPLIT_RE.split(analysis)
        if sentence.strip()
    ]
    kept = [
        sentence
        for sentence in sentences
        if all(number in allowed for number in extract_numbers(sentence))
    ]
    if not kept:
        return FALLBACK_ANALYSIS
    joined = "。".join(kept)
    return joined if joined.endswith("。") else joined + "。"


def _latest_user_text(messages: list[BaseMessage]) -> str:
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            return str(message.content)
    return ""


def _tool_observation(result: Any) -> tuple[str, list[dict]]:
    if isinstance(result, dict):
        parsed = result
    elif isinstance(result, str):
        parsed = parse_json_object(result)
    else:
        return str(result), []
    context = parsed.get("context", "")
    refs = parsed.get("dataset_refs", [])
    return (
        context if isinstance(context, str) else str(context),
        refs if isinstance(refs, list) else [],
    )


def _validate_analysis_call(
    decision: dict[str, Any],
    tools_by_name: dict[str, BaseTool],
    user_id: int,
    ledger_id: int | None,
) -> tuple[str, dict[str, Any]] | None:
    tool_name = decision.get("tool")
    if not isinstance(tool_name, str):
        return None
    tool = tools_by_name.get(tool_name)
    if tool is None:
        return None
    raw_args = decision.get("args")
    if not isinstance(raw_args, dict):
        raw_args = {}
    args = dict(raw_args)
    schema = tool.get_input_schema()
    if "user_id" in schema.model_fields:
        args["user_id"] = user_id
    if "ledger_id" in schema.model_fields and ledger_id is not None:
        args.setdefault("ledger_id", ledger_id)
    try:
        args = schema.model_validate(args).model_dump()
    except Exception as exc:
        logger.warning("analysis tool args invalid: %s", exc)
        return None
    return tool_name, args


def create_analyst_loop_node(
    *,
    model: Any,
    analysis_tools: list[BaseTool],
    tool_timeout: float,
    analyst_max_iterations: int,
):
    tools_by_name = {tool.name: tool for tool in analysis_tools}

    def _finalize(
        analysis: str,
        refs: list[dict[str, Any]],
        tool_names: list[str],
        iterations: int,
    ) -> dict[str, Any]:
        return {
            "messages": [AIMessage(content=analysis)],
            "analysis": analysis,
            "dataset_refs": refs,
            "used_tools": tool_names,
            "iterations": iterations,
            "intent": "analysis",
        }

    async def analyst_loop(state: dict[str, Any]) -> dict[str, Any]:
        user_id = state["user_id"]
        ledger_id = state.get("ledger_id")
        question = _latest_user_text(state.get("messages", []))
        observations: list[dict[str, Any]] = []
        tool_names: list[str] = []
        refs: list[dict[str, Any]] = []

        for iteration in range(1, analyst_max_iterations + 1):
            decision_messages: list[BaseMessage] = [
                SystemMessage(content=ANALYST_SYSTEM_PROMPT),
                HumanMessage(content=question),
            ]
            for observation in observations:
                decision_messages.append(
                    HumanMessage(
                        content=f"【观察：{observation['tool']}】{observation['context']}"
                    )
                )
            try:
                response = await asyncio.wait_for(
                    model.ainvoke(decision_messages), timeout=tool_timeout
                )
            except asyncio.TimeoutError:
                logger.warning("analyst_loop LLM call timed out after %ss", tool_timeout)
                return _finalize(ANALYSIS_TIMEOUT_FALLBACK, refs, tool_names, iteration)
            except Exception as exc:
                logger.warning("analyst_loop LLM call failed: %s", exc)
                return _finalize(ANALYSIS_TIMEOUT_FALLBACK, refs, tool_names, iteration)

            if not isinstance(response, AIMessage):
                response = AIMessage(content=str(response))
            decision = parse_json_object(response.content)
            if not decision:
                analysis = str(response.content).strip() or FALLBACK_ANALYSIS
                return _finalize(
                    validate_analysis_against_refs(analysis, refs),
                    refs,
                    tool_names,
                    iteration,
                )

            if decision.get("final") is True:
                analysis = str(decision.get("analysis") or "").strip() or FALLBACK_ANALYSIS
                return _finalize(
                    validate_analysis_against_refs(analysis, refs),
                    refs,
                    tool_names,
                    iteration,
                )

            validated = _validate_analysis_call(
                decision, tools_by_name, user_id, ledger_id
            )
            if validated is None:
                return _finalize(FALLBACK_ANALYSIS, refs, tool_names, iteration)

            tool_name, args = validated
            try:
                result = await asyncio.wait_for(
                    tools_by_name[tool_name].ainvoke(args), timeout=tool_timeout
                )
            except asyncio.TimeoutError:
                logger.warning("analysis tool %s timed out", tool_name)
                return _finalize(ANALYSIS_TIMEOUT_FALLBACK, refs, tool_names, iteration)
            except Exception as exc:
                logger.warning("analysis tool %s failed: %s", tool_name, exc)
                observations.append(
                    {"tool": tool_name, "context": f"工具执行失败：{exc}"}
                )
                continue

            context, tool_refs = _tool_observation(result)
            observations.append({"tool": tool_name, "context": context})
            tool_names.append(tool_name)
            refs.extend(ref for ref in tool_refs if isinstance(ref, dict))

        return _finalize(
            ANALYSIS_MAX_ITERATIONS_FALLBACK, refs, tool_names, analyst_max_iterations
        )

    return analyst_loop
