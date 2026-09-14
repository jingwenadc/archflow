export type UploadedFile = {
  id: string;
  name: string;
  size: number;
  content_type: string;
  status: "uploaded";
};

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type SkillFile = {
  path: string;
  size: number;
  kind: "markdown" | "code" | "image" | "binary";
  editable: boolean;
  content: string | null;
};

export type SkillDetail = {
  slug: string;
  name: string;
  module: string;
  status: "available";
  source_path: string;
  files: SkillFile[];
};

export type DraftPullRequest = {
  url: string;
  number: number;
  branch: string;
};

export async function uploadProjectFile(file: File): Promise<UploadedFile> {
  const body = new FormData();
  body.append("file", file);

  const response = await fetch(`${apiBaseUrl}/api/v1/files`, {
    method: "POST",
    body,
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.detail ?? "文件上传失败");
  }

  return response.json() as Promise<UploadedFile>;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init);
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.detail ?? "请求失败，请稍后重试。");
  }
  return response.json() as Promise<T>;
}

export function getSkillDetail(slug: string) {
  return apiRequest<SkillDetail>(`/api/v1/skills/${encodeURIComponent(slug)}`);
}

export function getSkillFileUrl(slug: string, path: string) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${apiBaseUrl}/api/v1/skills/${encodeURIComponent(slug)}/files/${encodedPath}`;
}

export function createSkillDraftPullRequest(
  slug: string,
  request: { title: string; description: string; changes: Array<{ path: string; content: string }> },
) {
  return apiRequest<DraftPullRequest>(`/api/v1/skills/${encodeURIComponent(slug)}/draft-pr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
}
