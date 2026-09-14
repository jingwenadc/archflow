import secrets
from datetime import UTC, datetime

import httpx
from fastapi import HTTPException, status

from .models import DraftPullRequestResult


class GitHubDraftPullRequests:
    def __init__(self, repository: str, base_branch: str, token: str | None) -> None:
        self.repository = repository
        self.base_branch = base_branch
        self.token = token

    async def create(
        self,
        *,
        slug: str,
        title: str,
        description: str,
        changes: list[tuple[str, str]],
    ) -> DraftPullRequestResult:
        if not self.token:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="GitHub integration is not configured. Add a GitHub App installation token to enable Draft PR creation.",
            )
        if not changes:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="No file changes were submitted.")

        timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        branch = f"skill-edit/{slug}-{timestamp}-{secrets.token_hex(2)}"
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        base_url = f"https://api.github.com/repos/{self.repository}"

        async with httpx.AsyncClient(headers=headers, timeout=30) as client:
            base_ref = await self._request(client, "GET", f"{base_url}/git/ref/heads/{self.base_branch}")
            base_commit_sha = base_ref["object"]["sha"]
            base_commit = await self._request(client, "GET", f"{base_url}/git/commits/{base_commit_sha}")

            tree_entries = []
            for path, content in changes:
                blob = await self._request(
                    client,
                    "POST",
                    f"{base_url}/git/blobs",
                    json={"content": content, "encoding": "utf-8"},
                )
                tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})

            tree = await self._request(
                client,
                "POST",
                f"{base_url}/git/trees",
                json={"base_tree": base_commit["tree"]["sha"], "tree": tree_entries},
            )
            commit = await self._request(
                client,
                "POST",
                f"{base_url}/git/commits",
                json={"message": f"docs(skills): update {slug}", "tree": tree["sha"], "parents": [base_commit_sha]},
            )
            await self._request(
                client,
                "POST",
                f"{base_url}/git/refs",
                json={"ref": f"refs/heads/{branch}", "sha": commit["sha"]},
            )
            pull = await self._request(
                client,
                "POST",
                f"{base_url}/pulls",
                json={
                    "title": title.strip() or f"Update {slug}",
                    "head": branch,
                    "base": self.base_branch,
                    "body": description.strip() or "Drafted from the ArchFlow skill editor.",
                    "draft": True,
                },
            )

        return DraftPullRequestResult(url=pull["html_url"], number=pull["number"], branch=branch)

    @staticmethod
    async def _request(client: httpx.AsyncClient, method: str, url: str, **kwargs: object) -> dict:
        response = await client.request(method, url, **kwargs)
        if response.is_success:
            return response.json()
        detail = response.json().get("message", "GitHub request failed") if response.content else "GitHub request failed"
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"GitHub: {detail}")
