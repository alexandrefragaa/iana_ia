"""Bounded, persistent jobs connecting source extraction to the knowledge store."""
from __future__ import annotations

import importlib.util
import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

logger = logging.getLogger(__name__)
DEFAULT_YOUTUBE_SEARCH = "https://www.youtube.com/results?search_query=nuild+end+game+dbd&sp=EgIIAw%253D%253D"


def _process_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        # os.kill(pid, 0) no Windows pode encerrar o processo; consulte seu estado.
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            code = wintypes.DWORD()
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def validate_submission(data):
    if not isinstance(data, dict):
        raise ValueError("Envie um objeto JSON com a URL da fonte.")
    url = data.get("url")
    if not isinstance(url, str) or not 1 <= len(url.strip()) <= 4096:
        raise ValueError("Informe uma URL válida de até 4096 caracteres.")
    url = url.strip()
    try:
        parsed = urlparse(url)
        valid = parsed.scheme in {"http", "https"} and parsed.hostname and not parsed.username and not parsed.password
        valid = valid and not any(c.isspace() or ord(c) < 32 for c in url)
        if parsed.port not in {None, 80, 443}:
            valid = False
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("Use uma URL pública HTTP ou HTTPS, sem credenciais ou porta personalizada.")
    options = {}
    for field, default, lower, upper in (("max_videos", 5, 1, 20), ("recent_days", 7, 0, 365)):
        value = data.get(field, default)
        if isinstance(value, bool) or not isinstance(value, int) or not lower <= value <= upper:
            raise ValueError(f"{field} deve ser um número inteiro entre {lower} e {upper}.")
        options[field] = value
    return {"url": url, **options}


class KnowledgeJobs:
    def __init__(self, directory, extractor=None, learner=None, data_dir=None):
        self.path = Path(directory) / "knowledge_jobs.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.extractor = extractor
        self.learner = learner
        self.data_dir = data_dir
        self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="knowledge")
        with self._connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL, created REAL NOT NULL)")
            rows = db.execute("SELECT id, body FROM jobs WHERE status IN ('queued','running')").fetchall()
            for job_id, body in rows:
                job = json.loads(body)
                if _process_alive(job.get("owner_pid")):
                    continue
                job.update(status="failed", error="O serviço reiniciou durante a extração. Envie a fonte novamente para continuar.", finished_at=int(time.time()))
                self._write(db, job)

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _write(db, job):
        db.execute("INSERT OR REPLACE INTO jobs (id,status,body,created) VALUES (?,?,?,?)", (job["id"], job["status"], json.dumps(job, ensure_ascii=False), job["created_at"]))

    def get(self, job_id):
        with self._connect() as db:
            row = db.execute("SELECT body FROM jobs WHERE id=?", (job_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def _update(self, job_id, **changes):
        with self.lock, self._connect() as db:
            job = json.loads(db.execute("SELECT body FROM jobs WHERE id=?", (job_id,)).fetchone()[0])
            job.update(changes)
            self._write(db, job)
        return job

    def submit(self, data):
        source = validate_submission(data)
        with self.lock, self._connect() as db:
            active = db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]
            if active >= 8:
                raise RuntimeError("Há muitas fontes sendo processadas. Aguarde uma tarefa terminar.")
            job = {"id": str(uuid.uuid4()), "status": "queued", "created_at": int(time.time()), "owner_pid": os.getpid(), "source": source,
                   "document_count": 0, "learned_count": 0, "results": [], "warnings": [], "error": None}
            self._write(db, job)
        self.executor.submit(self._run, job["id"])
        return job

    def _run(self, job_id):
        self._update(job_id, status="running", started_at=int(time.time()))
        try:
            if self.extractor is None:
                from core.knowledge_sources import extract_source
                extractor = extract_source
            else:
                extractor = self.extractor
            if self.learner is None:
                from core.learning_engine import learn
                learner = learn
            else:
                learner = self.learner
            source = self.get(job_id)["source"]
            extracted = extractor(source["url"], {k: v for k, v in source.items() if k != "url"})
            results = []
            failures = False
            for item in extracted.get("itens", []):
                original = item.get("status", "ERRO")
                failures = failures or original in {"ERRO", "SEM_TRANSCRICAO"}
                reason = item.get("motivo") or item.get("reason") or item.get("mensagem") or ""
                if item.get("mensagem_audio"):
                    reason += " " + item["mensagem_audio"]
                results.append({"url": item.get("url", ""), "titulo": item.get("titulo", "Fonte"),
                                "status": "skipped" if original == "IGNORADO" else "failed" if original in {"ERRO", "SEM_TRANSCRICAO"} else "extracted",
                                "reason": reason.strip()})
            count = learned = 0
            learned_results = []
            for doc in extracted.get("documentos", []):
                try:
                    outcome = learner(titulo=doc["titulo"], conteudo=doc["conteudo"], categoria=doc.get("categoria", "web_mining"),
                                      id_documento=doc["id"], url=doc["url"], metadata=doc.get("metadata", {}))
                except Exception as problem:
                    logger.warning("Uma fonte não pôde ser salva (%s).", type(problem).__name__)
                    outcome = "ERRO"
                success = outcome in {"NOVO", "ATUALIZADO", "EXISTE", "PARECIDO"}
                learned_results.append({"id": doc.get("id"), "url": doc.get("url"), "outcome": outcome})
                count += int(success)
                learned += int(outcome in {"NOVO", "ATUALIZADO"})
                failures = failures or not success
                result = {"url": doc.get("url", ""), "titulo": doc.get("titulo", "Fonte"), "status": "existing" if outcome in {"EXISTE", "PARECIDO"} else "learned" if success else "failed",
                          "reason": "Já estava na base." if outcome == "EXISTE" else "Conteúdo salvo e disponível para consulta." if success else "Não foi possível salvar o conteúdo."}
                previous = next((r for r in results if r["url"] == result["url"]), None)
                if previous:
                    previous.update(result)
                else:
                    results.append(result)
                self._update(job_id, results=results, document_count=count, learned_count=learned)
            warnings = list(extracted.get("avisos", []))
            if count:
                try:
                    from core.source_registry import record_source_result
                    record_source_result(source["url"], extracted, learned_results, data_dir=self.data_dir)
                except Exception as problem:
                    logger.warning("Conteúdo salvo; arquivos de controle pendentes (%s).", type(problem).__name__)
                    warnings.append("O texto está salvo, mas não foi possível atualizar os arquivos de controle da mineração.")
                    failures = True
            failures = failures or extracted.get("status") in {"ERRO", "failed"}
            state = "partial" if count and failures else "failed" if failures or (not count and not results) else "completed"
            error = None
            if state == "failed":
                error = "Nenhuma fonte pôde ser aprendida. Confira os motivos abaixo e tente outro link ou verifique se as legendas estão disponíveis."
            self._update(job_id, status=state, results=results, warnings=warnings, document_count=count, learned_count=learned,
                         error=error, finished_at=int(time.time()))
        except Exception as error:
            logger.warning("Extração de conhecimento falhou (%s).", type(error).__name__)
            self._update(job_id, status="failed", error="Não foi possível extrair esta fonte. Ela pode estar bloqueada, indisponível ou sem transcrição acessível.", finished_at=int(time.time()))

    def close(self):
        self.executor.shutdown(wait=True)


_manager = None
_manager_lock = threading.Lock()


def get_jobs():
    global _manager
    with _manager_lock:
        if _manager is None:
            from core.learning_engine import path_banco
            _manager = KnowledgeJobs(path_banco)
    return _manager


def capabilities():
    from core.knowledge_sources import audio_transcription_configured
    return {"web": True, "youtube_search": bool(importlib.util.find_spec("yt_dlp")),
            "youtube_captions": bool(importlib.util.find_spec("youtube_transcript_api")),
            "asr_gemini": audio_transcription_configured(),
            "generative_model": bool(os.getenv("GEMINI_API_KEY") or os.getenv("MINHA_API_URL")),
            "default_youtube_search": DEFAULT_YOUTUBE_SEARCH}
