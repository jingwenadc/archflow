"""Exercise Nginx multipart buffering with a valid >16 MB synthetic PNG."""
import io
import os
import time

import httpx
from PIL import Image


def main():
    client = httpx.Client(base_url=os.environ.get("ARCHFLOW_TEST_URL", "http://nginx"), auth=("archflow", os.environ["ARCHFLOW_TEST_PASSWORD"]), timeout=120)
    response = client.post("/api/v1/projects", json={"name": "大文件上传验收 · 随机像素"})
    response.raise_for_status()
    project_id = response.json()["id"]
    buffer = io.BytesIO()
    Image.frombytes("RGB", (3000, 2700), os.urandom(3000*2700*3)).save(buffer, format="PNG", compress_level=0)
    size = buffer.tell()
    buffer.seek(0)
    response = client.post("/api/v1/files", params={"project_id": project_id}, files={"file": ("24MB-noise-test.png", buffer, "image/png")})
    response.raise_for_status()
    file_id = response.json()["id"]
    client.post(f"/api/v1/files/{file_id}/role", params={"project_id": project_id, "role": "excluded"}).raise_for_status()
    for _ in range(90):
        files = client.get("/api/v1/files", params={"project_id": project_id}).json()
        item = next(item for item in files if item["id"] == file_id)
        if item["processing_status"] == "failed":
            raise RuntimeError(item["processing_error"])
        if item["processing_status"] == "ready":
            preview = client.get(f"/api/v1/files/{file_id}/pages/1", params={"project_id": project_id})
            preview.raise_for_status()
            print({"bytes": size, "upload_status": response.status_code, "parse": "ready", "preview": preview.status_code})
            return
        time.sleep(1)
    raise RuntimeError("Parse timeout")


if __name__ == "__main__":
    main()
