import type { ClaimedJob, GenerationJobDetail, ArtifactUnit, JobCheckpoint, UsageRecord } from "./contracts.js";

export class ApiClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  private async request<T>(path: string, body?: unknown, lease?: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}`, ...(lease ? { "Lease-Id": lease } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      // Never log provider responses, credentials, or the private project brief.
      const error = await response.json().catch(() => null);
      const detail = typeof error?.detail === "string" ? error.detail.replaceAll(this.token, "[redacted]").slice(0, 300) : "";
      throw new Error(detail || `ArchFlow API rejected ${path.split("/").at(-1)} (${response.status})`);
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }

  claim() { return this.request<ClaimedJob | null>("/internal/jobs/claim", {}); }
  detail(id: string) { return this.request<GenerationJobDetail>(`/api/v1/jobs/${id}`); }
  units(id: string, kind: "draft" | "storyboard", offset: number, limit = 10) {
    return this.request<ArtifactUnit[]>(`/api/v1/jobs/${id}/units?kind=${kind}&offset=${offset}&limit=${limit}`);
  }
  sources(id: string, query = "", sourceId?: string) {
    const params = new URLSearchParams({ query, ...(sourceId ? { source_id: sourceId } : {}) });
    return this.request<Array<{id: string; file: string; role: string; page: number; text: string; image_id?: string}>>(`/internal/jobs/${id}/sources?${params}`);
  }
  image(id: string, imageId: string) {
    return this.request<{ data: string; mime_type: string }>(`/internal/jobs/${id}/images?image_id=${encodeURIComponent(imageId)}`);
  }
  heartbeat(id: string, lease: string) { return this.request<void>(`/internal/jobs/${id}/heartbeat`, {}, lease); }
  checkpoint(id: string, lease: string, body: JobCheckpoint) {
    return this.request<GenerationJobDetail>(`/internal/jobs/${id}/checkpoint`, body, lease);
  }
  call(id: string, lease: string, operation: "reserve" | "usage", body: UsageRecord) {
    return this.request<void>(`/internal/jobs/${id}/calls/${operation}`, body, lease);
  }
}
