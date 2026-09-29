"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "./api";
import type { CitationSource } from "./source-citations";

export function useCitationSources(jobId: string | null) {
  const [loaded, setLoaded] = useState<{ id: string; sources: CitationSource[]; error?: string } | null>(null);
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    void apiRequest<CitationSource[]>(`/api/v1/jobs/${jobId}/source-citations`)
      .then(sources => { if (!cancelled) setLoaded({ id: jobId, sources }); })
      .catch(error => { if (!cancelled) setLoaded({ id: jobId, sources: [], error: error instanceof Error ? error.message : "无法读取来源文件名" }); });
    return () => { cancelled = true; };
  }, [jobId]);
  return loaded?.id === jobId ? loaded : null;
}
