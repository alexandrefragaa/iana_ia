# memory.py
# ================================================================
# MEMÓRIA PERSISTENTE DA IANA
#
# Responsabilidades:
# - Memórias/fatos permanentes no MySQL
# - Documentos aprendidos
# - Histórico das conversas
# - Consulta textual de memórias
# - Controle de documentos já processados
#
# O ChromaDB continua sendo responsabilidade do learning_engine.py
# ================================================================

from __future__ import annotations

import os
import ssl as ssl_lib
import sys
import threading
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

import pymysql
import pymysql.cursors


# ================================================================
# CONFIGURAÇÃO
# ================================================================

_lock = threading.RLock()

GLOBAL_USER_ID = "__global__"

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", "3306")),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASS", ""),
    "database": os.getenv("DB_NAME", "defaultdb"),
    "charset": "utf8mb4",
    "cursorclass": pymysql.cursors.DictCursor,
    "autocommit": True,
    "connect_timeout": 10,
    "read_timeout": 30,
    "write_timeout": 30,
}

# SSL opcional
if os.getenv("DB_SSL", "").strip().lower() == "true":
    ssl_context = ssl_lib.create_default_context()

    # Mantém compatibilidade com sua configuração atual.
    # Em produção, prefira certificado válido.
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl_lib.CERT_NONE

    DB_CONFIG["ssl"] = ssl_context


_tabelas_ok = False


# ================================================================
# CONEXÃO
# ================================================================

@contextmanager
def _conn():
    conn = pymysql.connect(**DB_CONFIG)

    try:
        yield conn
    finally:
        conn.close()


# ================================================================
# TABELAS
# ================================================================

def _garantir_tabelas():
    global _tabelas_ok

    if _tabelas_ok:
        return

    with _lock:
        if _tabelas_ok:
            return

        with _conn() as conn:
            with conn.cursor() as cur:

                # ------------------------------------------------
                # FATOS / MEMÓRIAS
                # ------------------------------------------------

                cur.execute("""
                    CREATE TABLE IF NOT EXISTS fatos_iana (
                        id BIGINT AUTO_INCREMENT PRIMARY KEY,

                        user_id VARCHAR(191) NOT NULL,

                        categoria VARCHAR(64) NOT NULL,

                        jogo VARCHAR(191) NULL,

                        texto LONGTEXT NOT NULL,

                        fonte_url VARCHAR(2048) NULL,

                        doc_id VARCHAR(191) NULL,

                        criado_em TIMESTAMP
                            DEFAULT CURRENT_TIMESTAMP,

                        atualizado_em TIMESTAMP
                            DEFAULT CURRENT_TIMESTAMP
                            ON UPDATE CURRENT_TIMESTAMP,

                        UNIQUE KEY uq_doc_id (doc_id),

                        INDEX idx_user (user_id),

                        INDEX idx_jogo (jogo),

                        INDEX idx_categoria (categoria)

                    ) ENGINE=InnoDB
                      DEFAULT CHARSET=utf8mb4
                      COLLATE=utf8mb4_unicode_ci
                """)

                # ------------------------------------------------
                # DOCUMENTOS APRENDIDOS
                # ------------------------------------------------

                cur.execute("""
                    CREATE TABLE IF NOT EXISTS aprendidos_iana (
                        id BIGINT AUTO_INCREMENT PRIMARY KEY,

                        chave VARCHAR(512) NOT NULL,

                        tipo VARCHAR(64) NOT NULL,

                        titulo VARCHAR(500) NULL,

                        fonte_url VARCHAR(2048) NULL,

                        content_hash CHAR(64) NULL,

                        criado_em TIMESTAMP
                            DEFAULT CURRENT_TIMESTAMP,

                        atualizado_em TIMESTAMP
                            DEFAULT CURRENT_TIMESTAMP
                            ON UPDATE CURRENT_TIMESTAMP,

                        UNIQUE KEY uq_chave (chave),

                        INDEX idx_tipo (tipo),

                        INDEX idx_hash (content_hash)

                    ) ENGINE=InnoDB
                      DEFAULT CHARSET=utf8mb4
                      COLLATE=utf8mb4_unicode_ci
                """)

                # ------------------------------------------------
                # HISTÓRICO
                # ------------------------------------------------

                cur.execute("""
                    CREATE TABLE IF NOT EXISTS mensagens (
                        id BIGINT AUTO_INCREMENT PRIMARY KEY,

                        conversa_id VARCHAR(191) NOT NULL,

                        usuario_id BIGINT NULL,

                        remetente VARCHAR(16) NOT NULL,

                        mensagem MEDIUMTEXT NOT NULL,

                        criado_em TIMESTAMP
                            DEFAULT CURRENT_TIMESTAMP,

                        INDEX idx_conversa (conversa_id),

                        INDEX idx_usuario (usuario_id),

                        INDEX idx_criado (criado_em)

                    ) ENGINE=InnoDB
                      DEFAULT CHARSET=utf8mb4
                      COLLATE=utf8mb4_unicode_ci
                """)

        _tabelas_ok = True


# ================================================================
# DISPONIBILIDADE
# ================================================================

def _db_disponivel() -> bool:
    try:
        _garantir_tabelas()
        return True

    except Exception as e:
        sys.stderr.write(
            f"[memory] MySQL indisponível: {e}\n"
        )

        return False


def testar_conexao() -> bool:
    """
    Testa a conexão com MySQL.
    """

    return _db_disponivel()


# ================================================================
# DOCUMENTOS APRENDIDOS
# ================================================================

def obter_documento_aprendido(chave: str) -> Optional[Dict[str, Any]]:
    """
    Retorna os metadados de um documento aprendido.
    """

    if not chave:
        return None

    if not _db_disponivel():
        return None

    try:
        with _lock:
            with _conn() as conn:
                with conn.cursor() as cur:

                    cur.execute(
                        """
                        SELECT
                            chave,
                            tipo,
                            titulo,
                            fonte_url,
                            content_hash,
                            criado_em,
                            atualizado_em
                        FROM aprendidos_iana
                        WHERE chave = %s
                        LIMIT 1
                        """,
                        (chave,)
                    )

                    return cur.fetchone()

    except Exception as e:
        sys.stderr.write(
            f"[memory] erro obter_documento_aprendido: {e}\n"
        )

        return None


def ja_aprendeu_mysql(chave: str) -> bool:
    """
    Verifica se uma fonte/documento já foi registrada.
    """

    return obter_documento_aprendido(chave) is not None


def registrar_aprendizado_mysql(
    chave: str,
    tipo: str = "documento",
    titulo: Optional[str] = None,
    fonte_url: Optional[str] = None,
    content_hash: Optional[str] = None,
) -> bool:
    """
    Registra ou atualiza um documento aprendido.
    """

    if not chave:
        return False

    if not _db_disponivel():
        return False

    try:
        with _lock:
            with _conn() as conn:
                with conn.cursor() as cur:

                    cur.execute(
                        """
                        INSERT INTO aprendidos_iana
                        (
                            chave,
                            tipo,
                            titulo,
                            fonte_url,
                            content_hash
                        )
                        VALUES
                        (
                            %s,
                            %s,
                            %s,
                            %s,
                            %s
                        )

                        ON DUPLICATE KEY UPDATE

                            tipo = VALUES(tipo),

                            titulo = VALUES(titulo),

                            fonte_url = VALUES(fonte_url),

                            content_hash = VALUES(content_hash),

                            atualizado_em = CURRENT_TIMESTAMP
                        """,
                        (
                            chave,
                            tipo,
                            titulo,
                            fonte_url,
                            content_hash
                        )
                    )

        return True

    except Exception as e:
        sys.stderr.write(
            f"[memory] erro registrar aprendizado: {e}\n"
        )

        return False


# ================================================================
# MEMÓRIA / FATOS
# ================================================================

def save_memory(
    texto: str,
    categoria: str,
    jogo: Optional[str] = None,
    fonte_url: Optional[str] = None,
    doc_id: Optional[str] = None,
    user_id: str = GLOBAL_USER_ID,
) -> bool:
    """
    Salva um fato ou documento no MySQL.

    Por padrão, conhecimento minerado fica em __global__,
    porque pertence à base de conhecimento da Iana e não
    a um usuário específico.
    """

    texto = str(texto or "").strip()

    if not texto:
        return False

    if not _db_disponivel():
        return False

    try:
        with _lock:
            with _conn() as conn:
                with conn.cursor() as cur:

                    cur.execute(
                        """
                        INSERT INTO fatos_iana
                        (
                            user_id,
                            categoria,
                            jogo,
                            texto,
                            fonte_url,
                            doc_id
                        )
                        VALUES
                        (
                            %s,
                            %s,
                            %s,
                            %s,
                            %s,
                            %s
                        )

                        ON DUPLICATE KEY UPDATE

                            texto = VALUES(texto),

                            categoria = VALUES(categoria),

                            jogo = VALUES(jogo),

                            fonte_url = VALUES(fonte_url),

                            atualizado_em = CURRENT_TIMESTAMP
                        """,
                        (
                            str(user_id),
                            categoria or "geral",
                            jogo,
                            texto,
                            fonte_url,
                            doc_id
                        )
                    )

        return True

    except Exception as e:
        sys.stderr.write(
            f"[memory] erro save_memory: {e}\n"
        )

        return False


def get_memory(
    query: str,
    id_usuario_numerico=None,
    limit: int = 10,
) -> List[str]:
    """
    Busca memórias relacionadas à pergunta.

    Usa uma pontuação simples por palavras.
    O conhecimento semântico principal continua vindo
    do ChromaDB.
    """

    query = str(query or "").strip()

    if not query:
        return []

    if not _db_disponivel():
        return []

    try:
        limit = max(1, min(int(limit), 50))

        with _lock:
            with _conn() as conn:
                with conn.cursor() as cur:

                    if id_usuario_numerico is not None:

                        cur.execute(
                            """
                            SELECT
                                jogo,
                                categoria,
                                texto,
                                fonte_url
                            FROM fatos_iana
                            WHERE
                                user_id = %s
                                OR user_id = %s
                            ORDER BY criado_em DESC
                            LIMIT 500
                            """,
                            (
                                GLOBAL_USER_ID,
                                str(id_usuario_numerico)
                            )
                        )

                    else:

                        cur.execute(
                            """
                            SELECT
                                jogo,
                                categoria,
                                texto,
                                fonte_url
                            FROM fatos_iana
                            WHERE user_id = %s
                            ORDER BY criado_em DESC
                            LIMIT 500
                            """,
                            (GLOBAL_USER_ID,)
                        )

                    rows = cur.fetchall()

        query_lower = query.lower()

        palavras = {
            palavra.strip(
                ".,!?;:()[]{}\"'“”‘’"
            )
            for palavra in query_lower.split()
            if len(
                palavra.strip(
                    ".,!?;:()[]{}\"'“”‘’"
                )
            ) >= 2
        }

        candidatos = []

        for row in rows:

            texto = str(row.get("texto") or "")
            jogo = str(row.get("jogo") or "")
            categoria = str(row.get("categoria") or "")

            texto_lower = texto.lower()
            jogo_lower = jogo.lower()
            categoria_lower = categoria.lower()

            score = 0

            for palavra in palavras:

                if palavra in texto_lower:
                    score += 1

                if palavra in jogo_lower:
                    score += 4

                if palavra in categoria_lower:
                    score += 1

            if jogo and jogo_lower in query_lower:
                score += 8

            if score > 0:
                candidatos.append(
                    (
                        score,
                        texto,
                        jogo,
                        row.get("fonte_url")
                    )
                )

        candidatos.sort(
            key=lambda item: item[0],
            reverse=True
        )

        resultado = []

        for _, texto, jogo, fonte in candidatos[:limit]:

            if jogo:

                resultado.append(
                    f"[MEMÓRIA — {jogo}]\n"
                    f"{texto}"
                )

            else:

                resultado.append(texto)

        return resultado

    except Exception as e:
        sys.stderr.write(
            f"[memory] erro get_memory: {e}\n"
        )

        return []


# ================================================================
# HISTÓRICO
# ================================================================

def get_historico_conversa(
    id_conversa: str,
    limit: int = 8,
) -> List[Dict[str, Any]]:
    """
    Retorna o histórico da conversa.
    """

    if not id_conversa:
        return []

    if not _db_disponivel():
        return []

    try:
        limit = max(1, min(int(limit), 50))

        with _lock:
            with _conn() as conn:
                with conn.cursor() as cur:

                    cur.execute(
                        f"""
                        SELECT
                            remetente,
                            mensagem,
                            criado_em
                        FROM mensagens
                        WHERE conversa_id = %s
                        ORDER BY id DESC
                        LIMIT {limit}
                        """,
                        (id_conversa,)
                    )

                    rows = cur.fetchall()

        rows.reverse()

        return rows

    except Exception as e:
        sys.stderr.write(
            f"[memory] erro histórico: {e}\n"
        )

        return []


def salvar_mensagem(
    conversa_id: str,
    mensagem: str,
    remetente: str,
    usuario_id=None,
) -> bool:
    """
    Salva uma mensagem da conversa.

    remetente:
        user
        iana
    """

    conversa_id = str(conversa_id or "").strip()
    mensagem = str(mensagem or "").strip()

    if not conversa_id or not mensagem:
        return False

    if remetente not in ("user", "iana"):
        raise ValueError(
            "remetente deve ser 'user' ou 'iana'"
        )

    if not _db_disponivel():
        return False

    try:
        with _lock:
            with _conn() as conn:
                with conn.cursor() as cur:

                    cur.execute(
                        """
                        INSERT INTO mensagens
                        (
                            conversa_id,
                            usuario_id,
                            remetente,
                            mensagem
                        )
                        VALUES
                        (
                            %s,
                            %s,
                            %s,
                            %s
                        )
                        """,
                        (
                            conversa_id,
                            usuario_id,
                            remetente,
                            mensagem
                        )
                    )

        return True

    except Exception as e:
        sys.stderr.write(
            f"[memory] erro salvar_mensagem: {e}\n"
        )

        return False


# ================================================================
# ESTATÍSTICAS
# ================================================================

def estatisticas_memoria() -> Dict[str, int]:
    """
    Retorna quantidade de documentos, fatos e mensagens.
    """

    resultado = {
        "documentos_aprendidos": 0,
        "fatos": 0,
        "mensagens": 0,
    }

    if not _db_disponivel():
        return resultado

    try:
        with _lock:
            with _conn() as conn:
                with conn.cursor() as cur:

                    cur.execute(
                        "SELECT COUNT(*) AS total FROM aprendidos_iana"
                    )

                    row = cur.fetchone()

                    resultado["documentos_aprendidos"] = int(
                        row["total"]
                    )

                    cur.execute(
                        "SELECT COUNT(*) AS total FROM fatos_iana"
                    )

                    row = cur.fetchone()

                    resultado["fatos"] = int(
                        row["total"]
                    )

                    cur.execute(
                        "SELECT COUNT(*) AS total FROM mensagens"
                    )

                    row = cur.fetchone()

                    resultado["mensagens"] = int(
                        row["total"]
                    )

        return resultado

    except Exception as e:
        sys.stderr.write(
            f"[memory] erro estatísticas: {e}\n"
        )

        return resultado


# ================================================================
# TESTE DIRETO
# ================================================================

if __name__ == "__main__":

    print("=" * 60)
    print("🧠 TESTE DA MEMÓRIA MYSQL DA IANA")
    print("=" * 60)

    if testar_conexao():

        print("✅ MySQL conectado.")

        stats = estatisticas_memoria()

        print(
            f"📚 Documentos aprendidos: "
            f"{stats['documentos_aprendidos']}"
        )

        print(
            f"🧠 Fatos/memórias: "
            f"{stats['fatos']}"
        )

        print(
            f"💬 Mensagens: "
            f"{stats['mensagens']}"
        )

    else:

        print("❌ Não foi possível conectar ao MySQL.")