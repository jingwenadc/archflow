#!/usr/bin/env python3
"""在生成章节或完整合并版前校验人工批准状态。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def fail(message: str) -> int:
    print(f"门禁未通过：{message}")
    return 1


def approved(block: object) -> bool:
    return isinstance(block, dict) and block.get("approved") is True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("state", type=Path, help="项目的 review/project-state.json")
    parser.add_argument("--action", choices=("generate-section", "finalize"), required=True)
    parser.add_argument("--section", help="生成章节时使用的章节编号")
    args = parser.parse_args()

    try:
        data = json.loads(args.state.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return fail(f"无法读取有效项目状态：{exc}")

    if not approved(data.get("structure")):
        return fail("整体骨架尚未得到用户明确批准")
    if not approved(data.get("storyboard")):
        return fail("完整逐页故事板尚未得到用户明确批准")

    sections = data.get("sections")
    if not isinstance(sections, list) or not sections:
        return fail("项目状态中没有有效的一级章节")

    if args.action == "finalize":
        waiting = [
            str(section.get("id", "?"))
            for section in sections
            if (
                not isinstance(section, dict)
                or section.get("approved") is not True
                or not section.get("selectedVersion")
            )
        ]
        if waiting:
            return fail(f"仍有未批准或未选定版本的范围：{', '.join(waiting)}")
        print("门禁通过：可以生成完整合并版")
        return 0

    if not args.section:
        return fail("generate-section 必须提供 --section")
    target = None
    for section in sections:
        if isinstance(section, dict) and str(section.get("id")) == args.section:
            target = section
            break
    if target is None:
        return fail(f"找不到章节 {args.section}")

    if target.get("authorized") is not True:
        return fail("目标范围尚未得到用户明确授权")
    if target.get("approved") is True and target.get("revisionAuthorized") is not True:
        return fail("目标范围已经批准；如需修改，必须取得新的修改授权")
    if not target.get("outputPath"):
        return fail("目标范围没有独立输出目录")

    print(
        f"门禁通过：可以处理范围 {args.section}《{target.get('title', '')}》，"
        f"输出到 {target.get('outputPath')}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
