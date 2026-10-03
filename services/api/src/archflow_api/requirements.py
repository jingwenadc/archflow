"""Resolve explicit document lengths, never confuse page references with scope."""
import re


def requested_unit_count(text: str, module: str) -> int | None:
    unit = r"(?:章节|章|chapters?\b)" if module == "bid" else r"(?:页|slides?\b|pages?\b)"
    counts = []
    for match in re.finditer(r"(?<!\d)(\d+)\s*" + unit, text, re.IGNORECASE):
        prefix = text[:match.start()]
        if not re.search(r"第\s*$|\d\s*[-–到至]\s*$|(?:不要|不做|不是|not)\s*$", prefix, re.IGNORECASE):
            counts.append(int(match[1]))
    return counts[-1] if counts else None


def scope_mismatch(goal: str, module: str, target: int, override: bool = False) -> bool:
    requested = requested_unit_count(goal, module)
    return not override and requested is not None and requested != target


def plan_scope_error(plan: dict, module: str, target: int) -> str | None:
    # Old plans stored the count on the job; new tool submissions require it too.
    if plan.get("target_units", target) != target:
        return "提纲必须匹配已确认的交付数量；章节数不等于页数。"
    if scope_mismatch(plan.get("summary", ""), module, target):
        return "提纲概述中的交付数量与确认范围冲突。请只描述项目与设计策略，交付数量由 target_units 声明。"
    expected = 1
    for section in plan.get("sections", []):
        if section["start_unit"] != expected or section["end_unit"] < section["start_unit"]:
            return "提纲范围必须连续覆盖交付内容，不得遗漏或重叠。"
        expected = section["end_unit"] + 1
    if expected != target + 1:
        return "提纲范围必须覆盖全部已确认页面或章节。"
    return None
