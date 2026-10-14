"""Keep the miner's source files in sync with content actually persisted.

The files are queues/history, never knowledge on their own. A URL is completed
only after the learning engine confirms storage; searches remain revisitable.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

_LOCK = threading.RLock()
SAVED_OUTCOMES = frozenset({"NOVO", "ATUALIZADO", "EXISTE"})
SOURCE_FILES = ("update_sources.txt", "links_para_mineracao.txt", "links_concluidos.txt")


def data_directory(data_dir=None):
    base = Path(os.getenv("IANA_BASE_DIR", Path(__file__).resolve().parents[1]))
    return Path(data_dir or os.getenv("IANA_DATA_DIR", base / "data")).resolve()


def read_text(path):
    path = Path(path)
    if not path.exists():
        return ""
    for encoding in ("utf-8-sig", "latin-1"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    return ""


def source_urls(text):
    """Read URLs in non-comment lines without modifying the original text."""
    urls = []
    seen = set()
    for line in str(text or "").splitlines():
        if line.lstrip().startswith("#"):
            continue
        for value in re.findall(r'https?://[^\s<>"\']+', line, flags=re.I):
            value = value.rstrip(".,;:!?)]}")
            if value not in seen:
                seen.add(value)
                urls.append(value)
    return urls


def is_search_url(url):
    try:
        parsed = urlsplit(str(url))
        return (parsed.hostname or "").rstrip(".").lower() in {
            "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"
        } and parsed.path.rstrip("/") in {"/results", "/search"}
    except ValueError:
        return False


def content_hash(text):
    return hashlib.sha256(str(text or "").strip().encode("utf-8")).hexdigest()


def _atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def registry_lock(data_dir=None):
    """Serialize updates across threads and CLI/service processes."""
    directory = data_directory(data_dir)
    directory.mkdir(parents=True, exist_ok=True)
    with _LOCK, (directory / ".source_registry.lock").open("a+b") as handle:
        if os.name == "nt":
            import msvcrt
            handle.seek(0, os.SEEK_END)
            if not handle.tell():
                handle.write(b"\0")
                handle.flush()
            deadline = time.monotonic() + 15
            while True:
                handle.seek(0)
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("O registro de fontes está ocupado. Tente novamente.")
                    time.sleep(0.05)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield directory
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def load_state(data_dir=None):
    text = read_text(data_directory(data_dir) / "update_source_state.json")
    if not text.strip():
        return {}
    state = json.loads(text)
    if not isinstance(state, dict):
        raise ValueError("update_source_state.json deve conter um objeto; arquivo preservado.")
    return state


def completed_urls(data_dir=None):
    return set(source_urls(read_text(data_directory(data_dir) / "links_concluidos.txt")))


def file_batch_cursor(signature, data_dir=None):
    with registry_lock(data_dir) as directory:
        cursor = load_state(directory).get("__file_batch__", {})
    if not isinstance(cursor, dict) or cursor.get("signature") != signature:
        return 0
    value = cursor.get("next_index", 0)
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def save_file_batch_cursor(signature, next_index, data_dir=None):
    # Um cursor não é conclusão: todas as fontes, inclusive falhas, são revisitadas.
    with registry_lock(data_dir) as directory:
        state = load_state(directory)
        state["__file_batch__"] = {"signature": signature, "next_index": next_index}
        _atomic_write(directory / "update_source_state.json", json.dumps(state, ensure_ascii=False, indent=2) + "\n")


def ensure_update_source(url, data_dir=None):
    """Append a user-authorized source once, preserving all existing lines."""
    url = str(url or "").strip()
    if not url or any(char.isspace() for char in url) or not url.startswith(("https://", "http://")):
        raise ValueError("Informe uma URL HTTP ou HTTPS em uma única linha.")
    with registry_lock(data_dir) as directory:
        path = directory / "update_sources.txt"
        existing = read_text(path)
        if url in source_urls(existing):
            return False
        _atomic_write(path, existing + ("\n" if existing and not existing.endswith("\n") else "") + url + "\n")
    return True


def record_source_result(source_url, extracted, learned_results, *, data_dir=None):
    """Record saved documents from one extraction, never its failed siblings.

    ``learned_results`` is a list of ``{id, url, outcome}`` with the learning
    engine's raw statuses. PARECIDO is not proof that this source was stored.
    Local text has no URL and therefore never enters the completed-link file.
    Existing state entries (including legacy hashes) and queue files survive.
    """
    by_id = {}
    by_url = {}
    for outcome in learned_results or []:
        if not isinstance(outcome, dict):
            continue
        status = str(outcome.get("outcome") or outcome.get("status") or "")
        if outcome.get("id"):
            by_id[str(outcome["id"])] = status
        if outcome.get("url"):
            by_url[str(outcome["url"])] = status
    saved = {}
    for doc in (extracted or {}).get("documentos", []):
        if not isinstance(doc, dict):
            continue
        url = str(doc.get("url") or "").strip()
        status = by_id.get(str(doc.get("id", "")), by_url.get(url, ""))
        content = str(doc.get("conteudo") or "").strip()
        if status not in SAVED_OUTCOMES or not content or not url or is_search_url(url):
            continue
        try:
            parsed = urlsplit(url)
            valid = parsed.scheme in {"http", "https"} and parsed.hostname and not any(c.isspace() for c in url)
        except ValueError:
            valid = False
        if valid:
            saved[url] = content_hash(content)
    if not saved:
        return {"saved_urls": [], "updated_urls": []}
    with registry_lock(data_dir) as directory:
        state = load_state(directory)
        changed = [url for url, digest in saved.items() if state.get(url) != digest]
        state.update(saved)
        if changed:
            _atomic_write(directory / "update_source_state.json", json.dumps(state, ensure_ascii=False, indent=2) + "\n")
        completed_path = directory / "links_concluidos.txt"
        original = read_text(completed_path)
        completed = set(source_urls(original))
        additions = [url for url in saved if url not in completed]
        if additions:
            _atomic_write(completed_path, original + ("\n" if original and not original.endswith("\n") else "") + "".join(url + "\n" for url in additions))
    return {"saved_urls": list(saved), "updated_urls": changed}
