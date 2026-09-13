#!/usr/bin/env python3
"""Extract searchable PDF text with stable page markers.

Uses pdfplumber when available. Output is for evidence review, not a substitute
for visually checking scoring tables, forms, drawings, or scanned pages.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pdfplumber


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_pdf", type=Path)
    parser.add_argument("output_text", type=Path)
    parser.add_argument("--first", type=int, default=1, help="First PDF page, 1-based")
    parser.add_argument("--last", type=int, help="Last PDF page, inclusive")
    args = parser.parse_args()

    if args.first < 1:
        parser.error("--first must be at least 1")

    with pdfplumber.open(args.input_pdf) as pdf:
        last = args.last or len(pdf.pages)
        if last < args.first or last > len(pdf.pages):
            parser.error(f"page range must fall within 1-{len(pdf.pages)}")

        chunks: list[str] = []
        for number in range(args.first, last + 1):
            page = pdf.pages[number - 1]
            text = page.extract_text(layout=True) or ""
            chunks.append(f"\n===== PDF PAGE {number} =====\n{text.rstrip()}\n")

    args.output_text.parent.mkdir(parents=True, exist_ok=True)
    args.output_text.write_text("".join(chunks), encoding="utf-8")


if __name__ == "__main__":
    main()
