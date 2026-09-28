import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4, uuid5, NAMESPACE_URL

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

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.database_path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def get(self, conversation_id: str) -> ConversationRecord:
        with self._connect() as connection:
            self._require_conversation(connection, conversation_id)
            row = connection.execute("SELECT * FROM conversations WHERE id=?", (conversation_id,)).fetchone()
        return ConversationRecord(**dict(row))

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
        message_id = str(uuid5(NAMESPACE_URL, f"archflow:{conversation_id}:{request.client_id}")) if request.client_id else str(uuid4())
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._require_conversation(connection, conversation_id)
            existing = connection.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
            if existing:
                if existing["content"] != request.content:
                    raise HTTPException(409, "此消息重试标识已用于其他内容。")
                return MessageRecord(**dict(existing))
            record = MessageRecord(
                id=message_id, conversation_id=conversation_id, role="user",
                content=request.content, created_at=now,
            )
            connection.execute(
                "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
                (record.id, record.conversation_id, record.role, record.content, record.created_at),
            )
            connection.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id))
            title = request.content.replace("\n", " ").strip()[:24]
            connection.execute("UPDATE conversations SET title=? WHERE id=? AND title='新对话'", (title, conversation_id))
        return record

    def assistant(self, conversation_id: str, content: str, reply_to: str | None = None) -> MessageRecord:
        now = datetime.now(UTC).isoformat()
        message_id = str(uuid5(NAMESPACE_URL, f"archflow:reply:{reply_to}")) if reply_to else str(uuid4())
        record = MessageRecord(id=message_id, conversation_id=conversation_id, role="assistant", content=content, created_at=now)
        with self._connect() as connection:
            self._require_conversation(connection, conversation_id)
            connection.execute("INSERT OR IGNORE INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)",
                               (record.id, conversation_id, record.role, content, now))
        return record

    def rename(self, conversation_id: str, title: str) -> None:
        title = " ".join(title.split())
        if not title or len(title) > 120:
            raise HTTPException(422, "标题应为 1–120 个字符。")
        with self._connect() as connection:
            self._require_conversation(connection, conversation_id)
            connection.execute("UPDATE conversations SET title=? WHERE id=?", (title, conversation_id))

    @staticmethod
    def _require_conversation(connection: sqlite3.Connection, conversation_id: str) -> None:
        if connection.execute("SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)).fetchone() is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found.")
