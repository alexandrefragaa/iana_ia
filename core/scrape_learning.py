# scrape_learning.py
# Roda localmente: python scrape_learning.py
# Lê links_para_mineracao.txt e titulos_para_buscar.txt
# Extrai o conteúdo real e salva no ChromaDB da Iana

import requests
import hashlib
import time
import sys
import os
from pathlib import Path
from bs4 import BeautifulSoup

# Importa o motor de aprendizado
try:
    from learning_engine import learn
except ImportError:
    try:
        from core.learning_engine import learn
    except ImportError:
        print("❌ learning_engine.py não encontrado.")
        sys.exit(1)

# ── CONFIGURAÇÃO ───────────────────────────────────────────────────
PASTA_DATA = Path(__file__).parent / "data"
PASTA_DATA.mkdir(exist_ok=True)

ARQUIVO_LINKS   = PASTA_DATA / "links_para_mineracao.txt"
ARQUIVO_TITULOS = PASTA_DATA / "titulos_para_buscar.txt"
ARQUIVO_FEITOS  = PASTA_DATA / "links_concluidos.txt"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
}

# ── UTILITÁRIOS ────────────────────────────────────────────────────
def ja_processado(url):
    if not ARQUIVO_FEITOS.exists():
        return False
    return url in ARQUIVO_FEITOS.read_text(encoding='utf-8')

def marcar_como_feito(url):
    with open(ARQUIVO_FEITOS, 'a', encoding='utf-8') as f:
        f.write(url + '\n')

def uid(texto):
    return "url_" + hashlib.md5(texto.encode('utf-8')).hexdigest()

# ── EXTRAÇÃO DE CONTEÚDO ───────────────────────────────────────────
def extrair_conteudo(url):
    """
    Faz o scraping real da página e retorna (titulo, conteudo).
    Extrai parágrafos, listas, títulos — tudo que tem texto útil.
    """
    try:
        r = requests.get(url, headers=HEADERS, timeout=12)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")

        # Remove scripts, estilos, menus, rodapés
        for tag in soup(["script","style","nav","footer","header","aside","form","iframe"]):
            tag.decompose()

        titulo = soup.title.text.strip() if soup.title else url.split("/")[-1]

        # Extrai parágrafos e listas com conteúdo real
        blocos = []

        # Títulos da página (h1, h2, h3) — dão contexto
        for h in soup.find_all(["h1","h2","h3"]):
            txt = h.get_text(strip=True)
            if len(txt) > 5:
                blocos.append(f"## {txt}")

        # Parágrafos longos
        for p in soup.find_all("p"):
            txt = p.get_text(strip=True)
            if len(txt) > 40:
                blocos.append(txt)

        # Listas (itens de conquistas, builds, etc)
        for li in soup.find_all("li"):
            txt = li.get_text(strip=True)
            if len(txt) > 20:
                blocos.append(f"• {txt}")

        # Tabelas (muito comuns em wikis de jogos)
        for tr in soup.find_all("tr"):
            celulas = [td.get_text(strip=True) for td in tr.find_all(["td","th"]) if td.get_text(strip=True)]
            if celulas:
                blocos.append(" | ".join(celulas))

        conteudo = "\n".join(blocos)

        # Limita o tamanho para não estourar o ChromaDB
        if len(conteudo) > 6000:
            conteudo = conteudo[:6000] + "\n...[continua]"

        return titulo, conteudo

    except requests.exceptions.Timeout:
        print(f"  ⏱️ Timeout: {url}")
    except requests.exceptions.HTTPError as e:
        print(f"  ❌ HTTP {e.response.status_code}: {url}")
    except Exception as e:
        print(f"  ❌ Erro ao extrair {url}: {e}")

    return None, None

# ── FASE 1: LINKS ──────────────────────────────────────────────────
def minerar_links():
    if not ARQUIVO_LINKS.exists():
        print(f"⚠️  Arquivo não encontrado: {ARQUIVO_LINKS}")
        return 0, 0

    urls = [
        linha.strip()
        for linha in ARQUIVO_LINKS.read_text(encoding='utf-8').splitlines()
        if linha.strip().startswith("http")
    ]

    print(f"\n🔗 FASE 1 — Links para minerar: {len(urls)}")
    print("─" * 50)

    ok  = 0
    err = 0

    for i, url in enumerate(urls, 1):
        print(f"[{i}/{len(urls)}] {url[:70]}...")

        if ja_processado(url):
            print(f"  ⏭️  Já processado — pulando")
            continue

        titulo, conteudo = extrair_conteudo(url)

        if not conteudo or len(conteudo) < 80:
            print(f"  ⚠️  Conteúdo insuficiente — pulando")
            err += 1
            time.sleep(0.5)
            continue

        sucesso = learn(
            titulo   = titulo,
            conteudo = conteudo,
            categoria= "web_mining",
            id_documento = uid(url)
        )

        if sucesso:
            marcar_como_feito(url)
            print(f"  ✅ Aprendido: {titulo[:60]}")
            ok += 1
        else:
            err += 1

        time.sleep(1)  # respeita os servidores

    print(f"\n  ✅ OK: {ok} | ❌ Erro: {err}")
    return ok, err

# ── FASE 2: TÓPICOS ────────────────────────────────────────────────
def minerar_topicos():
    if not ARQUIVO_TITULOS.exists():
        print(f"⚠️  Arquivo não encontrado: {ARQUIVO_TITULOS}")
        return 0

    topicos = [
        linha.strip()
        for linha in ARQUIVO_TITULOS.read_text(encoding='utf-8').splitlines()
        if linha.strip() and not linha.startswith("#")
    ]

    print(f"\n📚 FASE 2 — Tópicos para aprender: {len(topicos)}")
    print("─" * 50)

    ok = 0

    for i, topico in enumerate(topicos, 1):
        print(f"[{i}/{len(topicos)}] {topico}")

        # Tenta buscar conteúdo real do tópico via Wikipedia em português
        conteudo = buscar_wikipedia(topico)

        if not conteudo:
            # Se não achou no Wikipedia, salva o tópico como contexto estruturado
            conteudo = gerar_conteudo_estruturado(topico)

        sucesso = learn(
            titulo   = topico,
            conteudo = conteudo,
            categoria= "topico",
            id_documento = "topic_" + hashlib.md5(topico.lower().encode('utf-8')).hexdigest()
        )

        if sucesso:
            print(f"  ✅ Aprendido")
            ok += 1
        else:
            print(f"  ⚠️  Falha")

        time.sleep(0.3)

    print(f"\n  ✅ Aprendidos: {ok}/{len(topicos)}")
    return ok

def buscar_wikipedia(topico):
    """Busca resumo real do tópico na Wikipedia em português."""
    try:
        url = "https://pt.wikipedia.org/w/api.php"
        params = {
            "action": "query",
            "prop":   "extracts",
            "exintro": True,
            "explaintext": True,
            "redirects": 1,
            "titles": topico,
            "format": "json"
        }
        r = requests.get(url, params=params, timeout=8, headers=HEADERS)
        data = r.json()
        pages = data.get("query", {}).get("pages", {})
        for page in pages.values():
            extract = page.get("extract", "")
            if extract and len(extract) > 100:
                return extract[:4000]
    except Exception:
        pass
    return None

def gerar_conteudo_estruturado(topico):
    """
    Gera um conteúdo estruturado quando não acha na web.
    Garante que a Iana ao menos saiba que o tópico existe
    e tenha contexto para elaborar sobre ele.
    """
    return (
        f"Tópico de conhecimento: {topico}\n\n"
        f"Este é um assunto relevante no universo gamer e de entretenimento. "
        f"Contexto: {topico} é um termo/assunto que pode estar relacionado a "
        f"jogos, conquistas, estratégias, personagens, mecânicas de gameplay, "
        f"itens, localizações ou lore de jogos. "
        f"Quando perguntada sobre {topico}, a Iana deve usar criatividade e "
        f"conhecimento geral sobre games para dar uma resposta útil e envolvente."
    )

# ── FASE 3: RESUMO ─────────────────────────────────────────────────
def mostrar_resumo(ok_links, err_links, ok_topicos):
    print("\n" + "="*50)
    print("📊 RESUMO DA MINERAÇÃO")
    print("="*50)
    print(f"  🔗 Links processados:  {ok_links} ✅  {err_links} ❌")
    print(f"  📚 Tópicos aprendidos: {ok_topicos} ✅")
    print(f"  🧠 Total integrado:    {ok_links + ok_topicos} itens")
    print("="*50)
    print("✨ A Iana agora sabe mais! Reinicie o servidor para")
    print("   que as mudanças reflitam nas respostas do chat.")

# ── MAIN ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("="*50)
    print("⚡ IANA — SISTEMA DE MINERAÇÃO E APRENDIZADO")
    print("="*50)

    ok_links, err_links = minerar_links()
    ok_topicos          = minerar_topicos()

    mostrar_resumo(ok_links, err_links, ok_topicos)