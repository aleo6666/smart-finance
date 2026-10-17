"""Constrained ReAct loop node for exploratory financial analysis.

The loop keeps the model on a short leash: it may only call the deterministic
analysis tools, may only quote numbers that actually appear in the collected
``dataset_refs`` (evidence chain V2.1), and every LLM/tool call is bounded by
``asyncio.wait_for(timeout=tool_timeout)``. Intermediate observations stay out
of ``messages`` so the conversation context does not bloat; only the final
analysis lands as a single ``AIMessage`` plus the external ``analysis`` field.

Optional self-critique (反思闭环): when ``critic_model`` is provided, every
``final`` draft is audited by a critic LLM before finalize. A rejected draft
(答非所问 / 超证据 / 空泛套话, or a deterministic rule finding no quoted ref
number) is appended back into the loop as a ``【自检意见】`` observation so the
model can revise or re-query tools. Anti-dead-loop: total critic rounds are
bounded by ``critic_max_rounds`` (each ``final`` consumes one round), the main
ReAct iteration cap (``analyst_max_iterations``) is unchanged, and critic
degradation (timeout / exception / non-JSON) falls through to allow the draft
rather than block the pipeline. The evidence chain is the final line of defense
regardless of the critic: every output still passes through
``validate_analysis_against_refs``, and ``critique_log`` records each round.
"""

from __future__ import annotations

import asyncio
import json
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

CRITIC_SYSTEM_PROMPT = (
    "你是财务分析审计员（批判者）。给定用户问题、候选分析文本和数据集引用(refs)，"
    "审核该分析是否可直接交付。只返回 JSON，不要 Markdown：\n"
    '{"pass": true|false, "issues": ["..."], "suggestion": "..."}\n'
    "审计三问：\n"
    "1. 是否直接回答了用户问题的核心（答非所问 → pass=false）；\n"
    "2. 结论是否超出证据（除 refs 数字外还需足够数据支撑判断，纯推理穿越 → pass=false）；\n"
    "3. 是否空泛套话或无具体信息（应至少引用 1 个 refs 中的真实数字，否则 pass=false）。\n"
    "pass=true 表示可交付；pass=false 必须给出具体 issues 和可执行的 suggestion。"
)

ANALYSIS_TIMEOUT_FALLBACK = "分析超时，请缩小问题范围"
ANALYSIS_MAX_ITERATIONS_FALLBACK = "分析步骤过多，未能收敛，请缩小问题范围"
FALLBACK_ANALYSIS = "基于真实数据，本次分析未能形成有效结论，请补充数据或缩小问题范围"

_NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")
# 按句/分句切分：逗号也切，避免「真实数字 + 假设数字」混在一句时
# 整句被误删（证据链应只删没有引用支撑的分句）。
_CLAUSE_SPLIT_RE = re.compile(r"(?<=[。！？!?；;\n，,])")


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


def _ref_numbers(refs: list[dict]) -> set[Decimal]:
    """Return every number reachable across all collected ref structures."""
    allowed: set[Decimal] = set()
    for ref in refs:
        collect_numbers(ref, allowed)
    return allowed


def _analysis_has_ref_number(analysis: str, refs: list[dict]) -> bool:
    """True when at least one number in ``analysis`` appears in ``refs``.

    Deterministic rule-layer guard for the critic: an analysis quoting no real
    dataset number cannot be grounded, so the critic must reject it regardless
    of what the LLM says.
    """
    allowed = _ref_numbers(refs)
    return any(number in allowed for number in extract_numbers(analysis))


def validate_analysis_against_refs(analysis: str, dataset_refs: list[dict]) -> str:
    """Drop any clause whose numbers cannot be found in ``dataset_refs``.

    Falls back to a deterministic template when nothing survives, so the model
    can never hand a fabricated number back to the user.
    """
    allowed = _ref_numbers(dataset_refs)
    clauses = [
        clause.strip()
        for clause in _CLAUSE_SPLIT_RE.split(analysis)
        if clause.strip()
    ]
    kept = [
        clause
        for clause in clauses
        if all(number in allowed for number in extract_numbers(clause))
    ]
    if not kept:
        return FALLBACK_ANALYSIS
    joined = "".join(kept)
    return joined if joined.endswith(("。", "！", "？", "!", "?")) else joined + "。"


def _latest_user_text(messages: list[BaseMessage]) -> str:
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            return str(message.content)
    return ""


async def _run_critic(
    critic_model: Any,
    question: str,
    analysis: str,
    refs: list[dict[str, Any]],
    tool_timeout: float,
) -> dict[str, Any]:
    """Run one critic pass over a candidate ``analysis``.

    Returns ``{"pass": bool | None, "issues": [...], "suggestion": "...",
    "error": str | None}``. A non-None ``error`` means the critic call degraded
    (timeout / exception / unparseable output); callers should then allow the
    draft rather than block the pipeline.
    """
    refs_summary = json.dumps(refs, ensure_ascii=False, default=str)
    prompt = (
        f"用户问题：{question}\n"
        f"候选分析：{analysis}\n"
        f"数据集引用(refs)：{refs_summary}"
    )
    try:
        response = await asyncio.wait_for(
            critic_model.ainvoke(
                [SystemMessage(content=CRITIC_SYSTEM_PROMPT), HumanMessage(content=prompt)]
            ),
            timeout=tool_timeout,
        )
    except asyncio.TimeoutError:
        return {"pass": None, "issues": [], "suggestion": "", "error": "timeout"}
    except Exception as exc:
        return {"pass": None, "issues": [], "suggestion": "", "error": str(exc)}

    content = response.content if hasattr(response, "content") else str(response)
    parsed = parse_json_object(content)
    if not parsed or "pass" not in parsed:
        return {"pass": None, "issues": [], "suggestion": "", "error": "non-json-or-missing-pass"}

    pass_value = parsed["pass"]
    if pass_value is True:
        is_pass = True
    elif pass_value is False:
        is_pass = False
    elif isinstance(pass_value, str):
        normalized = pass_value.strip().lower()
        if normalized == "true":
            is_pass = True
        elif normalized == "false":
            is_pass = False
        else:
            return {"pass": None, "issues": [], "suggestion": "", "error": "unrecognized-pass"}
    else:
        return {"pass": None, "issues": [], "suggestion": "", "error": "unrecognized-pass"}

    issues = parsed.get("issues", [])
    if not isinstance(issues, list):
        issues = []
    issues = [str(item) for item in issues]
    suggestion = parsed.get("suggestion", "")
    if not isinstance(suggestion, str):
        suggestion = str(suggestion)
    return {"pass": is_pass, "issues": issues, "suggestion": suggestion, "error": None}


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
    critic_model: Any | None = None,
    critic_max_rounds: int = 2,
):
    tools_by_name = {tool.name: tool for tool in analysis_tools}

    def _finalize(
        analysis: str,
        refs: list[dict[str, Any]],
        tool_names: list[str],
        iterations: int,
        critique_log: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        result: dict[str, Any] = {
            "messages": [AIMessage(content=analysis)],
            "analysis": analysis,
            "dataset_refs": refs,
            "used_tools": tool_names,
            "iterations": iterations,
            "intent": "analysis",
        }
        if critique_log:
            result["critique_log"] = critique_log
        return result

    async def analyst_loop(state: dict[str, Any]) -> dict[str, Any]:
        user_id = state["user_id"]
        ledger_id = state.get("ledger_id")
        question = _latest_user_text(state.get("messages", []))
        observations: list[dict[str, Any]] = []
        tool_names: list[str] = []
        refs: list[dict[str, Any]] = []
        critique_log: list[dict[str, Any]] = []
        critic_rounds_used = 0

        for iteration in range(1, analyst_max_iterations + 1):
            decision_messages: list[BaseMessage] = [
                SystemMessage(content=ANALYST_SYSTEM_PROMPT),
                HumanMessage(content=question),
            ]
            for observation in observations:
                prefix = (
                    "【自检意见】"
                    if observation.get("is_critique")
                    else f"【观察：{observation['tool']}】"
                )
                decision_messages.append(
                    HumanMessage(content=f"{prefix}{observation['context']}")
                )
            try:
                response = await asyncio.wait_for(
                    model.ainvoke(decision_messages), timeout=tool_timeout
                )
            except asyncio.TimeoutError:
                logger.warning("analyst_loop LLM call timed out after %ss", tool_timeout)
                return _finalize(
                    ANALYSIS_TIMEOUT_FALLBACK, refs, tool_names, iteration, critique_log
                )
            except Exception as exc:
                logger.warning("analyst_loop LLM call failed: %s", exc)
                return _finalize(
                    ANALYSIS_TIMEOUT_FALLBACK, refs, tool_names, iteration, critique_log
                )

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
                    critique_log,
                )

            if decision.get("final") is True:
                analysis = (
                    str(decision.get("analysis") or "").strip() or FALLBACK_ANALYSIS
                )
                if critic_model is None:
                    return _finalize(
                        validate_analysis_against_refs(analysis, refs),
                        refs,
                        tool_names,
                        iteration,
                        critique_log,
                    )

                # --- 批判/反思闭环（critic_model 非 None） ---
                critic_rounds_used += 1
                round_num = critic_rounds_used
                critique = await _run_critic(
                    critic_model, question, analysis, refs, tool_timeout
                )
                if critique["error"] is not None:
                    # 批判调用降级：log + 放行初稿，不阻塞业务
                    logger.warning(
                        "critic round %d degraded (%s); allowing draft",
                        round_num,
                        critique["error"],
                    )
                    critique_log.append(
                        {"round": round_num, "error": critique["error"]}
                    )
                    return _finalize(
                        validate_analysis_against_refs(analysis, refs),
                        refs,
                        tool_names,
                        iteration,
                        critique_log,
                    )

                is_pass = critique["pass"] is True
                # 规则层前置（确定性，不依赖 LLM）：analysis 未引用任何 refs 数字 → 强制 fail
                if not _analysis_has_ref_number(analysis, refs):
                    is_pass = False
                    rule_issue = "结论未引用任何真实数据"
                    if rule_issue not in critique["issues"]:
                        critique["issues"] = [*critique["issues"], rule_issue]
                    logger.warning(
                        "critic round %d rule-layer forced fail: no ref number quoted",
                        round_num,
                    )

                critique_log.append(
                    {
                        "round": round_num,
                        "pass": is_pass,
                        "issues": critique["issues"],
                        "suggestion": critique["suggestion"],
                    }
                )

                if is_pass:
                    logger.info("critic round %d passed", round_num)
                    return _finalize(
                        validate_analysis_against_refs(analysis, refs),
                        refs,
                        tool_names,
                        iteration,
                        critique_log,
                    )

                # 打回：批判意见作为一条「自检意见」观察回到 ReAct 循环
                if (
                    critic_rounds_used >= critic_max_rounds
                    or iteration >= analyst_max_iterations
                ):
                    logger.info(
                        "critic rounds exhausted (round %d); finalizing last revision",
                        round_num,
                    )
                    return _finalize(
                        validate_analysis_against_refs(analysis, refs),
                        refs,
                        tool_names,
                        iteration,
                        critique_log,
                    )
                issues_text = (
                    "；".join(critique["issues"])
                    if critique["issues"]
                    else "无具体意见"
                )
                observations.append(
                    {
                        "tool": "critic",
                        "context": f"{issues_text}；建议：{critique['suggestion']}",
                        "is_critique": True,
                    }
                )
                continue

            validated = _validate_analysis_call(
                decision, tools_by_name, user_id, ledger_id
            )
            if validated is None:
                return _finalize(
                    FALLBACK_ANALYSIS, refs, tool_names, iteration, critique_log
                )

            tool_name, args = validated
            try:
                result = await asyncio.wait_for(
                    tools_by_name[tool_name].ainvoke(args), timeout=tool_timeout
                )
            except asyncio.TimeoutError:
                logger.warning("analysis tool %s timed out", tool_name)
                return _finalize(
                    ANALYSIS_TIMEOUT_FALLBACK, refs, tool_names, iteration, critique_log
                )
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
            ANALYSIS_MAX_ITERATIONS_FALLBACK,
            refs,
            tool_names,
            analyst_max_iterations,
            critique_log,
        )

    return analyst_loop
