#!/usr/bin/env python3
"""校验建筑概念方案的 JSON 故事板。"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path


REQUIRED = {"id", "chapter", "title", "purpose", "takeaway", "archetype", "evidence", "assets"}
ALLOWED_ARCHETYPES = {
    "minimal-cover", "contents-matrix", "chapter-divider", "narrative-hinge",
    "context-map-split", "brief-program-map", "concept-equation",
    "generation-sequence", "analysis-map", "masterplan-hero",
    "stacked-axon-program", "plan-section-plate", "plan-plus-locator",
    "plan-plus-rendering", "rendering-hero", "image-evidence-collage",
    "dark-concept-field", "scheme-comparison", "technical-table", "closing",
}


def has_text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("storyboard", type=Path, help="包含 slides 数组的 JSON 文件")
    args = parser.parse_args()

    try:
        data = json.loads(args.storyboard.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"错误：无法读取有效 JSON：{exc}")
        return 2

    slides = data.get("slides") if isinstance(data, dict) else None
    if not isinstance(slides, list) or not slides:
        print("错误：顶层对象必须包含非空 slides 数组")
        return 2

    errors: list[str] = []
    warnings: list[str] = []
    ids: list[str] = []
    asset_uses: Counter[str] = Counter()
    dense_run = 0

    for index, slide in enumerate(slides, start=1):
        label = f"第 {index} 页"
        if not isinstance(slide, dict):
            errors.append(f"{label}：条目必须是对象")
            continue
        missing = REQUIRED - set(slide)
        if missing:
            errors.append(f"{label}：缺少字段 {sorted(missing)}")
        slide_id = slide.get("id")
        if has_text(slide_id):
            ids.append(str(slide_id))
        else:
            errors.append(f"{label}：id 必须是非空文字")
        for field in ("chapter", "title", "purpose", "takeaway"):
            if field in slide and not has_text(slide[field]):
                errors.append(f"{label}：{field} 必须是非空文字")
        archetype = slide.get("archetype")
        if archetype not in ALLOWED_ARCHETYPES:
            errors.append(f"{label}：不支持的页面原型 {archetype!r}")
        evidence = slide.get("evidence")
        if evidence is not None and not isinstance(evidence, list):
            errors.append(f"{label}：evidence 必须是数组")
        assets = slide.get("assets")
        if not isinstance(assets, list):
            errors.append(f"{label}：assets 必须是数组")
        else:
            for asset in assets:
                if isinstance(asset, str) and asset.strip():
                    asset_uses[asset] += 1
                else:
                    errors.append(f"{label}：每个素材编号都必须是非空文字")
        if slide.get("density") == "inspect":
            dense_run += 1
            if dense_run > 2:
                warnings.append(f"{label}：连续审阅页超过两页")
        else:
            dense_run = 0
        if archetype == "narrative-hinge" and index == len(slides):
            warnings.append(f"{label}：转折页后没有回答页面")
        if len(str(slide.get("title", ""))) > 28:
            warnings.append(f"{label}：标题可能过长")

    duplicates = [item for item, count in Counter(ids).items() if count > 1]
    if duplicates:
        errors.append(f"存在重复页面 id：{duplicates}")
    for asset, count in sorted(asset_uses.items()):
        if count > 2:
            warnings.append(f"素材 {asset!r} 使用 {count} 次；如属必要复用，请填写 reuse_reason")

    for item in errors:
        print(f"错误：{item}")
    for item in warnings:
        print(f"警告：{item}")
    print(f"已检查 {len(slides)} 页：{len(errors)} 个错误，{len(warnings)} 个警告")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
