"""Individual accounts, server-side sessions, and project membership.

The optional rollout flag leaves existing installations readable until the owner
sets a signup secret and bootstraps an administrator. Once enabled, every API
request is authenticated independently of the outer Nginx password.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator
from uuid import uuid4

from fastapi import HTTPException, Request, Response


COOKIE = "archflow_session"
CSRF_COOKIE = "archflow_csrf"
SESSION_SECONDS = 7 * 24 * 60 * 60
ATTEMPT_WINDOW = 15 * 60
_principal: ContextVar["Principal | None"] = ContextVar("archflow_principal", default=None)
_kdf_slots = threading.BoundedSemaphore(2)


def _scrypt(password: bytes, salt: bytes, n: int = 2**17, r: int = 8, p: int = 1) -> bytes:
    # Limit peak memory on a small 4 GB server during concurrent sign-ins.
    if not _kdf_slots.acquire(timeout=10):
        raise HTTPException(503, "Authentication is busy. Try again shortly.")
    try:
        return hashlib.scrypt(password, salt=salt, n=n, r=r, p=p, maxmem=256 * 1024 * 1024)
    finally:
        _kdf_slots.release()


@dataclass(frozen=True)
class Principal:
    id: str
    username: str
    role: str


def current_principal() -> Principal | None:
    return _principal.get()


def set_principal(principal: Principal | None):
    return _principal.set(principal)


def reset_principal(token) -> None:
    _principal.reset(token)


def require_admin() -> Principal:
    principal = current_principal()
    if principal is None or principal.role != "admin":
        raise HTTPException(403, "Administrator access required.")
    return principal


def authorize_project(db: sqlite3.Connection, project_id: str) -> None:
    principal = current_principal()
    if principal is None or principal.role in {"admin", "worker"}:
        return  # Legacy mode, administrator, or authenticated internal worker.
    row = db.execute(
        "SELECT 1 FROM project_members WHERE project_id=? AND user_id=?",
        (project_id, principal.id),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Project not found.")


class AuthStore:
    def __init__(self, database_path: Path, signup_code: str | None, secure_cookies: bool):
        self.path = database_path
        self.signup_code = signup_code
        self.secure_cookies = secure_cookies
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','admin')),
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS project_members (
                    project_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
                    role TEXT NOT NULL CHECK(role IN ('owner','member')),
                    created_at INTEGER NOT NULL, PRIMARY KEY(project_id,user_id)
                );
                CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members(user_id,project_id);
                CREATE TABLE IF NOT EXISTS user_sessions (
                    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id,expires_at);
                CREATE TABLE IF NOT EXISTS auth_attempts (
                    key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_start INTEGER NOT NULL
                );
            """)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=5000")
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def hash_password(password: str) -> str:
        if not 12 <= len(password) <= 256:
            raise HTTPException(422, "Password must contain 12–256 characters.")
        salt = secrets.token_bytes(16)
        digest = _scrypt(password.encode(), salt)
        return f"scrypt:17:8:1:{salt.hex()}:{digest.hex()}"

    @staticmethod
    def verify_password(password: str, stored: str) -> bool:
        try:
            _, power, r, p, salt, digest = stored.split(":")
            actual = _scrypt(password.encode(), bytes.fromhex(salt), n=2**int(power), r=int(r), p=int(p))
            return hmac.compare_digest(actual, bytes.fromhex(digest))
        except (ValueError, MemoryError):
            return False

    def _attempt(self, key: str, success: bool | None = None) -> None:
        now = int(time.time())
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT attempts,window_start FROM auth_attempts WHERE key=?", (key,)).fetchone()
            if success is None:
                if row and row["attempts"] >= 8 and now - row["window_start"] < ATTEMPT_WINDOW:
                    raise HTTPException(429, "Too many attempts. Try again later.")
            elif success:
                db.execute("DELETE FROM auth_attempts WHERE key=?", (key,))
            elif row and now - row["window_start"] < ATTEMPT_WINDOW:
                db.execute("UPDATE auth_attempts SET attempts=attempts+1 WHERE key=?", (key,))
            else:
                db.execute("INSERT OR REPLACE INTO auth_attempts VALUES(?,?,?)", (key, 1, now))

    def create_user(self, username: str, password: str, signup_code: str, role: str = "user") -> Principal:
        username = username.strip().lower()
        if not 3 <= len(username) <= 64 or not all(ch.isascii() and (ch.isalnum() or ch in "_-.") for ch in username):
            raise HTTPException(422, "Use a 3–64 character username containing letters, digits, _, -, or .")
        if role != "admin":
            key = "signup:" + hashlib.sha256(username.encode()).hexdigest()
            self._attempt(key)
            if not self.signup_code or not hmac.compare_digest(signup_code, self.signup_code):
                self._attempt(key, False)
                raise HTTPException(403, "Invalid signup code.")
            self._attempt(key, True)
        password_hash = self.hash_password(password)
        principal = Principal(str(uuid4()), username, role)
        with self.connect() as db:
            try:
                db.execute("INSERT INTO users VALUES(?,?,?,?,?)", (principal.id, username, password_hash, role, int(time.time())))
            except sqlite3.IntegrityError as error:
                raise HTTPException(409, "Username already exists.") from error
        return principal

    def authenticate(self, username: str, password: str) -> Principal:
        key = "login:" + hashlib.sha256(username.strip().lower().encode()).hexdigest()
        self._attempt(key)
        with self.connect() as db:
            row = db.execute("SELECT * FROM users WHERE username=?", (username.strip().lower(),)).fetchone()
        # Do equivalent KDF work for unknown usernames to reduce enumeration.
        if row is None:
            _scrypt(password.encode(), b"archflow-no-user")
        if row is None or not self.verify_password(password, row["password_hash"]):
            self._attempt(key, False)
            raise HTTPException(401, "Invalid username or password.")
        self._attempt(key, True)
        return Principal(row["id"], row["username"], row["role"])

    def issue_session(self, response: Response, principal: Principal) -> None:
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        now = int(time.time())
        with self.connect() as db:
            db.execute("DELETE FROM user_sessions WHERE expires_at<?", (now,))
            db.execute("INSERT INTO user_sessions VALUES(?,?,?,?,?)",
                       (hashlib.sha256(token.encode()).hexdigest(), principal.id,
                        hashlib.sha256(csrf.encode()).hexdigest(), now + SESSION_SECONDS, now))
        for name, value, http_only in ((COOKIE, token, True), (CSRF_COOKIE, csrf, False)):
            response.set_cookie(name, value, max_age=SESSION_SECONDS, httponly=http_only,
                                secure=self.secure_cookies, samesite="lax", path="/")

    def session(self, request: Request, require_csrf: bool = True) -> Principal:
        token = request.cookies.get(COOKIE)
        if not token:
            raise HTTPException(401, "Sign in required.")
        with self.connect() as db:
            row = db.execute("SELECT u.*,s.csrf_hash FROM user_sessions s JOIN users u ON u.id=s.user_id "
                             "WHERE s.token_hash=? AND s.expires_at>?",
                             (hashlib.sha256(token.encode()).hexdigest(), int(time.time()))).fetchone()
        if row is None:
            raise HTTPException(401, "Session expired. Sign in again.")
        if require_csrf and request.method not in {"GET", "HEAD", "OPTIONS"}:
            csrf = request.headers.get("x-csrf-token", "")
            cookie = request.cookies.get(CSRF_COOKIE, "")
            if not csrf or not hmac.compare_digest(csrf, cookie) or not hmac.compare_digest(
                hashlib.sha256(csrf.encode()).hexdigest(), row["csrf_hash"]
            ):
                raise HTTPException(403, "Invalid CSRF token.")
        return Principal(row["id"], row["username"], row["role"])

    def logout(self, request: Request, response: Response) -> None:
        token = request.cookies.get(COOKIE)
        if token:
            with self.connect() as db:
                db.execute("DELETE FROM user_sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
        response.delete_cookie(COOKIE, path="/")
        response.delete_cookie(CSRF_COOKIE, path="/")

    def add_owner(self, project_id: str, user_id: str) -> None:
        with self.connect() as db:
            db.execute("INSERT INTO project_members VALUES(?,?,?,?)",
                       (project_id, user_id, "owner", int(time.time())))

    def list_project_ids(self, user_id: str) -> set[str]:
        with self.connect() as db:
            return {row[0] for row in db.execute("SELECT project_id FROM project_members WHERE user_id=?", (user_id,))}
