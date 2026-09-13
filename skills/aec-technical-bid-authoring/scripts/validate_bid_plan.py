#!/usr/bin/env python3
"""Validate a technical-bid score, evidence, and claim plan."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path


ALLOWED_STATUSES = {"verified", "proposal", "commitment", "assumption", "missing"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path)
    parser.add_argument("--stage", choices=("draft", "final"), default="draft")
    args = parser.parse_args()

    errors: list[str] = []
    warnings: list[str] = []
    try:
        data = json.loads(args.plan.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: cannot read valid JSON: {exc}")
        return 2

    project = data.get("project")
    if not isinstance(project, dict) or not str(project.get("name", "")).strip():
        errors.append("project.name is required")

    stated_total = data.get("stated_total_points")
    if not isinstance(stated_total, (int, float)) or isinstance(stated_total, bool):
        errors.append("stated_total_points must be numeric")

    evidence = data.get("evidence")
    if not isinstance(evidence, list):
        errors.append("evidence must be a list")
        evidence = []
    evidence_ids: set[str] = set()
    for index, item in enumerate(evidence, start=1):
        if not isinstance(item, dict):
            errors.append(f"evidence[{index}] must be an object")
            continue
        eid = str(item.get("id", "")).strip()
        if not eid:
            errors.append(f"evidence[{index}].id is required")
        elif eid in evidence_ids:
            errors.append(f"duplicate evidence id: {eid}")
        evidence_ids.add(eid)
        if not str(item.get("source", "")).strip():
            errors.append(f"evidence {eid or index} has no source locator")
        status = item.get("status")
        if status not in ALLOWED_STATUSES:
            errors.append(f"evidence {eid or index} has invalid status: {status!r}")
        if args.stage == "final" and status in {"assumption", "missing"}:
            errors.append(f"final stage contains unresolved evidence {eid}: {status}")

    constraints = data.get("hard_constraints")
    if not isinstance(constraints, list) or not constraints:
        errors.append("hard_constraints must be a non-empty list")
        constraints = []
    for index, item in enumerate(constraints, start=1):
        if not isinstance(item, dict):
            errors.append(f"hard_constraints[{index}] must be an object")
            continue
        cid = str(item.get("id", index))
        if not str(item.get("requirement", "")).strip():
            errors.append(f"hard constraint {cid} has no requirement")
        if not str(item.get("source", "")).strip():
            errors.append(f"hard constraint {cid} has no source locator")
        if args.stage == "final" and item.get("status") != "verified":
            errors.append(f"hard constraint {cid} is not verified")

    criteria = data.get("criteria")
    if not isinstance(criteria, list) or not criteria:
        errors.append("criteria must be a non-empty list")
        criteria = []
    criterion_ids: set[str] = set()
    computed_total = 0.0
    for index, item in enumerate(criteria, start=1):
        if not isinstance(item, dict):
            errors.append(f"criteria[{index}] must be an object")
            continue
        cid = str(item.get("id", "")).strip()
        if not cid:
            errors.append(f"criteria[{index}].id is required")
        elif cid in criterion_ids:
            errors.append(f"duplicate criterion id: {cid}")
        criterion_ids.add(cid)

        points = item.get("points")
        if not isinstance(points, (int, float)) or isinstance(points, bool) or points < 0:
            errors.append(f"criterion {cid or index} has invalid points")
        else:
            computed_total += float(points)

        for field in ("group", "factor", "scoring_rule", "source"):
            if not str(item.get(field, "")).strip():
                errors.append(f"criterion {cid or index} has no {field}")

        sections = item.get("response_sections")
        if not isinstance(sections, list) or not any(str(x).strip() for x in sections):
            errors.append(f"criterion {cid or index} is not mapped to a response section")

        refs = item.get("evidence_ids")
        if not isinstance(refs, list):
            errors.append(f"criterion {cid or index}.evidence_ids must be a list")
            refs = []
        unknown = sorted({str(ref) for ref in refs} - evidence_ids)
        if unknown:
            errors.append(f"criterion {cid or index} references unknown evidence: {', '.join(unknown)}")
        if item.get("objective") is True and not refs:
            errors.append(f"objective criterion {cid or index} has no evidence chain")
        if args.stage == "final" and str(item.get("gap", "")).strip():
            errors.append(f"criterion {cid or index} still has a gap")

    if isinstance(stated_total, (int, float)) and not isinstance(stated_total, bool):
        if not math.isclose(computed_total, float(stated_total), abs_tol=1e-6):
            errors.append(
                f"score total mismatch: criteria sum to {computed_total:g}, "
                f"but tender states {float(stated_total):g}"
            )

    claims = data.get("claims")
    if not isinstance(claims, list):
        errors.append("claims must be a list")
        claims = []
    claim_ids: set[str] = set()
    for index, item in enumerate(claims, start=1):
        if not isinstance(item, dict):
            errors.append(f"claims[{index}] must be an object")
            continue
        cid = str(item.get("id", "")).strip()
        if not cid:
            errors.append(f"claims[{index}].id is required")
        elif cid in claim_ids:
            errors.append(f"duplicate claim id: {cid}")
        claim_ids.add(cid)
        status = item.get("status")
        if status not in ALLOWED_STATUSES:
            errors.append(f"claim {cid or index} has invalid status: {status!r}")
        if not str(item.get("text", "")).strip():
            errors.append(f"claim {cid or index} has no text")
        if status in {"verified", "proposal", "commitment"} and not str(item.get("source", "")).strip():
            errors.append(f"claim {cid or index} has no source or decision record")
        if args.stage == "final":
            if status in {"assumption", "missing"}:
                errors.append(f"final stage contains unresolved claim {cid}: {status}")
            if status == "commitment" and item.get("authorized") is not True:
                errors.append(f"final stage contains unauthorized commitment {cid}")

    if not claims:
        warnings.append("claim register is empty; check numeric and absolute statements manually")

    for warning in warnings:
        print(f"WARNING: {warning}")
    for error in errors:
        print(f"ERROR: {error}")
    if errors:
        print(f"FAILED: {len(errors)} error(s), {len(warnings)} warning(s)")
        return 1

    print(
        f"PASS: {len(criteria)} criteria, {computed_total:g} points, "
        f"{len(evidence)} evidence item(s), {len(claims)} claim(s); stage={args.stage}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
