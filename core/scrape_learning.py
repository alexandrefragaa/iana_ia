#!/usr/bin/env python3
import requests
import hashlib
import json
import time
import sys
import os
from pathlib import Path
from bs4 import BeautifulSoup


def resolver_arquivo(nome_arquivo, pasta_raiz=None):
    base = Path(pasta_raiz or Path(__file__).resolve().parent.parent)
    candidatos = [
        base / "data" / nome_arquivo,
        base / nome_arquivo,
        Path(__file__).resolve().parent.parent / "data" / nome_arquivo,
        Path(__file__).resolve().parent.parent / nome_arquivo,
    ]
    for caminho in candidatos:
        if caminho.exists():
            return caminho
    return base / "data" / nome_arquivo

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
PASTA_RAIZ = Path(__file__).resolve().parent.parent
PASTA_DATA = PASTA_RAIZ / "data"
PASTA_DATA.mkdir(exist_ok=True)
print(f"DEBUG: O script está procurando os arquivos em: {PASTA_DATA}")

ARQUIVO_LINKS        = resolver_arquivo("links_para_mineracao.txt")
ARQUIVO_TITULOS      = resolver_arquivo("titulos_para_buscar.txt")
ARQUIVO_FEITOS       = resolver_arquivo("links_concluidos.txt")
ARQUIVOS_PARA_LER    = resolver_arquivo("reworks_dbd.txt")
ARQUIVO_ATUALIZACOES = resolver_arquivo("update_sources.txt")
ARQUIVO_ESTADO_ATU   = resolver_arquivo("update_source_state.json")

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


def hash_texto(texto):
    return hashlib.md5(texto.strip().encode('utf-8')).hexdigest() if texto else ''


def carregar_estado_atualizacoes():
    if not ARQUIVO_ESTADO_ATU.exists():
        return {}
    try:
        return json.loads(ARQUIVO_ESTADO_ATU.read_text(encoding='utf-8'))
    except Exception:
        return {}


def salvar_estado_atualizacoes(estado):
    ARQUIVO_ESTADO_ATU.write_text(json.dumps(estado, indent=2, ensure_ascii=False), encoding='utf-8')


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

        for tag in soup(["script", "style", "nav", "footer", "header", "aside", "form", "iframe"]):
            tag.decompose()

        titulo = soup.title.text.strip() if soup.title else url.split("/")[-1]
        blocos = []

        for h in soup.find_all(["h1", "h2", "h3"]):
            txt = h.get_text(strip=True)
            if len(txt) > 5:
                blocos.append(f"## {txt}")

        for p in soup.find_all("p"):
            txt = p.get_text(strip=True)
            if len(txt) > 40:
                blocos.append(txt)

        for li in soup.find_all("li"):
            txt = li.get_text(strip=True)
            if len(txt) > 20:
                blocos.append(f"• {txt}")

        for tr in soup.find_all("tr"):
            celulas = [td.get_text(strip=True) for td in tr.find_all(["td", "th"]) if td.get_text(strip=True)]
            if celulas:
                blocos.append(" | ".join(celulas))

        conteudo = "\n".join(blocos)

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
        print(f"⚠️ ARQUIVO NÃO ENCONTRADO: {ARQUIVO_LINKS}")
        return 0, 0

    conteudo_arquivo = ARQUIVO_LINKS.read_text(encoding='utf-8')
    linhas = conteudo_arquivo.splitlines()
    
    urls = [linha.strip() for linha in linhas if linha.strip().startswith("http")]
    print(f"🔍 Encontradas {len(urls)} URLs para análise. Iniciando mineração silenciosa...\n")
    
    ok, err, pulados = 0, 0, 0

    for i, url in enumerate(urls, 1):
        if ja_processado(url):
            pulados += 1
            continue

        titulo, conteudo = extrair_conteudo(url)

        if not conteudo or len(conteudo) < 80:
            err += 1
            continue

        status = learn(
            titulo=titulo,
            conteudo=conteudo,
            categoria="web_mining",
            id_documento=uid(url),
            url=url
        )

        if status in ["NOVO", "ATUALIZADO"]:
            marcar_como_feito(url)
            print(f"✅ [{i}/{len(urls)}] Aprendido: {titulo[:60]} ({status})")
            ok += 1
        elif status in ["EXISTE", "PARECIDO"]:
            marcar_como_feito(url)
            print(f"⏭️ [{i}/{len(urls)}] Já conhecido: {titulo[:60]} ({status})")
            pulados += 1
        else:
            err += 1

        time.sleep(1)

    print(f"\n📊 Resultados dos Links: {ok} Novos | {pulados} Já conhecidos | {err} Erros")
    return ok, err


def minerar_atualizacoes():
    if not ARQUIVO_ATUALIZACOES.exists():
        print(f"⚠️ Arquivo não encontrado: {ARQUIVO_ATUALIZACOES}")
        return 0

    fontes = [
        linha.strip() for linha in ARQUIVO_ATUALIZACOES.read_text(encoding='utf-8').splitlines()
        if linha.strip() and not linha.strip().startswith("#")
    ]

    if not fontes:
        print("⚠️ Nenhuma fonte de atualização encontrada.")
        return 0

    estado = carregar_estado_atualizacoes()
    ok = 0

    print(f"\n🔔 Mineração de atualizações: {len(fontes)} fontes")
    for i, url in enumerate(fontes, 1):
        print(f"[{i}/{len(fontes)}] {url}")
        titulo, conteudo = extrair_conteudo(url)
        if not conteudo or len(conteudo) < 120:
            print("  ⚠️ Conteúdo insuficiente ou inválido. Pulando.")
            continue

        digest = hash_texto(conteudo)
        if estado.get(url) == digest:
            print("  ⏭️ Sem mudança desde a última verificação")
            continue

        status = learn(
            titulo=titulo,
            conteudo=conteudo,
            categoria="update",
            id_documento=uid(url),
            url=url
        )

        if status in ["NOVO", "ATUALIZADO"]:
            ok += 1
            print(f"  ✅ {status}")
        else:
            print(f"  ⏭️ {status}")

        estado[url] = digest
        salvar_estado_atualizacoes(estado)
        time.sleep(1)

    print(f"\n📊 Atualizações processadas: {ok} novas/atualizadas")
    return ok


def extrair_textos_reworks(linhas):
    itens = []
    for linha in linhas:
        texto = linha.strip()
        if not texto or texto.startswith("#"):
            continue
        if texto.lower().startswith("jogo:"):
            continue
        if texto.lower().startswith("troféu:"):
            continue
        if texto.lower().startswith("como platinar:"):
            continue
        itens.append(texto)
    return itens


def extrair_links_personagens_dbd(html, base_url):
    """Extrai links de páginas de personagens DBD a partir de páginas de categoria."""
    soup = BeautifulSoup(html, "html.parser")
    links = []
    vistos = set()
    for tag in soup.find_all("a", href=True):
        href = tag.get("href", "")
        if not href:
            continue
        texto = href.strip()
        if texto.startswith("http"):
            url = texto
        elif texto.startswith("/"):
            url = base_url.rstrip("/") + texto
        else:
            continue
        if "deadbydaylight.fandom.com/wiki/" not in url:
            continue
        if any(token in url.lower() for token in ["category:", "special:", "file:", "mediawiki"]):
            continue
        if "wiki/" not in url:
            continue
        if url.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".svg")):
            continue
        if url in vistos:
            continue
        vistos.add(url)
        links.append(url)
    return links


def resumir_texto_personagem_dbd(html, titulo):
    """Extrai um resumo útil de perks, powers e abilities de páginas de personagens DBD."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "aside", "form", "iframe"]):
        tag.decompose()

    blocos = [titulo]
    for heading in soup.find_all(["h1", "h2", "h3"]):
        txt = heading.get_text(" ", strip=True)
        if len(txt) > 3:
            blocos.append(txt)

    for p in soup.find_all("p"):
        txt = p.get_text(" ", strip=True)
        if len(txt) > 35 and any(token in txt.lower() for token in ["perk", "power", "ability", "add-on", "advantage", "killer", "survivor", "effect", "item", "weapon"]):
            blocos.append(txt)

    for li in soup.find_all("li"):
        txt = li.get_text(" ", strip=True)
        if len(txt) > 25 and any(token in txt.lower() for token in ["perk", "power", "ability", "add-on", "advantage", "effect", "item", "weapon"]):
            blocos.append(f"• {txt}")

    resumo = "\n".join(blocos[:120])
    return resumo if len(resumo) > 80 else None


def minerar_personagens_dbd():
    """Busca páginas de killers/survivors e aprende seus dados básicos no banco."""
    urls = [
        "https://deadbydaylight.fandom.com/wiki/Category:Killers",
        "https://deadbydaylight.fandom.com/wiki/Category:Survivors"
    ]

    print("\n🧟 FASE 2.5 — Personagens DBD")
    print("─" * 50)

    ok = 0
    for url in urls:
        try:
            r = requests.get(url, headers=HEADERS, timeout=12)
            r.raise_for_status()
            links = extrair_links_personagens_dbd(r.text, url)
            print(f"[{url}] {len(links)} páginas encontradas")
            for personagem_url in links[:80]:
                try:
                    personagem_req = requests.get(personagem_url, headers=HEADERS, timeout=12)
                    personagem_req.raise_for_status()
                    personagem_soup = BeautifulSoup(personagem_req.text, "html.parser")
                    titulo = personagem_soup.title.get_text(strip=True) if personagem_soup.title else personagem_url.split("/")[-1]
                    texto = resumir_texto_personagem_dbd(personagem_req.text, titulo)
                    if not texto or len(texto) < 80:
                        continue
                    status = learn(
                        titulo=titulo,
                        conteudo=f"Personagem DBD: {titulo}\n\n{texto}",
                        categoria="dbd_personagem",
                        id_documento="dbd_char_" + hashlib.md5(personagem_url.lower().encode('utf-8')).hexdigest(),
                        url=personagem_url
                    )
                    if status in ["NOVO", "ATUALIZADO"]:
                        ok += 1
                except Exception as exc:
                    print(f"  ⚠️ Falha ao processar {personagem_url}: {exc}")
        except Exception as exc:
            print(f"  ⚠️ Falha ao buscar categoria {url}: {exc}")
        time.sleep(1)

    print(f"\n  ✅ Personagens DBD aprendidos: {ok}")
    return ok

def minerar_perks_dbd():
    """Aprende perks, poderes e vantagens diretamente das páginas de perks do DBD."""
    urls = [
        "https://deadbydaylight.fandom.com/wiki/Perks",
        "https://deadbydaylight.fandom.com/wiki/Category:Perks"
    ]

    print("\n🧿 FASE 2.6 — Perks DBD")
    print("─" * 50)

    ok = 0
    for url in urls:
        try:
            r = requests.get(url, headers=HEADERS, timeout=12)
            r.raise_for_status()
            links = extrair_links_personagens_dbd(r.text, url)
            print(f"[{url}] {len(links)} páginas encontradas")
            for perk_url in links[:60]:
                try:
                    perk_req = requests.get(perk_url, headers=HEADERS, timeout=12)
                    perk_req.raise_for_status()
                    titulo = BeautifulSoup(perk_req.text, "html.parser").title.get_text(strip=True) if BeautifulSoup(perk_req.text, "html.parser").title else perk_url.split("/")[-1]
                    texto = resumir_texto_personagem_dbd(perk_req.text, titulo)
                    if not texto or len(texto) < 80:
                        continue
                    status = learn(
                        titulo=titulo,
                        conteudo=f"Perk / vantagem DBD: {titulo}\n\n{texto}",
                        categoria="dbd_perk",
                        id_documento="dbd_perk_" + hashlib.md5(perk_url.lower().encode('utf-8')).hexdigest(),
                        url=perk_url
                    )
                    if status in ["NOVO", "ATUALIZADO"]:
                        ok += 1
                except Exception as exc:
                    print(f"  ⚠️ Falha ao processar perk {perk_url}: {exc}")
        except Exception as exc:
            print(f"  ⚠️ Falha ao buscar perks em {url}: {exc}")
        time.sleep(1)

    print(f"\n  ✅ Perks DBD aprendidos: {ok}")
    return ok

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

        try:
            conteudo = buscar_wikipedia(topico)

            if not conteudo:
                conteudo = gerar_conteudo_estruturado(topico)

            status = learn(
                titulo=topico,
                conteudo=conteudo,
                categoria="topico",
                id_documento="topic_" + hashlib.md5(topico.lower().encode('utf-8')).hexdigest()
            )

            if status == "NOVO":
                print("  ✅ Aprendido (Novo)")
                ok += 1
            elif status in ["EXISTE", "PARECIDO"]:
                print("  ⏭️ Já conhecido (Pulado)")
            else:
                print("  ⚠️ Falha")
        except KeyboardInterrupt:
            raise
        except Exception as e:
            print(f"  ⚠️ Falha ao processar tópico: {e}")

        time.sleep(0.3)

    print(f"\n  ✅ Aprendidos: {ok}/{len(topicos)}")
    return ok

def buscar_wikipedia(topico):
    """Busca resumo real do tópico na Wikipedia em português."""
    try:
        url = "https://pt.wikipedia.org/w/api.php"
        params = {
            "action": "query",
            "prop": "extracts",
            "exintro": True,
            "explaintext": True,
            "redirects": 1,
            "titles": topico,
            "format": "json"
        }
        r = requests.get(url, params=params, timeout=(3.0, 8.0), headers=HEADERS)
        r.raise_for_status()
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
    return (
        f"Tópico de conhecimento: {topico}\n\n"
        f"Este é um assunto relevante no universo gamer e de entretenimento. "
        f"Contexto: {topico} é um termo/assunto que pode estar relacionado a "
        f"jogos, conquistas, estratégias, personagens, mecânicas de gameplay, "
        f"itens, localizações ou lore de jogos. "
        f"Quando perguntada sobre {topico}, a Iana deve usar criatividade e "
        f"conhecimento geral sobre games para dar uma resposta útil e envolvente."
    )

def minerar_reworks():
    if not ARQUIVOS_PARA_LER.exists():
        print(f"⚠️  Arquivo de reworks não encontrado: {ARQUIVOS_PARA_LER}")
        return 0

    linhas = ARQUIVOS_PARA_LER.read_text(encoding='utf-8').splitlines()
    itens = extrair_textos_reworks(linhas)

    if not itens:
        print("⚠️  Nenhum item de rework encontrado para aprender.")
        return 0

    print(f"\n🧩 FASE 2.5 — Reworks para aprender: {len(itens)}")
    print("─" * 50)

    ok = 0
    for i, item in enumerate(itens, 1):
        print(f"[{i}/{len(itens)}] {item}")
        conteudo = (
            f"Rework / item relevante do universo Dead by Daylight: {item}. "
            f"Este termo deve ser tratado como conhecimento útil para responder sobre "
            f"mecânicas, mudanças, itens, killers, perks, builds ou contexto do jogo."
        )

        status = learn(
            titulo=item,
            conteudo=conteudo,
            categoria="rework",
            id_documento="rework_" + hashlib.md5(item.lower().encode('utf-8')).hexdigest()
        )

        if status == "NOVO":
            print("  ✅ Aprendido (Novo)")
            ok += 1
        elif status in ["EXISTE", "PARECIDO"]:
            print("  ⏭️ Já conhecido (Pulado)")
        else:
            print("  ⚠️ Falha")

        time.sleep(0.2)

    print(f"\n  ✅ Reworks aprendidos: {ok}/{len(itens)}")
    return ok

# ── FASE 3: RESUMO ─────────────────────────────────────────────────
def mostrar_resumo(ok_links, err_links, ok_topicos, ok_updates, ok_reworks, ok_personagens, ok_perks):
    print("\n" + "="*50)
    print("📊 RESUMO DA MINERAÇÃO")
    print("="*50)
    print(f"  🔗 Links processados:  {ok_links} ✅  {err_links} ❌")
    print(f"  🔔 Atualizações detectadas: {ok_updates} ✅")
    print(f"  📚 Tópicos aprendidos: {ok_topicos} ✅")
    print(f"  🧩 Reworks aprendidos: {ok_reworks} ✅")
    print(f"  🧟 Personagens DBD aprendidos: {ok_personagens} ✅")
    print(f"  � Perks DBD aprendidos: {ok_perks} ✅")
    print(f"  🧠 Total integrado:    {ok_links + ok_topicos + ok_updates + ok_reworks + ok_personagens + ok_perks} itens")
    print("="*50)
    print("✨ A Iana agora sabe mais! Reinicie o servidor para")
    print("   que as mudanças reflitam nas respostas do chat.")

# ── MAIN ───────────────────────────────────────────────────────────
def main():
    print("="*50)
    print("⚡ IANA — SISTEMA DE MINERAÇÃO E APRENDIZADO")
    print("="*50)

    try:
        ok_links, err_links = minerar_links()
        ok_updates          = minerar_atualizacoes()
        ok_topicos          = minerar_topicos()
        ok_reworks          = minerar_reworks()
        ok_personagens      = minerar_personagens_dbd()
        ok_perks            = minerar_perks_dbd()
        mostrar_resumo(ok_links, err_links, ok_updates, ok_topicos, ok_reworks, ok_personagens, ok_perks)
    except KeyboardInterrupt:
        print("\n⚠️ Mineração interrompida pelo usuário. O progresso parcial foi preservado.")
    except Exception as e:
        print(f"\n❌ Erro fatal na mineração: {e}")
        raise


if __name__ == "__main__":
    main()