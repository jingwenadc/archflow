export type UploadedFile = {
  id: string;
  name: string;
  size: number;
  content_type: string;
  status: "uploaded";
};

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

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
