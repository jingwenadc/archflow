export type CitationSource = { file_id: string; name: string; page_count: number };

// File/page IDs remain the saved evidence; only the review/export surface uses names.
export function displayCitations(text: string, sources: CitationSource[]): string {
  const names = new Map(sources.map(source => [source.file_id, source.name]));
  if (!text || !names.size) return text;
  const ids = [...names.keys()].sort((a, b) => b.length - a.length).map(id => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?<![A-Za-z0-9-])(${ids}):((?:page|p)\\d+(?:(?:[、，,]\\s*|[–—-])(?:page|p)?\\d+)*)`, "gi");
  return text.replace(pattern, (_, id: string, pages: string) => {
    const numbers = pages.match(/\d+/g) ?? [];
    const separator = /[–—-]/.test(pages) ? "–" : "、";
    return `《${names.get(id)}》第 ${numbers.join(separator)} 页`;
  });
}
