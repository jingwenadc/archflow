from typing import Literal

from pydantic import BaseModel


class CapabilitySet(BaseModel):
    release: str
    file_upload: bool
    chat: bool
    generation: bool
    workflow_engine: Literal["tbd"]


class FileRecord(BaseModel):
    id: str
    name: str
    size: int
    content_type: str
    status: Literal["uploaded"]


class SkillSummary(BaseModel):
    slug: str
    name: str
    module: str
    status: Literal["available"]
    source_path: str
