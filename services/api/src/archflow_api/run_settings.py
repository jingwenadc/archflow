"""Server-persisted workspace defaults; saving settings never starts a job."""
import sqlite3
from pathlib import Path

from .models import DEFAULT_RUN_LIMITS, RunLimits


class RunSettingsRepository:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path, timeout=5) as db:
            db.execute("CREATE TABLE IF NOT EXISTS runtime_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("INSERT OR IGNORE INTO runtime_settings VALUES ('run_limits', ?)", (DEFAULT_RUN_LIMITS.model_dump_json(),))

    def get(self) -> RunLimits:
        with sqlite3.connect(self.path, timeout=5) as db:
            payload = db.execute("SELECT value FROM runtime_settings WHERE key='run_limits'").fetchone()[0]
        return RunLimits.model_validate_json(payload)

    def save(self, limits: RunLimits) -> RunLimits:
        with sqlite3.connect(self.path, timeout=5) as db:
            db.execute("UPDATE runtime_settings SET value=? WHERE key='run_limits'", (limits.model_dump_json(),))
        return limits
