import os
import ssl as ssl_lib
import threading
from contextlib import contextmanager
import pymysql
import pymysql.cursors

_lock = threading.Lock()
GLOBAL_USER_ID = "__global__"

_DB_CONFIG = dict(
    host=os.getenv("DB_HOST", "localhost"),
    port=int(os.getenv("DB_PORT", 3306)),
    user=os.getenv("DB_USER", "root"),
    password=os.getenv("DB_PASS", ""),
    database=os.getenv("DB_NAME", "defaultdb"),
    charset="utf8mb4",
    cursorclass=pymysql.cursors.DictCursor,
    autocommit=True,
)

if os.getenv("DB_SSL", "").lower() == "true":
    _ctx = ssl_lib.create_default_context()
    _ctx.check_hostname = False
    _ctx.verify_mode = ssl_lib.CERT_NONE
    _DB_CONFIG["ssl"] = _ctx

_tabela_fatos_ok = False

@contextmanager
def _conn():
    conn = pymysql.connect(**_DB_CONFIG)
    try:
        yield conn
    finally:
        conn.close()

def _garantir_tabelas():
    global _tabela_fatos_ok
    if _tabela_fatos_ok: return
    with _lock, _conn() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fatos_iana (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(191) NOT NULL,
                categoria VARCHAR(32) NOT NULL,
                jogo VARCHAR(191),
                texto TEXT NOT NULL,
                fonte_url VARCHAR(512),
                doc_id VARCHAR(64) NULL,
                criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_doc_id (doc_id),
                INDEX idx_user (user_id),
                INDEX idx_jogo (jogo)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS aprendidos_iana (
                id INT AUTO_INCREMENT PRIMARY KEY,
                chave VARCHAR(255) NOT NULL,
                tipo VARCHAR(32) NOT NULL,
                criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_chave (chave)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
    _tabela_fatos_ok = True

def _db_disponivel():
    try:
        _garantir_tabelas()
        return True
    except Exception as e:
        import sys
        sys.stderr.write(f'[AVISO] memory.py: MySQL indisponível: {e}\n')
        return False

def ja_aprendeu_mysql(chave):
    if not _db_disponivel(): return False
    with _lock, _conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM aprendidos_iana WHERE chave = %s", (chave,))
        return cur.fetchone() is not None

def registrar_aprendizado_mysql(chave, tipo="url"):
    if not _db_disponivel(): return
    with _lock, _conn() as conn, conn.cursor() as cur:
        cur.execute("INSERT IGNORE INTO aprendidos_iana (chave, tipo) VALUES (%s, %s)", (chave, tipo))

def get_memory(query, id_usuario_numerico=None, limit=10):
    if not _db_disponivel(): return []
    with _lock, _conn() as conn, conn.cursor() as cur:
        clausula_user = "OR user_id = %s" if id_usuario_numerico else ""
        params = (GLOBAL_USER_ID, id_usuario_numerico) if id_usuario_numerico else (GLOBAL_USER_ID,)
        cur.execute(f"SELECT jogo, texto FROM fatos_iana WHERE user_id = %s {clausula_user}", params)
        rows = cur.fetchall()
        
        # Busca por palavras-chave na memória
        query_words = set(query.lower().split())
        candidatos = []
        for r in rows:
            text_lower = r['texto'].lower()
            score = sum(1 for word in query_words if word in text_lower)
            if r['jogo'] and r['jogo'].lower() in query.lower(): score += 5
            if score > 0: candidatos.append((score, r['texto']))
        
        candidatos.sort(key=lambda x: x[0], reverse=True)
        return [c[1] for c in candidatos[:limit]]

def get_historico_conversa(id_conversa, limit=8):
    if not _db_disponivel(): return []
    with _lock, _conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT remetente, mensagem FROM mensagens WHERE conversa_id = %s ORDER BY criado_em DESC LIMIT %s", (id_conversa, limit))
        return cur.fetchall()[::-1]

def save_memory(texto, categoria, jogo=None, fonte_url=None, doc_id=None, user_id=GLOBAL_USER_ID):
    if not _db_disponivel(): return
    with _lock, _conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO fatos_iana (user_id, categoria, jogo, texto, fonte_url, doc_id) "
            "VALUES (%s, %s, %s, %s, %s, %s) ON DUPLICATE KEY UPDATE texto=%s",
            (user_id, categoria, jogo, texto, fonte_url, doc_id, texto)
        )
