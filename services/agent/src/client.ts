import type { ClaimedJob, GenerationJobDetail, ArtifactUnit, JobCheckpoint, UsageRecord, WorkerProgress } from "./contracts.js";
import { WorkflowError } from "./errors.js";

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
      const message = typeof error?.detail === "string" ? error.detail : error?.detail?.message;
      const detail = typeof message === "string" ? message.replaceAll(this.token, "[redacted]").slice(0, 300) : "";
      throw new WorkflowError(error?.detail?.code === "budget" ? "budget" : "workflow", detail || `ArchFlow API rejected request (${response.status})`);
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }

  claim() { return this.request<ClaimedJob | null>("/internal/jobs/claim", {}); }
  detail(id: string) { return this.request<GenerationJobDetail>(`/api/v1/jobs/${id}`); }
  units(id: string, kind: "draft" | "storyboard", offset: number, limit = 10) {
    return this.request<ArtifactUnit[]>(`/api/v1/jobs/${id}/units?kind=${kind}&offset=${offset}&limit=${limit}`);
  }
  reviewUnits(id: string, kind: "draft" | "storyboard", offset: number, limit = 5) {
    return this.request<ArtifactUnit[]>(`/internal/jobs/${id}/review-units?kind=${kind}&offset=${offset}&limit=${limit}`);
  }
  sources(id: string, query = "", sourceId?: string) {
    const params = new URLSearchParams({ query, ...(sourceId ? { source_id: sourceId } : {}) });
    return this.request<Array<{id: string; file: string; role: string; page: number; text: string; image_id?: string}>>(`/internal/jobs/${id}/sources?${params}`);
  }
  image(id: string, imageId: string) {
    return this.request<{ data: string; mime_type: string }>(`/internal/jobs/${id}/images?image_id=${encodeURIComponent(imageId)}`);
  }
  heartbeat(id: string, lease: string) { return this.request<void>(`/internal/jobs/${id}/heartbeat`, {}, lease); }
  progress(id: string, lease: string, body: WorkerProgress) { return this.request<void>(`/internal/jobs/${id}/progress`, body, lease); }
  checkpoint(id: string, lease: string, body: JobCheckpoint) {
    return this.request<GenerationJobDetail>(`/internal/jobs/${id}/checkpoint`, body, lease);
  }
  call(id: string, lease: string, operation: "reserve" | "usage", body: UsageRecord) {
    return this.request<void>(`/internal/jobs/${id}/calls/${operation}`, body, lease);
  }
}
