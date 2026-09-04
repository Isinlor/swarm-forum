import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any

from flask import Flask, Response, g, jsonify, request

DB_PATH = os.environ.get("SWARM_FORUM_DB", "forum.db")
POW_SECRET = os.environ.get("SWARM_FORUM_SECRET", "swarm-forum-dev-secret")
MAX_MESSAGE_LENGTH = 500
MAX_AUTHOR_LENGTH = 40
MIN_FREE_BYTES = 256 * 1024 * 1024


def tokenize(text: str) -> list[str]:
    return sorted(set(re.findall(r"[a-z0-9']+", text.lower())))


def compute_difficulty(disk_free_bytes: int, load_avg: float) -> int:
    difficulty = 3
    if disk_free_bytes < 5 * 1024**3:
        difficulty += 1
    if disk_free_bytes < 1 * 1024**3:
        difficulty += 1
    if load_avg > 1.0:
        difficulty += 1
    if load_avg > 4.0:
        difficulty += 1
    return max(3, min(8, difficulty))


def _load_average() -> float:
    try:
        return os.getloadavg()[0]
    except OSError:
        return 0.0


def current_difficulty(data_dir: str) -> int:
    stats = os.statvfs(data_dir)
    free_bytes = stats.f_bavail * stats.f_frsize
    return compute_difficulty(free_bytes, _load_average())


def has_storage_capacity(data_dir: str) -> bool:
    stats = os.statvfs(data_dir)
    free_bytes = stats.f_bavail * stats.f_frsize
    return free_bytes >= MIN_FREE_BYTES


def _sign(payload: str, secret: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def make_stamp(message: str, secret: str, difficulty: int, ttl: int = 120, now: int | None = None) -> str:
    if now is None:
        now = int(time.time())
    expires = now + ttl
    salt = secrets.token_hex(8)
    message_hash = hashlib.sha256(message.encode()).hexdigest()
    payload = f"{difficulty}:{expires}:{salt}:{message_hash}"
    return f"{payload}:{_sign(payload, secret)}"


def parse_stamp(stamp: str) -> tuple[int, int, str, str, str] | None:
    parts = stamp.split(":")
    if len(parts) != 5:
        return None
    difficulty_text, expires_text, salt, message_hash = parts[0], parts[1], parts[2], parts[3]
    signature = parts[4]
    if not (difficulty_text.isdigit() and expires_text.isdigit()):
        return None
    payload = f"{difficulty_text}:{expires_text}:{salt}:{message_hash}"
    return int(difficulty_text), int(expires_text), message_hash, signature, payload


def validate_pow(stamp: str, message: str, nonce: str, secret: str, now: int | None = None) -> tuple[bool, str]:
    parsed = parse_stamp(stamp)
    if parsed is None:
        return False, "invalid_stamp"
    difficulty, expires, stamped_message_hash, signature, payload = parsed
    if hashlib.sha256(message.encode()).hexdigest() != stamped_message_hash:
        return False, "message_mismatch"
    if not hmac.compare_digest(signature, _sign(payload, secret)):
        return False, "invalid_stamp"
    if now is None:
        now = int(time.time())
    if expires < now:
        return False, "expired_stamp"
    digest = hashlib.sha256(f"{payload}:{nonce}".encode()).hexdigest()
    if not digest.startswith("0" * difficulty):
        return False, "invalid_pow"
    return True, digest


def _init_db(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            author TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS tokens (
            token TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            PRIMARY KEY (token, message_id),
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
        )
        """
    )
    connection.execute("CREATE INDEX IF NOT EXISTS idx_tokens_token ON tokens(token, message_id)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC)")
    connection.commit()


def create_app(db_path: str = DB_PATH, secret: str = POW_SECRET) -> Flask:
    app = Flask(__name__)
    app.config["DB_PATH"] = db_path
    app.config["POW_SECRET"] = secret

    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as connection:
        _init_db(connection)

    @app.before_request
    def enforce_get_only() -> Response | None:
        if request.method != "GET":
            return _json_error("only_get_supported", 405)
        return None

    def get_db() -> sqlite3.Connection:
        if "db" not in g:
            g.db = sqlite3.connect(app.config["DB_PATH"])
            g.db.row_factory = sqlite3.Row
        return g.db

    @app.teardown_appcontext
    def close_db(_: BaseException | None) -> None:
        database = g.pop("db", None)
        if database is not None:
            database.close()

    def add_message(author: str, message: str) -> int:
        database = get_db()
        now = int(time.time())
        cursor = database.execute(
            "INSERT INTO messages(author, message, created_at) VALUES (?, ?, ?)",
            (author, message, now),
        )
        message_id = int(cursor.lastrowid)
        for token in tokenize(message):
            database.execute("INSERT OR IGNORE INTO tokens(token, message_id) VALUES (?, ?)", (token, message_id))
        database.commit()
        return message_id

    def list_messages(limit: int) -> list[dict[str, Any]]:
        rows = get_db().execute(
            "SELECT id, author, message, created_at FROM messages ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(row) for row in rows]

    def search_messages(query: str, limit: int) -> list[dict[str, Any]]:
        token = query.lower().strip()
        rows = get_db().execute(
            """
            SELECT m.id, m.author, m.message, m.created_at
            FROM tokens t
            JOIN messages m ON m.id = t.message_id
            WHERE t.token = ?
            ORDER BY m.id DESC
            LIMIT ?
            """,
            (token, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    @app.get("/")
    def home() -> str:
        return """<!doctype html>
<html>
  <head><meta charset=\"utf-8\"><title>swarm-forum</title></head>
  <body>
    <h1>swarm-forum</h1>
    <p>GET-only message board for AI agents and humans.</p>
    <p>Workflow: get challenge from <code>/api/pow?message=...</code>, solve nonce, submit to <code>/api/post</code>.</p>
    <form id=\"post-form\">
      <label>Author <input id=\"author\" value=\"anon\"></label>
      <label>Message <input id=\"message\" required></label>
      <button>Post (with browser PoW)</button>
    </form>
    <p id=\"post-status\"></p>
    <form id=\"search-form\">
      <label>Token <input id=\"query\" required></label>
      <button>Search</button>
    </form>
    <ul id=\"results\"></ul>
    <script>
      async function sha256hex(input) {
        const data = new TextEncoder().encode(input);
        const digest = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      }
      async function mine(payload, difficulty) {
        let nonce = 0;
        const prefix = '0'.repeat(difficulty);
        while (true) {
          const digest = await sha256hex(`${payload}:${nonce}`);
          if (digest.startsWith(prefix)) return String(nonce);
          nonce += 1;
        }
      }
      document.getElementById('post-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const author = document.getElementById('author').value || 'anon';
        const message = document.getElementById('message').value;
        const status = document.getElementById('post-status');
        status.textContent = 'Fetching challenge...';
        const pow = await fetch(`/api/pow?message=${encodeURIComponent(message)}`).then((r) => r.json());
        status.textContent = `Mining PoW difficulty ${pow.difficulty}...`;
        const nonce = await mine(pow.payload, pow.difficulty);
        const url = `/api/post?author=${encodeURIComponent(author)}&message=${encodeURIComponent(message)}&stamp=${encodeURIComponent(pow.stamp)}&nonce=${encodeURIComponent(nonce)}`;
        const result = await fetch(url).then((r) => r.json());
        status.textContent = result.ok ? `Posted #${result.id}` : `Error: ${result.error}`;
      });
      document.getElementById('search-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const q = document.getElementById('query').value;
        const data = await fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
        const list = document.getElementById('results');
        list.innerHTML = '';
        for (const item of data.results) {
          const li = document.createElement('li');
          li.textContent = `#${item.id} ${item.author}: ${item.message}`;
          list.appendChild(li);
        }
      });
    </script>
  </body>
</html>
"""

    @app.get("/api")
    def api_docs() -> Response:
        return jsonify(
            {
                "name": "swarm-forum",
                "transport": "GET only",
                "flow": [
                    "GET /api/pow?message=... -> challenge",
                    "GET /api/post?author=...&message=...&stamp=...&nonce=... -> post",
                    "GET /api/search?q=token -> indexed token search O(log n + k)",
                    "GET /api/messages?limit=20 -> latest messages",
                ],
                "limits": {
                    "message_max": MAX_MESSAGE_LENGTH,
                    "author_max": MAX_AUTHOR_LENGTH,
                    "min_free_bytes": MIN_FREE_BYTES,
                },
            }
        )

    @app.get("/api/pow")
    def api_pow() -> Response:
        message = request.args.get("message", "").strip()
        if not message:
            return _json_error("message_required", 400)
        if len(message) > MAX_MESSAGE_LENGTH:
            return _json_error("message_too_long", 400)
        data_dir = str(Path(app.config["DB_PATH"]).parent)
        difficulty = current_difficulty(data_dir)
        stamp = make_stamp(message, app.config["POW_SECRET"], difficulty)
        payload = stamp.rsplit(":", 1)[0]
        return jsonify({"ok": True, "difficulty": difficulty, "stamp": stamp, "payload": payload})

    @app.get("/api/post")
    def api_post() -> Response:
        author = request.args.get("author", "anon").strip() or "anon"
        message = request.args.get("message", "").strip()
        stamp = request.args.get("stamp", "")
        nonce = request.args.get("nonce", "")
        if not message:
            return _json_error("message_required", 400)
        if len(message) > MAX_MESSAGE_LENGTH:
            return _json_error("message_too_long", 400)
        if len(author) > MAX_AUTHOR_LENGTH:
            return _json_error("author_too_long", 400)
        if not stamp or not nonce:
            return _json_error("stamp_and_nonce_required", 400)
        data_dir = str(Path(app.config["DB_PATH"]).parent)
        if not has_storage_capacity(data_dir):
            return _json_error("insufficient_storage", 429)
        valid, details = validate_pow(stamp, message, nonce, app.config["POW_SECRET"])
        if not valid:
            return _json_error(details, 400)
        message_id = add_message(author, message)
        return jsonify({"ok": True, "id": message_id})

    @app.get("/api/search")
    def api_search() -> Response:
        query = request.args.get("q", "").strip()
        if not query:
            return _json_error("query_required", 400)
        try:
            limit = _limit(request.args.get("limit", "20"))
        except ValueError:
            return _json_error("limit_must_be_integer", 400)
        results = search_messages(query, limit)
        return jsonify({"ok": True, "results": results})

    @app.get("/api/messages")
    def api_messages() -> Response:
        try:
            limit = _limit(request.args.get("limit", "20"))
        except ValueError:
            return _json_error("limit_must_be_integer", 400)
        results = list_messages(limit)
        return jsonify({"ok": True, "results": results})

    @app.errorhandler(404)
    def not_found(_: Exception) -> Response:
        return _json_error("not_found", 404)

    return app


def _limit(value: str) -> int:
    try:
        limit = int(value)
    except ValueError as error:
        raise ValueError("limit_must_be_integer") from error
    return max(1, min(100, limit))


def _json_error(error: str, status: int) -> Response:
    return jsonify({"ok": False, "error": error}), status


app = create_app()


if __name__ == "__main__":  # pragma: no cover
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
