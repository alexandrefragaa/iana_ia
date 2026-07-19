"""
memory.py

Memória persistente da Iana, usando o MESMO MySQL (Aiven) que o
server.js já usa — mesmas env vars: DB_HOST, DB_PORT, DB_USER, DB_PASS,
DB_NAME, DB_SSL.

IMPORTANTE sobre o schema: o server.js já tem tabelas `conversas` e
`mensagens` com estrutura própria (conversas: id, usuario_id, titulo,
fixada / mensagens: id, conversa_id, usuario_id, remetente, mensagem,
criado_em). Este arquivo NÃO cria tabelas com esses nomes de novo —
isso colidiria com o schema existente e duplicaria o que o server.js
já grava a cada mensagem.

Em vez disso:
- Histórico de conversa: LÊ direto da tabela `mensagens` já existente
  (só leitura — quem grava é o server.js, como já faz hoje).
- Conhecimento novo (jogos, conquistas, links extraídos, fatos globais
  tipo "Jason está no DbD"): fica numa tabela NOVA, `fatos_iana`, que
  não existe ainda no seu banco.
- Controle de aprendizado: fica numa tabela NOVA, `aprendidos_iana`, 
  garantindo persistência real para o que o scraper já processou.

Resiliência: se o MySQL cair no meio de uma conversa, a Iana NÃO
quebra — só perde a personalização daquela mensagem específica.
"""
import os
import ssl as ssl_lib
import threading
from contextlib import contextmanager

import pymysql
import pymysql.cursors

_lock = threading.Lock()

GLOBAL_USER_ID = "__global__"

# Mesmos nomes de env var que o server.js já usa.
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
    # Equivalente ao `ssl: { rejectUnauthorized: false }` do server.js
    # (Aiven exige TLS, mas sem validar a cadeia de certificado local).
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
    if _tabela_fatos_ok:
        return
    with _lock, _conn() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fatos_iana (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(191) NOT NULL,
                categoria VARCHAR(32) NOT NULL,
                jogo VARCHAR(191),
                texto TEXT NOT NULL,
                fonte_url VARCHAR(512),
                doc_id VARCHAR(64) NULL,      -- espelha o id_documento do ChromaDB (upsert determinístico)
                criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_doc_id (doc_id),
                INDEX idx_user (user_id),
                INDEX idx_jogo (jogo),
                INDEX idx_categoria (categoria)
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

def ja_aprendeu_mysql(chave):
    if not _db_disponivel():
        return False
    with _lock, _conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM aprendidos_iana WHERE chave = %s", (chave,))
        return cur.fetchone() is not None

def registrar_aprendizado_mysql(chave, tipo="url"):
    if not _db_disponivel():
        return
    with _lock, _conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT IGNORE INTO aprendidos_iana (chave, tipo) VALUES (%s, %s)",
            (chave, tipo)
        )


def _db_disponivel():
    try:
        _garantir_tabelas()
        return True
    except Exception as e:
        import sys
        sys.stderr.write(f'[AVISO] memory.py: MySQL indisponível: {e}\n')
        return False


# -----------------------------
# RANKING POR PALAVRAS-CHAVE
# -----------------------------
def _score(query: str, texto: str, jogo):
    palavras_query = set(query.lower().split())
    palavras_texto = set(texto.lower().split())
    score = len(palavras_query & palavras_texto)
    if jogo and jogo.lower() in query.lower():
        score += 5
    return score


# -----------------------------
# BUSCA — fatos (jogos/conquistas/links/globais) + mensagens antigas
# -----------------------------
def get_memory(query, id_usuario_numerico=None, limit=6):
    """
    id_usuario_numerico: o id real da tabela `usuarios` (req.user.id no
    server.js), NÃO o nome de exibição. Sem ele, a busca cobre só os
    fatos globais (GLOBAL_USER_ID) — sem histórico entre conversas,
    já que não dá pra saber com segurança quais mensagens são da
    mesma pessoa só pelo nome.
    """
    if not _db_disponivel():
        return []

    with _lock, _conn() as conn, conn.cursor() as cur:
        # 1. Busca fatos (globais + do usuário)
        clausula_user = "OR user_id = %s" if id_usuario_numerico else ""
        params = (GLOBAL_USER_ID, id_usuario_numerico) if id_usuario_numerico else (GLOBAL_USER_ID,)
        
        cur.execute(f"SELECT jogo, texto FROM fatos_iana WHERE user_id = %s {clausula_user}", params)
        rows = cur.fetchall()
        
        candidatos = []
        for r in rows:
            s = _score(query, r['texto'], r['jogo'])
            if s > 0:
                candidatos.append((s, r['texto']))
        
        candidatos.sort(key=lambda x: x[0], reverse=True)
        return [c[1] for c in candidatos[:limit]]


def get_historico_conversa(id_conversa, limit=8):
    if not _db_disponivel():
        return []
    with _lock, _conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT remetente, mensagem FROM mensagens WHERE conversa_id = %s ORDER BY criado_em DESC LIMIT %s",
            (id_conversa, limit)
        )
        rows = cur.fetchall()
        return rows[::-1]


# -----------------------------
# INGESTÃO — jogos_alvos.txt
# -----------------------------
def ingest_jogos(caminho_arquivo, reset=True):
    from pathlib import Path
    jogos = [l.strip() for l in Path(caminho_arquivo).read_text(encoding="utf-8").splitlines() if l.strip()]
    if not _db_disponivel():
        return 0
    with _lock, _conn() as conn, conn.cursor() as cur:
        if reset:
            cur.execute(
                "DELETE FROM fatos_iana WHERE user_id = %s AND categoria = 'jogo_conhecido'",
                (GLOBAL_USER_ID,),
            )
        cur.executemany(
            "INSERT INTO fatos_iana (user_id, categoria, jogo, texto) VALUES (%s, 'jogo_conhecido', %s, %s)",
            [(GLOBAL_USER_ID, jogo, f"A Iana conhece e pode dar dicas sobre o jogo: {jogo}.") for jogo in jogos],
        )
    return len(jogos)


# -----------------------------
# INGESTÃO — conquistas.txt
# -----------------------------
def ingest_conquistas(caminho_arquivo, reset=True):
    from pathlib import Path
    linhas = [l.strip() for l in Path(caminho_arquivo).read_text(encoding="utf-8").splitlines() if l.strip()]

    registros = []
    for linha in linhas:
        partes = [p.strip() for p in linha.split("|")]
        if len(partes) < 3:
            continue
        jogo = partes[0].replace("Jogo:", "").strip()
        trofeu = partes[1].split(":", 1)[-1].strip()
        como = partes[2].split(":", 1)[-1].strip()
        texto = f"[{jogo}] Troféu/Conquista \"{trofeu}\" — Como conseguir: {como}"
        registros.append((GLOBAL_USER_ID, "conquista", jogo, texto))

    if not _db_disponivel():
        return 0
    with _lock, _conn() as conn, conn.cursor() as cur:
        if reset:
            cur.execute(
                "DELETE FROM fatos_iana WHERE user_id = %s AND categoria = 'conquista'",
                (GLOBAL_USER_ID,),
            )
        cur.executemany(
            "INSERT INTO fatos_iana (user_id, categoria, jogo, texto) VALUES (%s, %s, %s, %s)",
            registros,
        )
    return len(registros)


# -----------------------------
# INGESTÃO — links de páginas
# -----------------------------
def ingest_link(url, texto_extraido, jogo=None):
    trecho = texto_extraido.strip()
    save_memory(
        texto=f"Conteúdo de {url}:\n{trecho[:4000]}",
        categoria="link",
        jogo=jogo,
        fonte_url=url,
    )

def save_memory(texto, categoria, jogo=None, fonte_url=None, doc_id=None, user_id=GLOBAL_USER_ID):
    if not _db_disponivel():
        return
    with _lock, _conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO fatos_iana (user_id, categoria, jogo, texto, fonte_url, doc_id) "
            "VALUES (%s, %s, %s, %s, %s, %s) ON DUPLICATE KEY UPDATE texto=%s",
            (user_id, categoria, jogo, texto, fonte_url, doc_id, texto)
        )


# -----------------------------
# FATOS-BASE
# -----------------------------
_FATOS_BASE = [
    (
        "atualizacao",
        "Dead by Daylight",
        "Jason Voorhees (\"The Slasher\") é um Killer oficial e jogável em Dead by Daylight (DbD), "
        "lançado em 16 de junho de 2026 no Capítulo 40, celebrando os 10 anos do jogo. Ele NÃO é "
        "exclusivo do jogo \"Friday the 13th: The Game\" — está no roster atual do DbD, é o Killer "
        "#43. Poder: Omnipresent Evil (fica invisível/Undetectable e mais rápido; não vê Sobreviventes, "
        "só rastros/pegadas). Habilidade especial 1: Impaling Throw — pega um projétil (Spike) de "
        "Pilhas de Sucata ou Ganchos, e ao acertar um Sobrevivente pode machucar/empurrar; se o "
        "empurrão jogar um Sobrevivente ferido contra uma parede, ele fica impalado e PRESO (\"pinned\") "
        "até ser resgatado ou coletado. Habilidade especial 2: Jump Scare — dentro de Omnipresent Evil, "
        "mirar num Pallet, Parede Quebrável ou Vault teleporta o Jason até lá, quebra/vaulta "
        "automaticamente e revela Sobreviventes próximos via Killer Instinct. "
        "Perks exclusivos: Hex: Scared to Death, Silent Shadow, Rampage. "
        "Conquistas relacionadas: \"Not So Fast\", \"In Pursuit\", \"Adept Slasher\".",
    ),
]


def seed_fatos_base():
    if not _db_disponivel():
        return
    with _lock, _conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM fatos_iana WHERE user_id = %s AND categoria = 'atualizacao' LIMIT 1",
            (GLOBAL_USER_ID,),
        )
        if cur.fetchone():
            return
        cur.executemany(
            "INSERT INTO fatos_iana (user_id, categoria, jogo, texto) VALUES (%s, %s, %s, %s)",
            [(GLOBAL_USER_ID, cat, jogo, texto) for cat, jogo, texto in _FATOS_BASE],
        )
    print(f"✅ memory.py: {len(_FATOS_BASE)} fato(s) base plantado(s) em fatos_iana")
