import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, status

from .models import ConversationCreate, ConversationRecord, MessageCreate, MessageRecord

SCHEMA_VERSION = 1


class ConversationRepository:
    """SQLite development adapter with a stable API boundary for PostgreSQL later."""

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            current_version = connection.execute("PRAGMA user_version").fetchone()[0]
            if current_version > SCHEMA_VERSION:
                raise RuntimeError("Conversation database schema is newer than this API version.")
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, module TEXT NOT NULL,
                    title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
                );
                CREATE INDEX IF NOT EXISTS messages_conversation_idx
                    ON messages(conversation_id, created_at);
                CREATE INDEX IF NOT EXISTS conversations_project_module_idx
                    ON conversations(project_id, module, updated_at DESC);
                PRAGMA user_version = 1;
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def list_conversations(self, project_id: str, module: str) -> list[ConversationRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM conversations WHERE project_id = ? AND module = ? ORDER BY updated_at DESC, id ASC",
                (project_id, module),
            ).fetchall()
        return [ConversationRecord(**dict(row)) for row in rows]

    def create(self, request: ConversationCreate) -> ConversationRecord:
        now = datetime.now(UTC).isoformat()
        record = ConversationRecord(
            id=str(uuid4()), project_id=request.project_id, module=request.module,
            title=request.title, created_at=now, updated_at=now,
        )
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO conversations (id, project_id, module, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (record.id, record.project_id, record.module, record.title, record.created_at, record.updated_at),
            )
        return record

    def list_messages(self, conversation_id: str) -> list[MessageRecord]:
        with self._connect() as connection:
            self._require_conversation(connection, conversation_id)
            rows = connection.execute(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
                (conversation_id,),
            ).fetchall()
        return [MessageRecord(**dict(row)) for row in rows]

    def add_message(self, conversation_id: str, request: MessageCreate) -> MessageRecord:
        now = datetime.now(UTC).isoformat()
        with self._connect() as connection:
            self._require_conversation(connection, conversation_id)
            record = MessageRecord(
                id=str(uuid4()), conversation_id=conversation_id, role="user",
                content=request.content, created_at=now,
            )
            connection.execute(
                "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
                (record.id, record.conversation_id, record.role, record.content, record.created_at),
            )
            connection.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id))
        return record

    @staticmethod
    def _require_conversation(connection: sqlite3.Connection, conversation_id: str) -> None:
        if connection.execute("SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)).fetchone() is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found.")
