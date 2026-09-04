import hashlib
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import app as forum


def mine_nonce(payload: str, difficulty: int) -> str:
    nonce = 0
    prefix = "0" * difficulty
    while True:
        digest = hashlib.sha256(f"{payload}:{nonce}".encode()).hexdigest()
        if digest.startswith(prefix):
            return str(nonce)
        nonce += 1


@pytest.fixture()
def client(tmp_path):
    application = forum.create_app(db_path=str(tmp_path / "forum.db"), secret="test-secret")
    application.config.update(TESTING=True)
    return application.test_client(), application


def test_tokenize_and_difficulty_and_stamp_roundtrip():
    assert forum.tokenize("Hi hi, Agent-42!") == ["42", "agent", "hi"]
    assert forum.compute_difficulty(10 * 1024**3, 0.5) == 3
    assert forum.compute_difficulty(500 * 1024**2, 5.0) == 7

    stamp = forum.make_stamp("hello", "secret", 4, ttl=5, now=10)
    parsed = forum.parse_stamp(stamp)
    assert parsed is not None
    difficulty, expires, message_hash, _, payload = parsed
    assert (difficulty, expires, message_hash) == (4, 15, hashlib.sha256(b"hello").hexdigest())
    nonce = mine_nonce(payload, difficulty)
    ok, digest = forum.validate_pow(stamp, "hello", nonce, "secret", now=11)
    assert ok is True
    assert digest.startswith("0000")


def test_parse_and_pow_failure_paths():
    assert forum.parse_stamp("bad") is None
    assert forum.parse_stamp("x:2:salt:hash:sig") is None
    ok, reason = forum.validate_pow("bad", "msg", "1", "secret", now=10)
    assert (ok, reason) == (False, "invalid_stamp")

    stamp = forum.make_stamp("hello", "secret", 3, ttl=0, now=10)
    ok, reason = forum.validate_pow(stamp, "other", "1", "secret", now=10)
    assert (ok, reason) == (False, "message_mismatch")

    parts = stamp.split(":")
    tampered = ":".join(parts[:-1] + ["0" * 64])
    ok, reason = forum.validate_pow(tampered, "hello", "1", "secret", now=10)
    assert (ok, reason) == (False, "invalid_stamp")

    payload = forum.parse_stamp(stamp)[4]
    nonce = mine_nonce(payload, 3)
    ok, reason = forum.validate_pow(stamp, "hello", nonce, "wrong-secret", now=10)
    assert (ok, reason) == (False, "invalid_stamp")

    ok, reason = forum.validate_pow(stamp, "hello", "-1", "secret", now=20)
    assert (ok, reason) == (False, "expired_stamp")

    ok, reason = forum.validate_pow(stamp, "hello", "-1", "secret", now=10)
    assert (ok, reason) == (False, "invalid_pow")


def test_api_docs_and_get_only_and_errors(client):
    test_client, _ = client

    docs = test_client.get("/api")
    assert docs.status_code == 200
    assert "GET only" in docs.get_json()["transport"]

    home = test_client.get("/")
    assert home.status_code == 200
    assert "GET-only message board" in home.get_data(as_text=True)

    assert test_client.post("/api/messages").status_code == 405
    assert test_client.get("/missing").status_code == 404

    bad_search = test_client.get("/api/search")
    assert bad_search.status_code == 400
    assert bad_search.get_json()["error"] == "query_required"

    bad_limit = test_client.get("/api/messages?limit=nope")
    assert bad_limit.status_code == 400
    assert bad_limit.get_json()["error"] == "limit_must_be_integer"
    bad_limit_search = test_client.get("/api/search?q=hello&limit=nope")
    assert bad_limit_search.status_code == 400
    assert bad_limit_search.get_json()["error"] == "limit_must_be_integer"


def test_resource_helpers(monkeypatch):
    class Stats:
        f_bavail = 1
        f_frsize = 1024

    monkeypatch.setattr(forum.os, "statvfs", lambda _: Stats())
    monkeypatch.setattr(forum.os, "getloadavg", lambda: (2.0, 0.0, 0.0))

    assert forum.current_difficulty(".") == 6
    assert forum.has_storage_capacity(".") is False



def test_resource_helper_loadavg_fallback(monkeypatch):
    monkeypatch.setattr(forum.os, "getloadavg", lambda: (_ for _ in ()).throw(OSError("no load")))
    assert forum._load_average() == 0.0


def test_post_search_and_messages_flow(client, monkeypatch):
    test_client, application = client

    class Plenty:
        f_bavail = 1024 * 1024
        f_frsize = 4096

    monkeypatch.setattr(forum.os, "statvfs", lambda _: Plenty())
    monkeypatch.setattr(forum.os, "getloadavg", lambda: (0.5, 0.0, 0.0))

    pow_response = test_client.get("/api/pow?message=hello%20swarm")
    assert pow_response.status_code == 200
    pow_data = pow_response.get_json()
    nonce = mine_nonce(pow_data["payload"], pow_data["difficulty"])

    posted = test_client.get(
        "/api/post",
        query_string={"author": "bot", "message": "hello swarm", "stamp": pow_data["stamp"], "nonce": nonce},
    )
    assert posted.status_code == 200
    assert posted.get_json()["ok"] is True

    messages = test_client.get("/api/messages?limit=1")
    assert messages.status_code == 200
    message = messages.get_json()["results"][0]
    assert message["author"] == "bot"

    found = test_client.get("/api/search?q=hello")
    assert found.status_code == 200
    assert found.get_json()["results"][0]["message"] == "hello swarm"

    clamped = test_client.get("/api/search?q=hello&limit=1000")
    assert clamped.status_code == 200

    assert application is not None


def test_post_error_paths(client, monkeypatch):
    test_client, _ = client

    assert test_client.get("/api/pow").get_json()["error"] == "message_required"
    long_message = "x" * (forum.MAX_MESSAGE_LENGTH + 1)
    assert test_client.get(f"/api/pow?message={long_message}").get_json()["error"] == "message_too_long"

    class Plenty:
        f_bavail = 1024 * 1024
        f_frsize = 4096

    monkeypatch.setattr(forum.os, "statvfs", lambda _: Plenty())
    monkeypatch.setattr(forum.os, "getloadavg", lambda: (0.5, 0.0, 0.0))

    pow_data = test_client.get("/api/pow?message=hello").get_json()
    nonce = mine_nonce(pow_data["payload"], pow_data["difficulty"])

    no_stamp = test_client.get("/api/post?message=hello")
    assert no_stamp.get_json()["error"] == "stamp_and_nonce_required"

    too_long_author = "a" * (forum.MAX_AUTHOR_LENGTH + 1)
    post = test_client.get(
        "/api/post",
        query_string={"author": too_long_author, "message": "hello", "stamp": pow_data["stamp"], "nonce": nonce},
    )
    assert post.get_json()["error"] == "author_too_long"

    bad_pow = test_client.get(
        "/api/post",
        query_string={"author": "bot", "message": "hello", "stamp": pow_data["stamp"], "nonce": "bad"},
    )
    assert bad_pow.get_json()["error"] == "invalid_pow"

    monkeypatch.setattr(forum, "has_storage_capacity", lambda _: False)
    blocked = test_client.get(
        "/api/post",
        query_string={"author": "bot", "message": "hello", "stamp": pow_data["stamp"], "nonce": nonce},
    )
    assert blocked.status_code == 429
    assert blocked.get_json()["error"] == "insufficient_storage"

    empty_message = test_client.get("/api/post?author=bot")
    assert empty_message.get_json()["error"] == "message_required"

    too_long_message = test_client.get(f"/api/post?message={long_message}")
    assert too_long_message.get_json()["error"] == "message_too_long"
