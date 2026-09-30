import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4, uuid5, NAMESPACE_URL

from fastapi import HTTPException, status

from .models import ConversationCreate, ConversationRecord, MessageCreate, MessageRecord, TrashedConversation

SCHEMA_VERSION = 2


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
                """
            )
            connection.execute("BEGIN IMMEDIATE")
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(conversations)")}
            if "deleted_at" not in columns:
                connection.execute("ALTER TABLE conversations ADD COLUMN deleted_at TEXT")
            connection.execute("PRAGMA user_version = 2")

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
                "SELECT * FROM conversations WHERE project_id = ? AND module = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id ASC",
                (project_id, module),
            ).fetchall()
        return [ConversationRecord(**dict(row)) for row in rows]

    def list_deleted(self, project_id: str) -> list[TrashedConversation]:
        """A project-wide view of recoverable chats and their generation history."""
        with self._connect() as connection:
            has_jobs = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_jobs'").fetchone()
            count = "(SELECT COUNT(*) FROM generation_jobs j WHERE j.conversation_id=c.id)" if has_jobs else "0"
            rows = connection.execute(
                f"SELECT c.*, {count} AS generation_count FROM conversations c "
                "WHERE c.project_id=? AND c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC, c.id DESC",
                (project_id,),
            ).fetchall()
        return [TrashedConversation(**dict(row)) for row in rows]

    def restore(self, conversation_id: str, project_id: str) -> ConversationRecord:
        """Restore the chat and saved outputs; cancelled work stays cancelled."""
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM conversations WHERE id=? AND project_id=?", (conversation_id, project_id)
            ).fetchone()
            if row is None or row["deleted_at"] is None:
                raise HTTPException(404, "Conversation not found in this project's trash.")
            connection.execute("UPDATE conversations SET deleted_at=NULL WHERE id=?", (conversation_id,))
        return ConversationRecord(**dict(row))

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

    def delete(self, conversation_id: str, project_id: str) -> None:
        """Remove a tab durably and cancel unfinished jobs in the same transaction.

        Keep messages and finished artifacts for recovery; never remove project files.
        """
        now = datetime.now(UTC).isoformat()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT deleted_at FROM conversations WHERE id=? AND project_id=?",
                                     (conversation_id, project_id)).fetchone()
            if row is None:
                raise HTTPException(404, "Conversation not found in this project.")
            if row["deleted_at"]:
                return
            connection.execute("UPDATE conversations SET deleted_at=?,updated_at=? WHERE id=?", (now, now, conversation_id))
            if connection.execute("SELECT 1 FROM sqlite_master WHERE name='generation_jobs'").fetchone():
                unfinished = "conversation_id=? AND status IN ('queued','running','waiting_outline','waiting_storyboard','waiting_review','failed')"
                connection.execute(
                    f"INSERT INTO generation_events(job_id,event_type,message,created_at) SELECT id,'cancel',?,? FROM generation_jobs WHERE {unfinished}",
                    ("对话已删除，未完成任务已取消；已保存内容保留。", now, conversation_id),
                )
                connection.execute(
                    f"UPDATE generation_jobs SET status='cancelled',lease_id=NULL,lease_until=NULL,updated_at=? WHERE {unfinished}",
                    (now, conversation_id),
                )

    @staticmethod
    def _require_conversation(connection: sqlite3.Connection, conversation_id: str) -> None:
        if connection.execute("SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NULL", (conversation_id,)).fetchone() is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found.")
