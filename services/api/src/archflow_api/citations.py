"""Render frozen source page IDs for people without changing stored evidence."""
import re


def display_citations(text: str, sources: list[dict]) -> str:
    names = {doc["file_id"]: doc["name"] for doc in sources if doc.get("file_id") and doc.get("name")}
    if not names or not text:
        return text
    ids = "|".join(re.escape(file_id) for file_id in sorted(names, key=len, reverse=True))
    pages = r"((?:page|p)\d+(?:(?:[、，,]\s*|[–—-])(?:page|p)?\d+)*)"
    pattern = re.compile(rf"(?<![A-Za-z0-9-])({ids}):{pages}", re.IGNORECASE)

    def replace(match: re.Match[str]) -> str:
        numbers = re.findall(r"\d+", match.group(2))
        separator = "–" if re.search(r"[–—-]", match.group(2)) else "、"
        return f"《{names[match.group(1)]}》第 {separator.join(numbers)} 页"

    return pattern.sub(replace, text)
