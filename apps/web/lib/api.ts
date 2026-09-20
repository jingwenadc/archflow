export type UploadedFile = {
  id: string;
  name: string;
  size: number;
  content_type: string;
  status: "uploaded";
};

export type Project = {
  id: string;
  name: string;
  created_at: string;
  status: "ready";
};

export type Conversation = {
  id: string;
  project_id: string;
  module: "concept" | "bid" | "drawing";
  title: string;
  created_at: string;
  updated_at: string;
};

export type Message = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
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

export async function uploadProjectFile(file: File, projectId?: string): Promise<UploadedFile> {
  const body = new FormData();
  body.append("file", file);

  const endpoint = projectId ? `/api/v1/files?project_id=${encodeURIComponent(projectId)}` : "/api/v1/files";
  const response = await fetch(`${apiBaseUrl}${endpoint}`, {
    method: "POST",
    body,
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.detail ?? "文件上传失败");
  }

  return response.json() as Promise<UploadedFile>;
}

export function getProjectFiles(projectId: string) {
  return apiRequest<UploadedFile[]>(`/api/v1/files?project_id=${encodeURIComponent(projectId)}`);
}

export async function uploadCaseFile(file: File): Promise<UploadedFile> {
  const body = new FormData();
  body.append("file", file);
  return apiRequest<UploadedFile>("/api/v1/cases/files", { method: "POST", body });
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init);
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.detail ?? "请求失败，请稍后重试。");
  }
  return response.json() as Promise<T>;
}

export function getProjects() {
  return apiRequest<Project[]>("/api/v1/projects");
}

export function createProject(name: string) {
  return apiRequest<Project>("/api/v1/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export function getConversations(projectId: string, module: Conversation["module"]) {
  return apiRequest<Conversation[]>(`/api/v1/conversations?project_id=${encodeURIComponent(projectId)}&module=${module}`);
}

export function createConversation(projectId: string, module: Conversation["module"], title: string) {
  return apiRequest<Conversation>("/api/v1/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, module, title }),
  });
}

export function getMessages(conversationId: string) {
  return apiRequest<Message[]>(`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`);
}

export function sendMessage(conversationId: string, content: string) {
  return apiRequest<Message>(`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
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
