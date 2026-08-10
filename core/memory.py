# memory.py
# Memória persistente da Iana usando MySQL.
#
# Responsabilidades:
# - fatos/memórias permanentes
# - URLs/documentos já aprendidos
# - histórico de mensagens
# - consulta simples por palavras-chave
#
# O ChromaDB continua sendo responsabilidade do iana.py/learning_engine.py.

import os
import ssl as ssl_lib
import threading
import sys
from contextlib import contextmanager

import pymysql
import pymysql.cursors


_lock = threading.RLock()

GLOBAL_USER_ID = "__global__"


# ============================================================
# CONFIGURAÇÃO MYSQL
# ============================================================

_DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", "3306")),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASS", ""),
    "database": os.getenv("DB_NAME", "defaultdb"),
    "charset": "utf8mb4",
    "cursorclass": pymysql.cursors.DictCursor,
    "autocommit": True,
    "connect_timeout": 10,
    "read_timeout": 20,
    "write_timeout": 20,
}


# SSL opcional
if os.getenv("DB_SSL", "").lower() == "true":
    _ctx = ssl_lib.create_default_context()

    # Mantém compatibilidade com sua configuração atual.
    # Para produção, o ideal é usar certificado válido.
    _ctx.check_hostname = False
    _ctx.verify_mode = ssl_lib.CERT_NONE

    _DB_CONFIG["ssl"] = _ctx


_tabelas_ok = False


# ============================================================
# CONEXÃO
# ============================================================

@contextmanager
def _conn():
    conn = pymysql.connect(**_DB_CONFIG)

    try:
        yield conn
    finally:
        conn.close()


# ============================================================
# TABELAS
# ============================================================

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
                # MEMÓRIAS / FATOS
                # ------------------------------------------------

                cur.execute("""
                    CREATE TABLE IF NOT EXISTS fatos_iana (
                        id INT AUTO_INCREMENT PRIMARY KEY,

                        user_id VARCHAR(191) NOT NULL,

                        categoria VARCHAR(32) NOT NULL,

                        jogo VARCHAR(191) NULL,

                        texto TEXT NOT NULL,

                        fonte_url VARCHAR(512) NULL,

                        doc_id VARCHAR(64) NULL,

                        criado_em TIMESTAMP
                            DEFAULT CURRENT_TIMESTAMP,

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
                        id INT AUTO_INCREMENT PRIMARY KEY,

                        chave VARCHAR(255) NOT NULL,

                        tipo VARCHAR(32) NOT NULL,

                        criado_em TIMESTAMP
                            DEFAULT CURRENT_TIMESTAMP,

                        UNIQUE KEY uq_chave (chave)

                    ) ENGINE=InnoDB
                      DEFAULT CHARSET=utf8mb4
                      COLLATE=utf8mb4_unicode_ci
                """)

                # ------------------------------------------------
                # HISTÓRICO
                #
                # Se a tabela já existir, CREATE IF NOT EXISTS
                # não altera a tabela existente.
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


# ============================================================
# DISPONIBILIDADE
# ============================================================

def _db_disponivel():
    try:
        _garantir_tabelas()
        return True

    except Exception as e:
        sys.stderr.write(
            f"[AVISO] memory.py: MySQL indisponível: {e}\n"
        )
        return False


# ============================================================
# APRENDIZADO
# ============================================================

def ja_aprendeu_mysql(chave):
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
                        SELECT 1
                        FROM aprendidos_iana
                        WHERE chave = %s
                        LIMIT 1
                        """,
                        (chave,)
                    )

                    return cur.fetchone() is not None

    except Exception as e:
        sys.stderr.write(
            f"[memory] erro ja_aprendeu_mysql: {e}\n"
        )
        return False


def registrar_aprendizado_mysql(chave, tipo="url"):
    if not chave:
        return

    if not _db_disponivel():
        return

    try:
        with _lock:
            with _conn() as conn:
                with conn.cursor() as cur:

                    cur.execute(
                        """
                        INSERT IGNORE INTO aprendidos_iana
                            (chave, tipo)
                        VALUES
                            (%s, %s)
                        """,
                        (chave, tipo)
                    )

    except Exception as e:
        sys.stderr.write(
            f"[memory] erro registrar aprendizado: {e}\n"
        )


# ============================================================
# MEMÓRIA SEMÂNTICA / FATOS
# ============================================================

def get_memory(
    query,
    id_usuario_numerico=None,
    limit=10
):
    """
    Busca memórias relacionadas à pergunta.

    Retorna apenas texto.
    """

    if not query:
        return []

    if not _db_disponivel():
        return []

    try:
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
                            """,
                            (GLOBAL_USER_ID,)
                        )

                    rows = cur.fetchall()

        # ----------------------------------------------------
        # Pontuação simples
        # ----------------------------------------------------

        query_lower = query.lower()

        palavras = {
            p.strip(".,!?;:()[]{}\"'")
            for p in query_lower.split()
            if len(p.strip(".,!?;:()[]{}\"'")) >= 2
        }

        candidatos = []

        for row in rows:

            texto = str(row.get("texto") or "")
            jogo = str(row.get("jogo") or "")
            categoria = str(row.get("categoria") or "")

            texto_lower = texto.lower()
            jogo_lower = jogo.lower()

            score = 0

            for palavra in palavras:

                if palavra in texto_lower:
                    score += 1

                if palavra in jogo_lower:
                    score += 4

                if palavra in categoria.lower():
                    score += 1

            # Nome completo do jogo encontrado
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
            key=lambda x: x[0],
            reverse=True
        )

        resultado = []

        for _, texto, jogo, fonte in candidatos[:limit]:

            if jogo:
                resultado.append(
                    f"[MEMÓRIA — {jogo}]\n{texto}"
                )
            else:
                resultado.append(texto)

        return resultado

    except Exception as e:

        sys.stderr.write(
            f"[memory] erro get_memory: {e}\n"
        )

        return []


# ============================================================
# HISTÓRICO
# ============================================================

def get_historico_conversa(
    id_conversa,
    limit=8
):
    """
    Retorna o histórico no mesmo formato usado
    pelo server.js/Gemini.
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
    conversa_id,
    mensagem,
    remetente,
    usuario_id=None
):
    """
    Salva uma mensagem no MySQL.

    remetente:
        user
        iana
    """

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
                            (%s, %s, %s, %s)
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


# ============================================================
# SALVAR MEMÓRIA
# ============================================================

def save_memory(
    texto,
    categoria,
    jogo=None,
    fonte_url=None,
    doc_id=None,
    user_id=GLOBAL_USER_ID
):
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
                            (%s, %s, %s, %s, %s, %s)

                        ON DUPLICATE KEY UPDATE

                            texto = VALUES(texto),

                            categoria = VALUES(categoria),

                            jogo = VALUES(jogo),

                            fonte_url = VALUES(fonte_url)
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