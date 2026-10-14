"""Memória de fontes da IANA: SQLite persistente e pesquisa lexical/semântica.

SQLite é a fonte de verdade e não exige serviços ou bibliotecas adicionais.
ChromaDB e MySQL são índices/espelhos opcionais; suas falhas não apagam fontes.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import threading
import time
import unicodedata
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional


RAG_MODE = os.getenv("IANA_RAG_MODE", "keyword").strip().lower() or "keyword"
if RAG_MODE not in {"keyword", "semantic"}:
    raise ValueError("IANA_RAG_MODE deve ser 'keyword' ou 'semantic'.")
COLLECTION_NAME = "memoria_iana"
EMBEDDING_MODEL = os.getenv(
    "IANA_EMBEDDING_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    if RAG_MODE == "semantic" else "keyword-bm25"
)
CHUNK_SIZE = max(500, int(os.getenv("IANA_CHUNK_SIZE", "3500")))
CHUNK_OVERLAP = max(0, min(int(os.getenv("IANA_CHUNK_OVERLAP", "400")), CHUNK_SIZE // 2))
SIMILARITY_LIMIT = float(os.getenv("IANA_SIMILARITY_LIMIT", "0.985"))


def obter_pasta_banco() -> Path:
    override = os.getenv("IANA_DB_PATH", "").strip()
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        base = Path(os.getenv("LOCALAPPDATA", str(Path.home())))
    else:
        base = Path(os.getenv("XDG_DATA_HOME", str(Path.home() / ".local" / "share")))
    return base / "iana_database" / "chromadb"


path_banco = obter_pasta_banco()
arquivo_fallback = path_banco / "memoria_fallback.json"
arquivo_sqlite = path_banco / "memoria.sqlite3"
_lock = threading.RLock()
_banco_inicializado = False
cliente = colecao = modelo = None
chromadb = SentenceTransformer = None
memoria_inicializada = False
modo_fallback = True
_erro_semantico = ""
_erro_migracao = ""
_erro_migracao_chroma = ""


def normalizar_texto(texto: str) -> str:
    texto = str(texto or "").replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", texto)).strip()


def hash_texto(texto: str) -> str:
    return hashlib.sha256(normalizar_texto(texto).encode("utf-8")).hexdigest()


def gerar_id_documento(texto: str) -> str:
    return "doc_" + hashlib.sha256(texto.strip().lower().encode("utf-8")).hexdigest()[:48]


def dividir_em_chunks(texto: str, tamanho: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> List[str]:
    texto = normalizar_texto(texto)
    if not texto:
        return []
    tamanho = max(500, int(tamanho))
    overlap = max(0, min(int(overlap), tamanho // 2))
    chunks = []
    inicio = 0
    while inicio < len(texto):
        fim = min(inicio + tamanho, len(texto))
        # Prefere terminar em palavras completas, sem deixar lacunas entre trechos.
        if fim < len(texto):
            quebra = texto.rfind(" ", inicio + tamanho // 2, fim)
            if quebra > inicio:
                fim = quebra
        trecho = texto[inicio:fim].strip()
        if trecho:
            chunks.append(trecho)
        if fim >= len(texto):
            break
        inicio = max(inicio + 1, fim - overlap)
    return chunks


def _carregar_fallback() -> List[Dict[str, Any]]:
    """Lê o JSON antigo somente para a migração; nunca reescreve esse arquivo."""
    if not arquivo_fallback.exists():
        return []
    with arquivo_fallback.open("r", encoding="utf-8-sig") as fh:
        dados = json.load(fh)
    if not isinstance(dados, list):
        raise ValueError("Memória JSON antiga deve conter uma lista de documentos.")
    return dados


def _abrir_conexao() -> sqlite3.Connection:
    conn = sqlite3.connect(str(arquivo_sqlite), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.create_function("document_visible", 3, _documento_visivel, deterministic=True)
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _inicializar_banco() -> None:
    global _banco_inicializado, _erro_migracao, _erro_migracao_chroma
    if _banco_inicializado:
        return
    with _lock:
        if _banco_inicializado:
            return
        path_banco.mkdir(parents=True, exist_ok=True)
        conn = _abrir_conexao()
        try:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY, titulo TEXT NOT NULL, conteudo TEXT NOT NULL,
                    categoria TEXT NOT NULL, url TEXT NOT NULL DEFAULT '',
                    content_hash TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
                    criado_em INTEGER NOT NULL, atualizado_em INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS documents_url ON documents(url);
                CREATE TABLE IF NOT EXISTS chunks (
                    id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                    chunk_index INTEGER NOT NULL, texto TEXT NOT NULL,
                    UNIQUE(doc_id, chunk_index)
                );
                CREATE INDEX IF NOT EXISTS chunks_document ON chunks(doc_id);
                CREATE TABLE IF NOT EXISTS document_aliases (
                    alias TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS engine_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """)
            conn.execute("BEGIN IMMEDIATE")
            migrado = conn.execute("SELECT value FROM engine_state WHERE key='json_imported'").fetchone()
            if not migrado:
                # A ausência do JSON não encerra a migração: um arquivo restaurado será lido depois.
                if arquivo_fallback.exists():
                    try:
                        documentos_antigos = _carregar_fallback()
                    except (OSError, ValueError) as exc:
                        # O arquivo original permanece intacto para correção/restauração.
                        _erro_migracao = str(exc)
                        sys.stderr.write(f"[learning_engine] JSON antigo não importado: {exc}\n")
                        documentos_antigos = []
                    for item in documentos_antigos:
                        if not isinstance(item, dict):
                            continue
                        conteudo = normalizar_texto(item.get("conteudo", ""))
                        if not conteudo:
                            continue
                        # O formato antigo embrulhava conteúdo com cabeçalho.
                        if conteudo.startswith("TÍTULO:") and "\nCONTEÚDO:\n" in conteudo:
                            conteudo = conteudo.split("\nCONTEÚDO:\n", 1)[1]
                        titulo = normalizar_texto(item.get("titulo", "")) or "Documento sem título"
                        url = str(item.get("url", "") or "").strip()
                        doc_id = str(item.get("id", "") or gerar_id_documento(url or titulo))
                        existente = conn.execute("SELECT id FROM documents WHERE id=?", (doc_id,)).fetchone()
                        if existente:
                            continue
                        try:
                            timestamp = int(item.get("atualizado_em", 0) or time.time())
                        except (ValueError, TypeError):
                            timestamp = int(time.time())
                        metadata = item.get("metadata", {})
                        if not isinstance(metadata, dict):
                            metadata = {}
                        metadata = {**metadata, "imported_from": "memoria_fallback.json"}
                        conn.execute(
                            "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            (doc_id, titulo, conteudo, normalizar_texto(item.get("categoria", "geral")),
                             url, hash_texto(conteudo), _metadata_json(metadata), timestamp, timestamp)
                        )
                        _substituir_chunks(conn, doc_id, conteudo)
                    if not _erro_migracao:
                        conn.execute("INSERT INTO engine_state VALUES ('json_imported', ?)", (str(int(time.time())),))
            chroma_arquivo = path_banco / "chroma.sqlite3"
            if chroma_arquivo.exists() and not conn.execute(
                "SELECT 1 FROM engine_state WHERE key='chroma_imported'"
            ).fetchone():
                conn.execute("SAVEPOINT legacy_chroma_import")
                try:
                    # Apenas leitura do armazenamento original, sem Chroma/torch/modelos.
                    dados_chroma = _carregar_chroma_sqlite(chroma_arquivo)
                    _importar_dados_chroma(conn, dados_chroma)
                except (OSError, ValueError, sqlite3.Error) as exc:
                    conn.execute("ROLLBACK TO SAVEPOINT legacy_chroma_import")
                    _erro_migracao_chroma = str(exc)
                    sys.stderr.write(f"[learning_engine] Memória Chroma antiga ainda não importada: {exc}\n")
                finally:
                    conn.execute("RELEASE SAVEPOINT legacy_chroma_import")
            conn.commit()
            _banco_inicializado = True
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


@contextmanager
def _conn():
    _inicializar_banco()
    conn = _abrir_conexao()
    try:
        yield conn
    finally:
        conn.close()


def _metadata_json(metadata: Optional[Dict[str, Any]]) -> str:
    if metadata is not None and not isinstance(metadata, dict):
        raise ValueError("metadata deve ser um dicionário.")
    # JSON puro conserva listas/datas de origem e mantém dados recuperáveis pela API.
    return json.dumps(metadata or {}, ensure_ascii=False, sort_keys=True, allow_nan=False)


def _ler_metadata(metadata_json: str) -> Optional[Dict[str, Any]]:
    try:
        metadata = json.loads(metadata_json)
    except (TypeError, ValueError):
        return None
    return metadata if isinstance(metadata, dict) else None


def _documento_privado(categoria: str, metadata: Dict[str, Any]) -> bool:
    escopo = str(metadata.get("escopo") or "").strip().lower()
    return (str(categoria).strip().lower() == "conversa_usuario"
            or str(metadata.get("tipo") or "").strip().lower() == "conversa"
            or str(metadata.get("natureza") or "").strip().lower() == "relato_usuario"
            or metadata.get("usuario_id") is not None
            or bool(escopo and escopo not in {"publico", "público", "public", "global"}))


def _documento_visivel(categoria: str, metadata_json: str,
                      usuario_id: Optional[str] = None) -> bool:
    """Ausência de identidade/escopo nunca torna aprendizado pessoal público."""
    metadata = _ler_metadata(metadata_json)
    if metadata is None:
        return False
    if not _documento_privado(categoria, metadata):
        return True
    escopo = str(metadata.get("escopo") or "").strip().lower()
    dono = metadata.get("usuario_id")
    if escopo not in {"usuario", "usuário", "user", "privado", "private"}:
        return False
    if not isinstance(dono, (str, int)) or isinstance(dono, bool):
        return False
    return bool(usuario_id is not None and str(usuario_id).strip()
                and str(dono).strip() and str(dono) == str(usuario_id))


_FRESHNESS_METADATA_KEYS = {"extraido_em", "extracted_at", "coletado_em", "collected_at", "fetched_at",
                            "downloaded_at", "last_checked_at", "last_seen_at", "checked_at", "timestamp"}


def _metadata_estavel(metadata_json: str) -> Dict[str, Any]:
    return {key: value for key, value in json.loads(metadata_json).items()
            if key not in _FRESHNESS_METADATA_KEYS}


def _substituir_chunks(conn: sqlite3.Connection, doc_id: str, conteudo: str) -> None:
    conn.execute("DELETE FROM chunks WHERE doc_id=?", (doc_id,))
    conn.executemany(
        "INSERT INTO chunks(id, doc_id, chunk_index, texto) VALUES (?, ?, ?, ?)",
        [(f"{doc_id}_{indice}", doc_id, indice, chunk)
         for indice, chunk in enumerate(dividir_em_chunks(conteudo))]
    )


def _resolve_id(conn: sqlite3.Connection, doc_id: str) -> str:
    row = conn.execute("SELECT doc_id FROM document_aliases WHERE alias=?", (doc_id,)).fetchone()
    return row["doc_id"] if row else doc_id


def _carregar_chroma_sqlite(arquivo: Path) -> Dict[str, Any]:
    """Adaptador para o schema Chroma sqlite observado; nunca escreve no legado."""
    conn = sqlite3.connect(arquivo.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("BEGIN")
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(embedding_metadata)")}
        required = {"id", "key", "string_value", "int_value", "float_value"}
        if not required.issubset(columns):
            raise ValueError("Schema Chroma desconhecido; memória original conservada para importação explícita.")
        colecao_existente = conn.execute("SELECT id FROM collections WHERE name=?", (COLLECTION_NAME,)).fetchone()
        if not colecao_existente:
            raise ValueError(f"Coleção {COLLECTION_NAME!r} não encontrada no banco antigo.")
        rows = conn.execute("""
            SELECT e.embedding_id AS embedding_key, m.* FROM embeddings e
            JOIN segments s ON s.id=e.segment_id
            JOIN embedding_metadata m ON m.id=e.id
            WHERE s.collection=? AND s.scope='METADATA'
        """, (colecao_existente["id"],)).fetchall()
        documentos: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            value = next((row[key] for key in ("string_value", "int_value", "float_value", "bool_value")
                          if key in columns and row[key] is not None), None)
            documentos.setdefault(row["embedding_key"], {})[row["key"]] = value
        ids, textos, metadatas = [], [], []
        for doc_id, metadata in documentos.items():
            texto = metadata.pop("chroma:document", None)
            if not texto:
                continue
            ids.append(doc_id)
            textos.append(texto)
            metadatas.append(metadata)
        return {"ids": ids, "documents": textos, "metadatas": metadatas}
    finally:
        conn.close()


def _importar_dados_chroma(conn: sqlite3.Connection, dados: Dict[str, Any]) -> List[str]:
    grupos: Dict[str, List[Any]] = {}
    for chunk_id, texto, metadata in zip(dados.get("ids", []) or [],
                                         dados.get("documents", []) or [],
                                         dados.get("metadatas", []) or []):
        metadata = metadata or {}
        if not texto:
            continue
        doc_id = str(metadata.get("doc_id") or chunk_id)
        try:
            index = int(metadata.get("chunk_index", 0))
        except (ValueError, TypeError):
            index = 0
        grupos.setdefault(doc_id, []).append((index, texto, metadata))
    importados = []
    for doc_id, trechos in grupos.items():
        if conn.execute("SELECT 1 FROM documents WHERE id=?", (doc_id,)).fetchone():
            continue
        trechos.sort(key=lambda trecho: trecho[0])
        texto = ""
        for _, trecho, _ in trechos:
            if not texto:
                texto = trecho
                continue
            # Remove a sobreposição usada pelo fragmentador anterior.
            overlap = next((size for size in range(min(len(texto), len(trecho), CHUNK_SIZE), 0, -1)
                            if texto.endswith(trecho[:size])), 0)
            texto += trecho[overlap:] if overlap else "\n" + trecho
        if texto.startswith("TÍTULO:") and "\nCONTEÚDO:\n" in texto:
            texto = texto.split("\nCONTEÚDO:\n", 1)[1]
        texto = normalizar_texto(texto)
        if not texto:
            continue
        origem = trechos[0][2]
        metadata = {key: value for key, value in origem.items()
                    if key not in {"doc_id", "titulo", "tipo", "url", "content_hash", "chunk_index", "chunk_total"}}
        metadata["imported_from"] = "chromadb"
        try:
            timestamp = int(origem.get("timestamp", 0) or time.time())
        except (ValueError, TypeError):
            timestamp = int(time.time())
        conn.execute("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                     (doc_id, str(origem.get("titulo") or "Documento sem título"), texto,
                      str(origem.get("tipo") or "geral"), str(origem.get("url") or ""),
                      hash_texto(texto), _metadata_json(metadata), timestamp, timestamp))
        _substituir_chunks(conn, doc_id, texto)
        importados.append(doc_id)
    conn.execute("INSERT INTO engine_state VALUES ('chroma_imported', ?)", (str(int(time.time())),))
    return importados


def _importar_chroma_legado() -> List[str]:
    """Alternativa explícita pela coleção Chroma, sem sobrescrever fontes locais."""
    with _conn() as conn:
        if conn.execute("SELECT 1 FROM engine_state WHERE key='chroma_imported'").fetchone():
            return []
    dados = colecao.get(include=["documents", "metadatas"])
    with _conn() as conn:
        conn.execute("BEGIN IMMEDIATE")
        importados = _importar_dados_chroma(conn, dados)
        conn.commit()
    return importados


def _inicializar_memoria() -> bool:
    """Inicializa somente o índice opcional; a memória local sempre continua disponível."""
    global cliente, colecao, modelo, chromadb, SentenceTransformer
    global memoria_inicializada, modo_fallback, _erro_semantico
    _inicializar_banco()
    if memoria_inicializada:
        return not modo_fallback
    with _lock:
        if memoria_inicializada:
            return not modo_fallback
        memoria_inicializada = True
        if RAG_MODE != "semantic":
            return False
        try:
            if chromadb is None:
                import chromadb as chroma_module
                chromadb = chroma_module
            if SentenceTransformer is None:
                from sentence_transformers import SentenceTransformer as transformer_class
                SentenceTransformer = transformer_class
            cliente = chromadb.PersistentClient(path=str(path_banco))
            colecao = cliente.get_or_create_collection(name=COLLECTION_NAME, metadata={"hnsw:space": "cosine"})
            modelo = SentenceTransformer(EMBEDDING_MODEL)
            modo_fallback = False
            try:
                for doc_id in _importar_chroma_legado():
                    _sincronizar_semantica(doc_id)
            except Exception as exc:
                # Uma falha na importação não desabilita o banco local nem a coleta nova.
                sys.stderr.write(f"[learning_engine] Migração do índice Chroma pendente: {exc}\n")
            return True
        except Exception as exc:
            modo_fallback = True
            _erro_semantico = str(exc)
            sys.stderr.write(f"[learning_engine] Pesquisa semântica indisponível; SQLite/lexical ativo: {exc}\n")
            return False


def _registrar_mysql(titulo: str, conteudo: str, categoria: str, doc_id: str,
                     url: Optional[str], content_hash: str) -> None:
    if os.getenv("IANA_MYSQL_MIRROR", "").lower() not in {"1", "true", "yes"}:
        return
    try:
        try:
            from .memory import registrar_aprendizado_mysql, save_memory
        except ImportError:
            from memory import registrar_aprendizado_mysql, save_memory
        registrar_aprendizado_mysql(chave=doc_id, tipo=categoria, titulo=titulo,
                                  fonte_url=url, content_hash=content_hash)
        save_memory(texto=conteudo, categoria=categoria, fonte_url=url, doc_id=doc_id)
    except Exception as exc:
        sys.stderr.write(f"[learning_engine] Fonte preservada no SQLite; MySQL não atualizado: {exc}\n")


def _proveniencia(row: Any, chunk_index: Optional[int] = None,
                  chunk_total: Optional[int] = None) -> Dict[str, Any]:
    metadata = _ler_metadata(row["metadata_json"]) or {}
    if _documento_privado(row["categoria"], metadata):
        metadata.update({"origem_conhecimento": "conversa", "natureza": "relato_usuario"})
    elif str(row["categoria"]).lower() == "texto_local" or metadata.get("tipo") == "texto_local":
        metadata.update({"origem_conhecimento": "arquivo_local", "natureza": "conteudo_fornecido",
                         "verificado": False})
    metadata.update({"doc_id": row["id"], "titulo": row["titulo"], "tipo": row["categoria"],
                     "categoria": row["categoria"], "url": row["url"],
                     "content_hash": row["content_hash"], "criado_em": row["criado_em"],
                     "atualizado_em": row["atualizado_em"]})
    if chunk_index is not None:
        metadata["chunk_index"] = chunk_index
    if chunk_total is not None:
        metadata["chunk_total"] = chunk_total
    return metadata


def _obter_ids_documento(id_documento: str) -> List[str]:
    """IDs do índice Chroma; inclui o formato legado sem doc_id."""
    if not _inicializar_memoria():
        return []
    resultado = colecao.get(where={"doc_id": id_documento})
    ids = list(resultado.get("ids", []) or [])
    legado = colecao.get(ids=[id_documento])
    ids.extend(legado.get("ids", []) or [])
    return list(dict.fromkeys(ids))


def _sincronizar_semantica(doc_id: str) -> None:
    if not _inicializar_memoria():
        return
    try:
        with _conn() as conn:
            row = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
            chunks = conn.execute("SELECT * FROM chunks WHERE doc_id=? ORDER BY chunk_index", (doc_id,)).fetchall()
        if not row or not chunks:
            return
        ids_antigos = _obter_ids_documento(doc_id)
        ids_novos = [chunk["id"] for chunk in chunks]
        documentos = [f"{row['titulo']}\n\n{chunk['texto']}" for chunk in chunks]
        metadatas = []
        for chunk in chunks:
            # Chroma aceita apenas metadados escalares; JSON completo continua no SQLite.
            metadata = _proveniencia(row, chunk["chunk_index"], len(chunks))
            metadatas.append({key: value for key, value in metadata.items()
                              if isinstance(value, (str, int, float, bool)) and key not in _FRESHNESS_METADATA_KEYS})
        if set(ids_antigos) == set(ids_novos):
            dados_atuais = colecao.get(ids=ids_novos, include=["metadatas"])
            atuais = dict(zip(dados_atuais.get("ids", []) or [], dados_atuais.get("metadatas", []) or []))
            if all(atuais.get(chunk_id) == metadata for chunk_id, metadata in zip(ids_novos, metadatas)):
                return
        # Só remove sobras depois que novos vetores foram calculados e confirmados.
        vetores = modelo.encode(documentos, normalize_embeddings=True)
        vetores = vetores.tolist() if hasattr(vetores, "tolist") else list(vetores)
        colecao.upsert(ids=ids_novos, documents=documentos,
                       embeddings=vetores, metadatas=metadatas)
        ids_obsoletos = list(set(ids_antigos) - set(ids_novos))
        if ids_obsoletos:
            colecao.delete(ids=ids_obsoletos)
    except Exception as exc:
        sys.stderr.write(f"[learning_engine] Fonte salva; índice semântico não atualizado: {exc}\n")


def documento_existe(id_documento: str) -> bool:
    if not id_documento:
        return False
    with _conn() as conn:
        doc_id = _resolve_id(conn, str(id_documento))
        return conn.execute("SELECT 1 FROM documents WHERE id=?", (doc_id,)).fetchone() is not None


def remover_documento(id_documento: str) -> bool:
    if not id_documento:
        return False
    try:
        with _lock, _conn() as conn:
            doc_id = _resolve_id(conn, str(id_documento))
            conn.execute("DELETE FROM documents WHERE id=?", (doc_id,))
            conn.commit()
            if _inicializar_memoria():
                try:
                    ids = _obter_ids_documento(doc_id)
                    if ids:
                        colecao.delete(ids=ids)
                except Exception as exc:
                    sys.stderr.write(f"[learning_engine] Exclusão do índice pendente: {exc}\n")
        return True
    except Exception as exc:
        sys.stderr.write(f"[learning_engine] Erro removendo documento: {exc}\n")
        return False


def documento_parecido(vetor, limite: float = SIMILARITY_LIMIT) -> bool:
    if not _inicializar_memoria():
        return False
    try:
        resultado = colecao.query(query_embeddings=[vetor], n_results=1)
        distancias = resultado.get("distances", [[]])[0]
        return bool(distancias and 1.0 - float(distancias[0]) >= limite)
    except Exception:
        return False


def learn(titulo: str, conteudo: str, categoria: str = "mining",
          id_documento: Optional[str] = None, url: Optional[str] = None,
          metadata: Optional[Dict[str, Any]] = None) -> str:
    """Salva uma fonte inteira e substitui seus trechos na mesma transação.

    Preserva os status usados pelo minerador: NOVO, ATUALIZADO, EXISTE, ERRO.
    Fontes diferentes com texto igual são conservadas para manter a proveniência.
    """
    titulo = normalizar_texto(titulo) or "Documento sem título"
    conteudo = normalizar_texto(conteudo)
    categoria = normalizar_texto(categoria) or "geral"
    url = str(url or "").strip()
    if not conteudo:
        return "ERRO"
    doc_id = str(id_documento or gerar_id_documento(url or titulo)).strip()
    if not doc_id:
        return "ERRO"
    try:
        metadata_json = _metadata_json(metadata)
        content_hash = hash_texto(conteudo)
        with _lock, _conn() as conn:
            conn.execute("BEGIN IMMEDIATE")
            requested_id = doc_id
            doc_id = _resolve_id(conn, doc_id)
            antigo = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
            if antigo is None and url:
                antigo = conn.execute("SELECT * FROM documents WHERE url=? ORDER BY criado_em LIMIT 1", (url,)).fetchone()
                if antigo:
                    doc_id = antigo["id"]
                    conn.execute("INSERT OR REPLACE INTO document_aliases VALUES (?, ?)", (requested_id, doc_id))
            # Uma nova coleta sem metadados extras não apaga a origem já registrada.
            if antigo and metadata is None:
                metadata_json = antigo["metadata_json"]
            igual = antigo and (antigo["content_hash"], antigo["titulo"], antigo["categoria"],
                                 antigo["url"], _metadata_estavel(antigo["metadata_json"])) == (
                                     content_hash, titulo, categoria, url, _metadata_estavel(metadata_json))
            status = "EXISTE" if igual else "ATUALIZADO" if antigo else "NOVO"
            if igual and antigo["metadata_json"] != metadata_json:
                # Renova data de coleta, conservando trechos/data da última mudança real.
                conn.execute("UPDATE documents SET metadata_json=? WHERE id=?", (metadata_json, doc_id))
            if not igual:
                now = int(time.time())
                criado = antigo["criado_em"] if antigo else now
                conn.execute("""
                    INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET titulo=excluded.titulo,
                        conteudo=excluded.conteudo, categoria=excluded.categoria,
                        url=excluded.url, content_hash=excluded.content_hash,
                        metadata_json=excluded.metadata_json, atualizado_em=excluded.atualizado_em
                """, (doc_id, titulo, conteudo, categoria, url, content_hash, metadata_json, criado, now))
                _substituir_chunks(conn, doc_id, conteudo)
            conn.commit()
            # SQLite já confirmou a escrita; os espelhos nunca determinam seu sucesso.
            _sincronizar_semantica(doc_id)
            # O espelho legado não tem identidade/escopo e não pode receber conversa pessoal.
            if status != "EXISTE" and not _documento_privado(categoria, _ler_metadata(metadata_json) or {}):
                _registrar_mysql(titulo, conteudo, categoria, doc_id, url or None, content_hash)
        return status
    except Exception as exc:
        sys.stderr.write(f"[learning_engine] Erro salvando fonte: {exc}\n")
        return "ERRO"


_STOPWORDS = set("""a ao aos as o os um uma uns umas de da das do dos e em no na nos nas
    para por com sem que se seu sua seus suas eu voce ele ela isso isto como onde qual quais
    quando porque pra quero saber pode sobre tem esta sao ser foi uma mais me the a an of
    and or to in on at for with is are was were be how what where when why this that it
    can i you my about from
    usando use usado usada usados usadas utilizar utilize baseada baseado baseadas baseados
    partir aprendeu aprendido aprendida aprendidas aprendidos aprende aprender conhecimento
    crie criar desenvolva desenvolver elabore elaborar ideia ideias diferente diferentes inovador
    inovadora inovadoras novo nova novos novas explique explicar explique fatos fato vem vindo
    proposta propostas testar teste testar testes cite citar citados citadas fontes fonte videos video
    transcricao transcricoes transcript transcripts learned learning create develop innovative idea
    explain facts proposal test testing cite sources source using used use based new different
    busque buscar busca pesquise pesquisar online internet nao not do does dont please porfavor""".split())


def _fold(texto: str) -> str:
    return "".join(char for char in unicodedata.normalize("NFKD", texto.lower())
                   if not unicodedata.combining(char))


_ALIASES = {"builds": "build", "build": "build", "construcoes": "build", "construcao": "build",
            "endgame": "endgame", "end": "endgame", "fim": "endgame", "final": "endgame",
            "perks": "perk", "vantagens": "perk", "vantagem": "perk", "habilidades": "perk",
            "survivors": "survivor", "sobreviventes": "survivor", "sobrevivente": "survivor",
            "killers": "killer", "assassinos": "killer", "assassino": "killer",
            "geradores": "generator", "gerador": "generator", "generators": "generator",
            "portoes": "gate", "portao": "gate", "gates": "gate", "videos": "video",
            "estrategias": "strategy", "estrategia": "strategy", "strategies": "strategy"}


def _tokens(texto: str) -> List[str]:
    texto = _fold(texto)
    texto = re.sub(r"\bdead[\s/_+-]*by[\s/_+-]*daylight\b", "dbd", texto)
    texto = re.sub(r"\bend[ -]+game\b|\bfim de (?:jogo|partida)\b", "endgame", texto)
    return [_ALIASES.get(token, token) for token in re.findall(r"\w+", texto)
            if token not in _STOPWORDS and len(token) > 1]


def _query_topic(query: str) -> Optional[str]:
    return "dbd" if "dbd" in _tokens(query) else None


def _document_matches_topic(row: Any, topic: Optional[str]) -> bool:
    if topic != "dbd":
        return True
    texto = "\n".join(str(row[key]) for key in ("titulo", "categoria", "url", "conteudo", "metadata_json"))
    return bool(re.search(r"(?<![a-z0-9])dbd(?![a-z0-9])|dead[\s/_+-]*by[\s/_+-]*daylight", texto, re.I))


def _transcript_source_weight(row: Any, query: str) -> float:
    if not re.search(r"transcri[cç](?:ao|ão|oes|ões)|transcripts?", query, re.I):
        return 1.0
    metadata = json.loads(row["metadata_json"])
    method = str(metadata.get("metodo") or metadata.get("method") or "").lower()
    if "transcript" in method or metadata.get("segmentos") or metadata.get("segments"):
        return 2.5
    categoria = row["categoria"].lower()
    if "transcri" in categoria or "transcript" in categoria:
        return 2.5
    if "youtube" in categoria or "video" in categoria or "youtu" in row["url"].lower():
        return 1.4
    return 1.0


def _buscar_lexical(query: str, limite: int,
                    usuario_id: Optional[str] = None) -> List[Dict[str, Any]]:
    termos = set(_tokens(query))
    if not termos:
        return []
    topic = _query_topic(query)
    # O nome do jogo restringe as fontes; o assunto específico decide a ordem.
    if topic in termos and len(termos) > 1:
        termos.remove(topic)
    with _conn() as conn:
        sql = """
            SELECT d.*, c.id AS chunk_id, c.chunk_index, c.texto,
                (SELECT COUNT(*) FROM chunks WHERE doc_id=d.id) AS chunk_total
            FROM chunks c JOIN documents d ON d.id=c.doc_id
            WHERE document_visible(d.categoria, d.metadata_json, ?)
        """
        if topic == "dbd":
            # Pré-filtro barato evita tokenizar todos os jogos quando o assunto é explícito.
            sql += """ AND (LOWER(d.titulo || ' ' || d.categoria || ' ' || d.url || ' ' ||
                d.conteudo || ' ' || d.metadata_json) LIKE '%dbd%'
                OR LOWER(d.titulo || ' ' || d.categoria || ' ' || d.url || ' ' ||
                d.conteudo || ' ' || d.metadata_json) LIKE '%daylight%') """
        rows = conn.execute(sql, (usuario_id,)).fetchall()
    valid_docs: Dict[str, bool] = {}
    weights: Dict[str, float] = {}
    filtered_rows = []
    for row in rows:
        doc_id = row["id"]
        if doc_id not in valid_docs:
            valid_docs[doc_id] = _document_matches_topic(row, topic)
            weights[doc_id] = _transcript_source_weight(row, query)
        if valid_docs[doc_id]:
            filtered_rows.append(row)
    rows = filtered_rows
    if not rows:
        return []
    token_counts = [Counter(_tokens(row["texto"])) for row in rows]
    title_counts = [Counter(_tokens(row["titulo"])) for row in rows]
    lengths = [sum(counts.values()) for counts in token_counts]
    avglen = sum(lengths) / len(rows) or 1
    frequencies = {term: sum(term in words or term in title for words, title in zip(token_counts, title_counts))
                   for term in termos}
    candidatos = []
    for row, words, title, length in zip(rows, token_counts, title_counts, lengths):
        matched = termos & (set(words) | set(title))
        if not matched:
            continue
        score = 0.0
        for term in matched:
            tf = words[term] + 2 * title[term]
            idf = math.log(1 + (len(rows) - frequencies[term] + 0.5) / (frequencies[term] + 0.5))
            score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length / avglen))
        score *= 0.5 + len(matched) / len(termos)
        score *= 1 + 2 * len(termos & set(title)) / len(termos)
        score *= weights[row["id"]]
        candidatos.append({"documento": row["texto"],
                           "metadata": _proveniencia(row, row["chunk_index"], row["chunk_total"]),
                           "distancia": None, "score": round(score, 6), "retrieval": "keyword"})
    candidatos.sort(key=lambda item: (-item["score"], -item["metadata"]["atualizado_em"],
                                      item["metadata"]["doc_id"], item["metadata"]["chunk_index"]))
    # Distribui trechos entre fontes antes de usar o espaço restante para uma única fonte.
    primeiros, extras, vistos = [], [], set()
    for item in candidatos:
        doc_id = item["metadata"]["doc_id"]
        if doc_id in vistos:
            extras.append(item)
        else:
            primeiros.append(item)
            vistos.add(doc_id)
    return (primeiros + extras)[:limite]


def _buscar_semantica(query: str, limite: int,
                     usuario_id: Optional[str] = None) -> List[Dict[str, Any]]:
    if not _inicializar_memoria():
        return []
    try:
        count = colecao.count()
        if not count:
            return []
        with _conn() as conn:
            visiveis = conn.execute("""
                SELECT d.id, COUNT(c.id) AS chunk_total FROM documents d
                JOIN chunks c ON c.doc_id=d.id
                WHERE document_visible(d.categoria, d.metadata_json, ?) GROUP BY d.id
            """, (usuario_id,)).fetchall()
        if not visiveis:
            return []
        vetor = modelo.encode(query, normalize_embeddings=True)
        vetor = vetor.tolist() if hasattr(vetor, "tolist") else list(vetor)
        resultado = colecao.query(query_embeddings=[vetor],
                                  n_results=min(count, sum(row["chunk_total"] for row in visiveis), limite * 3),
                                  where={"doc_id": {"$in": [row["id"] for row in visiveis]}},
                                  include=["documents", "metadatas", "distances"])
        encontrados = []
        with _conn() as conn:
            for meta, distancia in zip(resultado.get("metadatas", [[]])[0] or [],
                                       resultado.get("distances", [[]])[0] or []):
                meta = meta or {}
                row = conn.execute("SELECT * FROM documents WHERE id=?", (meta.get("doc_id", ""),)).fetchone()
                # Índices antigos, removidos ou de uma versão anterior não são evidência válida.
                if not row or meta.get("content_hash") != row["content_hash"]:
                    continue
                if not _documento_visivel(row["categoria"], row["metadata_json"], usuario_id):
                    continue
                if not _document_matches_topic(row, _query_topic(query)):
                    continue
                chunk = conn.execute("SELECT texto FROM chunks WHERE doc_id=? AND chunk_index=?",
                                     (row["id"], meta.get("chunk_index", -1))).fetchone()
                if chunk:
                    encontrados.append({"documento": chunk["texto"],
                                        "metadata": _proveniencia(row, meta["chunk_index"], meta.get("chunk_total")),
                                        "distancia": float(distancia), "score": 1 - float(distancia),
                                        "retrieval": "semantic"})
        return encontrados[:limite]
    except Exception as exc:
        sys.stderr.write(f"[learning_engine] Busca semântica falhou; usando pesquisa lexical: {exc}\n")
        return []


def buscar_resultados(pergunta_usuario: str, limite_resultados: int = 6,
                      usuario_id: Optional[str] = None) -> List[Dict[str, Any]]:
    query = normalizar_texto(pergunta_usuario)
    if not query:
        return []
    limite = max(1, min(int(limite_resultados), 20))
    try:
        lexical = _buscar_lexical(query, limite, usuario_id)
        if RAG_MODE != "semantic":
            return lexical
        semantic = _buscar_semantica(query, limite, usuario_id)
        # Recuperação híbrida: palavras explícitas têm prioridade e semântica complementa.
        resultados = list(lexical)
        vistos = {(item["metadata"]["doc_id"], item["metadata"]["chunk_index"]) for item in resultados}
        for item in semantic:
            key = (item["metadata"]["doc_id"], item["metadata"]["chunk_index"])
            if key not in vistos:
                resultados.append(item)
                vistos.add(key)
        return resultados[:limite]
    except Exception as exc:
        sys.stderr.write(f"[learning_engine] Erro consultando memória: {exc}\n")
        return []


def buscar_na_memoria_iana(pergunta_usuario: str, limite_resultados: int = 6,
                         usuario_id: Optional[str] = None) -> str:
    partes = []
    for resultado in buscar_resultados(pergunta_usuario, limite_resultados, usuario_id):
        metadata = resultado["metadata"]
        titulo = metadata["titulo"]
        categoria = metadata["tipo"]
        cabecalho = f"[{categoria.upper()} — {titulo}]\nDocumento: {metadata['doc_id']}"
        if metadata.get("origem_conhecimento") == "conversa":
            cabecalho += ("\nOrigem: aprendizado por conversa com este usuário"
                          "\nNatureza: relato do usuário; preferência, correção ou proposta sem verificação externa."
                          "\nTrate como contexto pessoal, sem afirmar que é informação comprovada.")
        elif metadata.get("origem_conhecimento") == "arquivo_local":
            cabecalho += ("\nOrigem: conteúdo fornecido em arquivo local"
                          "\nNatureza: conteúdo fornecido pelo usuário, sem verificação externa."
                          "\nTrate como material fornecido, sem afirmar que foi extraído de um site ou comprovado.")
            if metadata.get("arquivo"):
                cabecalho += f"\nArquivo: {metadata['arquivo']}"
        else:
            cabecalho += "\nOrigem: conteúdo extraído de uma fonte; avalie a evidência antes de afirmar um fato."
        if metadata.get("url"):
            cabecalho += f"\nFonte: {metadata['url']}"
        for label, keys in (
            ("Publicado em", ("published_at", "published_date", "publication_date", "publicado_em")),
            ("Extraído em", ("extracted_at", "collected_at", "fetched_at", "extraido_em")),
        ):
            data = next((metadata[key] for key in keys if metadata.get(key)), None)
            if data is not None:
                cabecalho += f"\n{label}: {data}"
        # Delimitadores permitem ao modelo distinguir a fonte das instruções da conversa.
        partes.append(f"{cabecalho}\n<conteudo_da_fonte>\n{resultado['documento']}\n</conteudo_da_fonte>")
    return "\n\n---\n\n".join(partes)


def buscar_conhecimento(pergunta_usuario: str, limite_resultados: int = 6,
                        usuario_id: Optional[str] = None) -> str:
    return buscar_na_memoria_iana(pergunta_usuario, limite_resultados, usuario_id)


def get_document(document_id: str, usuario_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Lê uma fonte inteira respeitando o mesmo escopo da recuperação."""
    if not document_id:
        return None
    with _conn() as conn:
        row = conn.execute("""
            SELECT d.*, (SELECT COUNT(*) FROM chunks WHERE doc_id=d.id) AS chunk_total
            FROM documents d WHERE d.id=? AND document_visible(d.categoria, d.metadata_json, ?)
        """, (_resolve_id(conn, str(document_id)), usuario_id)).fetchone()
    if row is None:
        return None
    return {"id": row["id"], "doc_id": row["id"], "titulo": row["titulo"],
            "conteudo": row["conteudo"], "categoria": row["categoria"], "url": row["url"],
            "content_hash": row["content_hash"], "criado_em": row["criado_em"],
            "atualizado_em": row["atualizado_em"], "metadata": _ler_metadata(row["metadata_json"]) or {},
            "chunks": row["chunk_total"]}


def list_documents(limit: int = 50, offset: int = 0,
                   usuario_id: Optional[str] = None) -> List[Dict[str, Any]]:
    limit, offset = max(1, min(int(limit), 500)), max(0, int(offset))
    with _conn() as conn:
        rows = conn.execute("""
            SELECT d.*, (SELECT COUNT(*) FROM chunks WHERE doc_id=d.id) AS chunk_total
            FROM documents d WHERE document_visible(d.categoria, d.metadata_json, ?) ORDER BY
                CASE WHEN metadata_json LIKE '%"extraido_em"%' OR metadata_json LIKE '%"extracted_at"%'
                         OR metadata_json LIKE '%"collected_at"%' THEN 0
                     WHEN metadata_json LIKE '%"imported_from"%' THEN 1 ELSE 0 END,
                atualizado_em DESC, id LIMIT ? OFFSET ?
        """, (usuario_id, limit, offset)).fetchall()
    return [{"id": row["id"], "doc_id": row["id"], "titulo": row["titulo"],
             "categoria": row["categoria"], "url": row["url"],
             "content_hash": row["content_hash"], "criado_em": row["criado_em"],
             "atualizado_em": row["atualizado_em"], "metadata": _proveniencia(row),
             "chunks": row["chunk_total"], "caracteres": len(row["conteudo"]),
             "preview": row["conteudo"][:300]} for row in rows]


def knowledge_status(usuario_id: Optional[str] = None) -> Dict[str, Any]:
    with _conn() as conn:
        documents = conn.execute("SELECT COUNT(*) FROM documents WHERE document_visible(categoria, metadata_json, ?)",
                                 (usuario_id,)).fetchone()[0]
        chunks = conn.execute("""SELECT COUNT(*) FROM chunks c JOIN documents d ON d.id=c.doc_id
            WHERE document_visible(d.categoria, d.metadata_json, ?)""", (usuario_id,)).fetchone()[0]
        atualizado = conn.execute("SELECT MAX(atualizado_em) FROM documents WHERE document_visible(categoria, metadata_json, ?)",
                                 (usuario_id,)).fetchone()[0]
        chroma_imported = conn.execute("SELECT 1 FROM engine_state WHERE key='chroma_imported'").fetchone()
    # Consultar status não importa torch nem baixa modelos em segundo plano.
    legacy_pending = (path_banco / "chroma.sqlite3").exists() and not bool(chroma_imported)
    return {"sqlite": True, "documentos": documents, "documents": documents, "chunks": chunks,
            "modelo": EMBEDDING_MODEL, "banco": str(path_banco), "database_path": str(arquivo_sqlite),
            "rag_mode": RAG_MODE, "active_mode": "keyword" if modo_fallback else "semantic",
            "chromadb": not modo_fallback, "fallback": modo_fallback,
            "legacy_chroma_pending": legacy_pending,
            "legacy_chroma_error": _erro_migracao_chroma or None,
            "legacy_chroma_warning": "Memória Chroma antiga ainda não importada; arquivo original preservado." if legacy_pending else None,
            "semantic_error": _erro_semantico or None, "legacy_import_error": _erro_migracao or None,
            "atualizado_em": atualizado}


def status_memoria(usuario_id: Optional[str] = None) -> Dict[str, Any]:
    return knowledge_status(usuario_id)


def main() -> None:
    if len(sys.argv) >= 3:
        status = learn(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "mining")
        print(f"Resultado: {status}")
        raise SystemExit(0 if status != "ERRO" else 1)
    print(json.dumps(knowledge_status(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
