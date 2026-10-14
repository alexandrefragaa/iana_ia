from __future__ import annotations

import hashlib
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup


def learn(*args, **kwargs):
    # Importar o minerador não abre o banco nem carrega modelos desnecessários.
    try:
        from core.learning_engine import learn as learner
    except ImportError:
        from learning_engine import learn as learner
    return learner(*args, **kwargs)


BASE_DIR = Path(
    os.getenv(
        "IANA_BASE_DIR",
        str(Path(__file__).resolve().parent.parent)
    )
).resolve()

DATA_DIR = Path(
    os.getenv(
        "IANA_DATA_DIR",
        str(BASE_DIR / "data")
    )
).resolve()

DATA_DIR.mkdir(parents=True, exist_ok=True)


def resolver_arquivo(nome_arquivo: str) -> Path:
    candidatos = [
        DATA_DIR / nome_arquivo,
        BASE_DIR / nome_arquivo,
        BASE_DIR / "data" / nome_arquivo,
        BASE_DIR.parent / nome_arquivo,
        BASE_DIR.parent / "data" / nome_arquivo,
    ]

    for caminho in candidatos:
        if caminho.exists():
            return caminho

    return DATA_DIR / nome_arquivo


ARQUIVO_REWORKS = resolver_arquivo("reworks_dbd.txt")
ARQUIVO_CONQUISTAS = resolver_arquivo("conquistas.txt")
ARQUIVO_LINKS_CONCLUIDOS = resolver_arquivo("links_concluidos.txt")
ARQUIVO_TITULOS = resolver_arquivo("titulos_para_buscar.txt")
ARQUIVO_UPDATES = resolver_arquivo("update_sources.txt")
ARQUIVO_LINKS_MINERACAO = resolver_arquivo("links_para_mineracao.txt")
ARQUIVO_ESTADO = resolver_arquivo("update_source_state.json")


HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 "
        "(Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 "
        "(KHTML, like Gecko) "
        "Chrome/128.0 Safari/537.36"
    ),
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept": (
        "text/html,"
        "application/xhtml+xml,"
        "application/xml;q=0.9,"
        "*/*;q=0.8"
    ),
}

SESSION = requests.Session()
SESSION.headers.update(HEADERS)
REQUEST_TIMEOUT = (5, 20)


def normalizar_url(url: str) -> str:
    url = str(url or "").strip()

    if not url:
        return ""

    if not re.match(r"^https?://", url, re.IGNORECASE):
        return ""

    return url.rstrip()


def extrair_urls(texto: str) -> List[str]:
    if not texto:
        return []

    urls = re.findall(
        r'https?://[^\s<>"\']+',
        texto,
        flags=re.IGNORECASE,
    )

    resultado = []
    vistos = set()

    for url in urls:
        url = url.rstrip(".,;:!?)]}")

        if "](" in url:
            url = url.split("](", 1)[-1].rstrip(")")

        url = normalizar_url(url)

        if not url or url in vistos:
            continue

        vistos.add(url)
        resultado.append(url)

    return resultado


def uid_url(url: str) -> str:
    return (
        "url_"
        + hashlib.sha256(
            url.strip().lower().encode("utf-8")
        ).hexdigest()[:48]
    )


def uid_texto(texto: str, prefixo: str) -> str:
    return (
        prefixo
        + "_"
        + hashlib.sha256(
            texto.strip().lower().encode("utf-8")
        ).hexdigest()[:48]
    )


def hash_texto(texto: str) -> str:
    return hashlib.sha256(
        str(texto or "").strip().encode("utf-8")
    ).hexdigest()


def ler_arquivo(caminho: Path) -> str:
    if not caminho.exists():
        return ""

    for encoding in ("utf-8", "utf-8-sig", "latin-1"):
        try:
            return caminho.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
        except Exception as e:
            print(f"⚠️ Erro lendo {caminho}: {e}")
            return ""

    return ""


def ler_linhas(caminho: Path) -> List[str]:
    texto = ler_arquivo(caminho)

    return [
        linha.strip()
        for linha in texto.splitlines()
        if linha.strip()
    ]


def carregar_links_concluidos() -> set:
    if not ARQUIVO_LINKS_CONCLUIDOS.exists():
        return set()

    return set(
        extrair_urls(
            ler_arquivo(ARQUIVO_LINKS_CONCLUIDOS)
        )
    )


def marcar_link_concluido(url: str):
    url = normalizar_url(url)

    if not url or _registry().is_search_url(url):
        return
    with _registry().registry_lock(DATA_DIR):
        original = _registry().read_text(ARQUIVO_LINKS_CONCLUIDOS)
        if url not in _registry().source_urls(original):
            _registry()._atomic_write(ARQUIVO_LINKS_CONCLUIDOS,
                original + ("\n" if original and not original.endswith("\n") else "") + url + "\n")


def carregar_estado() -> Dict:
    if not ARQUIVO_ESTADO.exists():
        return {}

    try:
        dados = json.loads(
            ler_arquivo(ARQUIVO_ESTADO)
        )

        return dados if isinstance(dados, dict) else {}
    except Exception:
        return {}


def salvar_estado(estado: Dict):
    with _registry().registry_lock(DATA_DIR):
        # Leituras antigas nunca apagam entradas escritas por outro trabalhador.
        existing_text = _registry().read_text(ARQUIVO_ESTADO)
        existing = json.loads(existing_text) if existing_text.strip() else {}
        if not isinstance(existing, dict):
            raise ValueError("Arquivo de estado inválido; conteúdo preservado.")
        existing.update(estado)
        _registry()._atomic_write(ARQUIVO_ESTADO, json.dumps(existing, ensure_ascii=False, indent=2) + "\n")


def limpar_soup(soup: BeautifulSoup):
    for tag in soup(
        [
            "script",
            "style",
            "noscript",
            "template",
            "svg",
            "canvas",
            "nav",
            "footer",
            "header",
            "aside",
            "form",
            "iframe",
            "advertisement",
        ]
    ):
        tag.decompose()


def texto_limpo(elemento) -> str:
    return re.sub(
        r"\s+",
        " ",
        elemento.get_text(" ", strip=True),
    ).strip()


def extrair_conteudo(
    url: str,
) -> Tuple[Optional[str], Optional[str]]:
    url = normalizar_url(url)

    if not url:
        return None, None

    try:
        response = SESSION.get(
            url,
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )

        response.raise_for_status()

        content_type = (
            response.headers
            .get("Content-Type", "")
            .lower()
        )

        if (
            content_type
            and "html" not in content_type
            and "xhtml" not in content_type
        ):
            print(f"  ⚠️ Não é HTML: {url}")
            return None, None

        soup = BeautifulSoup(
            response.text,
            "html.parser",
        )

        limpar_soup(soup)

        titulo = ""

        h1 = soup.find("h1")

        if h1:
            titulo = texto_limpo(h1)

        if not titulo and soup.title:
            titulo = texto_limpo(soup.title)

        if not titulo:
            titulo = (
                urlparse(url)
                .path
                .strip("/")
                .split("/")[-1]
                or url
            )

        container = (
            soup.find("article")
            or soup.find("main")
            or soup.find(attrs={"role": "main"})
            or soup.body
        )

        if not container:
            return titulo, None

        blocos = []

        for heading in container.find_all(
            ["h1", "h2", "h3", "h4"]
        ):
            texto = texto_limpo(heading)

            if len(texto) >= 4:
                blocos.append(f"## {texto}")

        for p in container.find_all("p"):
            texto = texto_limpo(p)

            if len(texto) >= 40:
                blocos.append(texto)

        for li in container.find_all("li"):
            texto = texto_limpo(li)

            if len(texto) >= 25:
                blocos.append(f"• {texto}")

        for tr in container.find_all("tr"):
            celulas = []

            for td in tr.find_all(["td", "th"]):
                texto = texto_limpo(td)

                if texto:
                    celulas.append(texto)

            if celulas:
                blocos.append(" | ".join(celulas))

        resultado = []
        vistos = set()

        for bloco in blocos:
            chave = bloco.strip().lower()

            if chave in vistos:
                continue

            vistos.add(chave)
            resultado.append(bloco.strip())

        conteudo = "\n\n".join(resultado).strip()

        if len(conteudo) < 80:
            texto_total = texto_limpo(container)

            if len(texto_total) >= 80:
                conteudo = texto_total

        if len(conteudo) < 80:
            return titulo, None

        try:
            limite = int(
                os.getenv(
                    "IANA_MAX_PAGE_CHARS",
                    "30000",
                )
            )
        except ValueError:
            limite = 30000

        if len(conteudo) > limite:
            conteudo = (
                conteudo[:limite]
                + "\n\n[Conteúdo limitado pelo minerador.]"
            )

        return titulo, conteudo

    except requests.exceptions.Timeout:
        print(f"  ⏱️ Timeout: {url}")

    except requests.exceptions.HTTPError as e:
        codigo = (
            e.response.status_code
            if e.response
            else "?"
        )
        print(f"  ❌ HTTP {codigo}: {url}")

    except requests.exceptions.RequestException as e:
        print(f"  ❌ Erro HTTP: {url} — {e}")

    except Exception as e:
        print(f"  ❌ Erro extraindo {url}: {e}")

    return None, None


def aprender_url(
    url: str,
    categoria: str = "web_mining",
) -> str:
    resultado = aprender_fonte(url, {"categoria": categoria}, data_dir=DATA_DIR)
    for item in resultado["results"]:
        if item.get("status") == "failed":
            print(f"  Pendente: {item.get('reason') or item.get('url')}")
    if resultado["status"] == "partial":
        return "PARCIAL"
    statuses = [item.get("outcome") for item in resultado["results"]]
    for status in ("NOVO", "ATUALIZADO", "EXISTE"):
        if status in statuses:
            return status
    return "ERRO"


def minerar_urls(
    urls: List[str],
    categoria: str,
    marcar_feitos: bool = True,
) -> Tuple[int, int, int]:
    urls_unicas = []
    vistos = set()

    for url in urls:
        url = normalizar_url(url)

        if not url or url in vistos:
            continue

        vistos.add(url)
        urls_unicas.append(url)

    concluidos = carregar_links_concluidos()

    novos = 0
    pulados = 0
    erros = 0

    print(f"\n🔎 {len(urls_unicas)} URLs encontradas")

    for indice, url in enumerate(urls_unicas, 1):
        print(f"\n[{indice}/{len(urls_unicas)}]")
        print(f"🌐 {url}")

        busca_youtube = urlparse(url).path == "/results" and urlparse(url).hostname in {"youtube.com", "www.youtube.com", "m.youtube.com"}
        if marcar_feitos and url in concluidos and not busca_youtube:
            pulados += 1
            print("⏭️ Já consta como concluído.")
            continue

        status = aprender_url(url, categoria)

        if status in ("NOVO", "ATUALIZADO"):
            novos += 1
            print(f"✅ Aprendido: {status}")

        elif status == "EXISTE":
            pulados += 1
            print(f"⏭️ {status}")

        elif status == "PARCIAL":
            novos += 1
            erros += 1
            print("⚠️ Parte da fonte foi salva; os itens com falha permanecem pendentes.")
        else:
            erros += 1
            print("❌ Falha")

        time.sleep(0.5)

    return novos, pulados, erros


def minerar_links_concluidos():
    if not ARQUIVO_LINKS_CONCLUIDOS.exists():
        print("⚠️ links_concluidos.txt não encontrado.")
        return 0, 0, 0

    texto = ler_arquivo(ARQUIVO_LINKS_CONCLUIDOS)
    urls = extrair_urls(texto)

    print("\n📚 FASE 1 — links_concluidos.txt")

    return minerar_urls(
        urls,
        categoria="web_mining",
        marcar_feitos=False,
    )


def minerar_links():
    if not ARQUIVO_LINKS_MINERACAO.exists():
        print(
            "ℹ️ links_para_mineracao.txt "
            "não existe. Ignorando."
        )
        return 0, 0, 0

    texto = ler_arquivo(ARQUIVO_LINKS_MINERACAO)
    urls = extrair_urls(texto)

    print("\n🔗 FASE 2 — links_para_mineracao.txt")

    return minerar_urls(
        urls,
        categoria="web_mining",
        marcar_feitos=True,
    )


def minerar_atualizacoes():
    if not ARQUIVO_UPDATES.exists():
        print("ℹ️ update_sources.txt não encontrado.")
        return 0

    texto = ler_arquivo(ARQUIVO_UPDATES)

    linhas = [
        linha.strip()
        for linha in texto.splitlines()
        if linha.strip()
        and not linha.strip().startswith("#")
    ]

    urls = []

    for linha in linhas:
        urls.extend(extrair_urls(linha))

    urls = list(dict.fromkeys(urls))

    if not urls:
        print("⚠️ Nenhuma URL em update_sources.txt.")
        return 0

    atualizados = 0

    print("\n🔄 FASE 3 — update_sources.txt")

    for indice, url in enumerate(urls, 1):
        print(f"\n[{indice}/{len(urls)}]")
        print(f"🔄 {url}")

        # Sites e vídeos usam a mesma extração validada e o mesmo registro.
        resultado = aprender_fonte(url, {"categoria": "update"}, data_dir=DATA_DIR)
        atualizados += resultado["learned_count"]
        print(f"Resultado: {resultado['status']}; {resultado['document_count']} documentos disponíveis.")

    print(f"\n📊 Updates: {atualizados} atualizados.")

    return atualizados


def buscar_wikipedia(
    consulta: str,
) -> Optional[Tuple[str, str, str]]:
    consulta = str(consulta or "").strip()

    if not consulta:
        return None

    try:
        wikipedia_api = "https://pt.wikipedia.org/w/api.php"

        search_response = SESSION.get(
            wikipedia_api,
            params={
                "action": "query",
                "list": "search",
                "srsearch": consulta,
                "srlimit": 3,
                "format": "json",
            },
            timeout=REQUEST_TIMEOUT,
        )

        search_response.raise_for_status()

        search_data = search_response.json()

        resultados = (
            search_data
            .get("query", {})
            .get("search", [])
        )

        if not resultados:
            return None

        melhor = resultados[0]

        pageid = melhor.get("pageid")
        titulo = melhor.get("title")

        if not pageid or not titulo:
            return None

        page_response = SESSION.get(
            wikipedia_api,
            params={
                "action": "query",
                "prop": "extracts|info",
                "explaintext": True,
                "redirects": 1,
                "inprop": "url",
                "pageids": pageid,
                "format": "json",
            },
            timeout=REQUEST_TIMEOUT,
        )

        page_response.raise_for_status()

        data = page_response.json()

        pages = (
            data
            .get("query", {})
            .get("pages", {})
        )

        page = pages.get(str(pageid), {})

        extract = str(
            page.get("extract", "")
        ).strip()

        url = page.get("fullurl")

        if len(extract) < 100:
            return None

        return (
            titulo,
            extract[:25000],
            url or (
                "https://pt.wikipedia.org/wiki/"
                + titulo.replace(" ", "_")
            ),
        )

    except Exception as e:
        print(f"  ⚠️ Wikipedia: {e}")
        return None


def minerar_topicos():
    if not ARQUIVO_TITULOS.exists():
        print(
            "ℹ️ titulos_para_buscar.txt "
            "não encontrado."
        )
        return 0

    linhas = ler_linhas(ARQUIVO_TITULOS)
    topicos = []

    for linha in linhas:
        linha = linha.strip()

        if not linha:
            continue

        if linha.startswith("#"):
            continue

        if linha.lower().startswith("http"):
            continue

        topicos.append(linha)

    topicos = list(dict.fromkeys(topicos))

    print(f"\n📖 FASE 4 — {len(topicos)} tópicos")

    aprendidos = 0

    for indice, topico in enumerate(topicos, 1):
        print(f"\n[{indice}/{len(topicos)}]")
        print(f"🔎 {topico}")

        resultado = buscar_wikipedia(topico)

        if not resultado:
            print(
                "⚠️ Não encontrei uma "
                "fonte confiável na Wikipedia."
            )
            continue

        # CORREÇÃO DO ERRO DO PYLANCE:
        # título, conteúdo e URL são definidos aqui,
        # dentro do mesmo escopo em que serão usados.
        titulo, conteudo, url = resultado

        if not titulo or not conteudo:
            print(
                "⚠️ Resultado sem título "
                "ou conteúdo."
            )
            continue

        status = learn(
            titulo=titulo,
            conteudo=conteudo,
            categoria="topico",
            id_documento=uid_texto(topico, "topic"),
            url=url,
        )

        if status in ("NOVO", "ATUALIZADO"):
            aprendidos += 1
            print(f"✅ {status}: {titulo}")

        elif status in ("EXISTE", "PARECIDO"):
            print(f"⏭️ {status}")

        else:
            print(f"❌ {status}")

        time.sleep(0.3)

    print(
        f"\n📊 Tópicos aprendidos: "
        f"{aprendidos}/{len(topicos)}"
    )

    return aprendidos


def extrair_textos_reworks(
    linhas: List[str],
) -> List[str]:
    itens = []
    buffer = []

    for linha in linhas:
        texto = linha.strip()

        if not texto:
            continue

        if texto.startswith("#"):
            continue

        buffer.append(texto)

    if buffer:
        itens.append("\n".join(buffer))

    return itens


def minerar_reworks():
    if not ARQUIVO_REWORKS.exists():
        print(
            "ℹ️ reworks_dbd.txt "
            "não encontrado."
        )
        return 0

    texto = ler_arquivo(ARQUIVO_REWORKS)

    if not texto.strip():
        print("⚠️ reworks_dbd.txt está vazio.")
        return 0

    print("\n🧩 FASE 5 — reworks_dbd.txt")

    urls = extrair_urls(texto)
    aprendidos = 0

    if urls:
        print(
            f"🌐 Encontradas "
            f"{len(urls)} URLs no arquivo."
        )

        novos, pulados, erros = minerar_urls(
            urls,
            categoria="rework_source",
            marcar_feitos=True,
        )

        aprendidos += novos

    conteudo = texto.strip()

    status = learn(
        titulo="Reworks Dead by Daylight",
        conteudo=conteudo,
        categoria="rework",
        id_documento="reworks_dbd_file",
        url=None,
    )

    if status in ("NOVO", "ATUALIZADO"):
        aprendidos += 1
        print(f"✅ Arquivo aprendido: {status}")

    elif status == "EXISTE":
        print("⏭️ Arquivo já está atualizado.")

    else:
        print(f"⚠️ Resultado: {status}")

    return aprendidos


def extrair_links_dbd(
    html: str,
    base_url: str,
) -> List[str]:
    soup = BeautifulSoup(html, "html.parser")

    links = []
    vistos = set()

    for tag in soup.find_all("a", href=True):
        href = str(
            tag.get("href", "")
        ).strip()

        if not href:
            continue

        url = urljoin(base_url, href)

        if "deadbydaylight.fandom.com/wiki/" not in url:
            continue

        lower = url.lower()

        if any(
            item in lower
            for item in (
                "category:",
                "special:",
                "file:",
                "mediawiki",
            )
        ):
            continue

        if lower.endswith(
            (
                ".png",
                ".jpg",
                ".jpeg",
                ".gif",
                ".svg",
            )
        ):
            continue

        if url in vistos:
            continue

        vistos.add(url)
        links.append(url)

    return links


def resumir_pagina_dbd(
    html: str,
    titulo: str,
) -> Optional[str]:
    soup = BeautifulSoup(html, "html.parser")
    limpar_soup(soup)

    blocos = [
        f"Personagem/perk DBD: {titulo}"
    ]

    for heading in soup.find_all(
        ["h1", "h2", "h3"]
    ):
        texto = texto_limpo(heading)

        if len(texto) > 3:
            blocos.append(f"## {texto}")

    palavras_importantes = (
        "perk",
        "power",
        "ability",
        "add-on",
        "killer",
        "survivor",
        "effect",
        "item",
        "weapon",
        "advantage",
    )

    for p in soup.find_all("p"):
        texto = texto_limpo(p)

        if (
            len(texto) > 35
            and any(
                palavra in texto.lower()
                for palavra in palavras_importantes
            )
        ):
            blocos.append(texto)

    for li in soup.find_all("li"):
        texto = texto_limpo(li)

        if (
            len(texto) > 25
            and any(
                palavra in texto.lower()
                for palavra in palavras_importantes
            )
        ):
            blocos.append(f"• {texto}")

    resultado = "\n\n".join(blocos)

    if len(resultado) < 100:
        return None

    return resultado[:25000]


def minerar_personagens_dbd():
    urls = [
        "https://deadbydaylight.fandom.com/wiki/Category:Killers",
        "https://deadbydaylight.fandom.com/wiki/Category:Survivors",
    ]

    print("\n🧟 FASE 6 — Personagens DBD")

    aprendidos = 0

    for categoria_url in urls:
        try:
            response = SESSION.get(
                categoria_url,
                timeout=REQUEST_TIMEOUT,
            )

            response.raise_for_status()

            links = extrair_links_dbd(
                response.text,
                categoria_url,
            )

            print(
                f"🔎 {len(links)} páginas "
                f"encontradas."
            )

            for personagem_url in links[:80]:
                try:
                    req = SESSION.get(
                        personagem_url,
                        timeout=REQUEST_TIMEOUT,
                    )

                    req.raise_for_status()

                    soup = BeautifulSoup(
                        req.text,
                        "html.parser",
                    )

                    if soup.title:
                        titulo = texto_limpo(soup.title)
                    else:
                        titulo = (
                            personagem_url
                            .split("/")[-1]
                        )

                    conteudo = resumir_pagina_dbd(
                        req.text,
                        titulo,
                    )

                    if not conteudo:
                        continue

                    status = learn(
                        titulo=titulo,
                        conteudo=conteudo,
                        categoria="dbd_personagem",
                        id_documento=uid_url(
                            personagem_url
                        ),
                        url=personagem_url,
                    )

                    if status in (
                        "NOVO",
                        "ATUALIZADO",
                    ):
                        aprendidos += 1
                        print(f"  ✅ {titulo}")

                except Exception as e:
                    print(
                        f"  ⚠️ "
                        f"{personagem_url}: "
                        f"{e}"
                    )

                time.sleep(0.2)

        except Exception as e:
            print(
                f"⚠️ Falha na categoria "
                f"{categoria_url}: {e}"
            )

    return aprendidos


def minerar_perks_dbd():
    urls = [
        "https://deadbydaylight.fandom.com/wiki/Perks",
        "https://deadbydaylight.fandom.com/wiki/Category:Perks",
    ]

    print("\n🧿 FASE 7 — Perks DBD")

    aprendidos = 0

    for pagina in urls:
        try:
            response = SESSION.get(
                pagina,
                timeout=REQUEST_TIMEOUT,
            )

            response.raise_for_status()

            links = extrair_links_dbd(
                response.text,
                pagina,
            )

            print(
                f"🔎 {len(links)} páginas "
                f"encontradas."
            )

            for perk_url in links[:80]:
                try:
                    req = SESSION.get(
                        perk_url,
                        timeout=REQUEST_TIMEOUT,
                    )

                    req.raise_for_status()

                    soup = BeautifulSoup(
                        req.text,
                        "html.parser",
                    )

                    titulo = (
                        texto_limpo(soup.title)
                        if soup.title
                        else perk_url.split("/")[-1]
                    )

                    conteudo = resumir_pagina_dbd(
                        req.text,
                        titulo,
                    )

                    if not conteudo:
                        continue

                    status = learn(
                        titulo=titulo,
                        conteudo=conteudo,
                        categoria="dbd_perk",
                        id_documento=uid_url(perk_url),
                        url=perk_url,
                    )

                    if status in (
                        "NOVO",
                        "ATUALIZADO",
                    ):
                        aprendidos += 1
                        print(f"  ✅ {titulo}")

                except Exception as e:
                    print(
                        f"  ⚠️ "
                        f"{perk_url}: "
                        f"{e}"
                    )

                time.sleep(0.2)

        except Exception as e:
            print(
                f"⚠️ Falha em {pagina}: {e}"
            )

    return aprendidos


def minerar_conquistas():
    """Aprende exclusivamente o conteúdo local de conquistas.txt."""
    if not ARQUIVO_CONQUISTAS.exists():
        print("ℹ️ conquistas.txt não encontrado. Ignorando.")
        return 0
    texto = ler_arquivo(ARQUIVO_CONQUISTAS).strip()
    if not texto:
        print("⚠️ conquistas.txt está vazio.")
        return 0
    print("\n🏆 FASE 8 — conquistas.txt")
    status = learn(
        titulo="Conquistas",
        conteudo=texto,
        categoria="conquistas",
        id_documento="conquistas_file",
        url=None,
    )
    if status in ("NOVO", "ATUALIZADO"):
        print(f"✅ Arquivo de conquistas aprendido: {status}")
        return 1
    if status == "EXISTE":
        print("⏭️ conquistas.txt já está atualizado.")
        return 0
    print(f"⚠️ Resultado conquistas: {status}")
    return 0


def mostrar_resumo(
    links_novos: int,
    links_pulados: int,
    links_erros: int,
    updates: int,
    topicos: int,
    reworks: int,
    personagens: int,
    perks: int,
    conquistas: int,
):
    total = (
        links_novos
        + updates
        + topicos
        + reworks
        + personagens
        + perks
        + conquistas
    )

    print("\n" + "=" * 60)
    print("📊 RESUMO DA MINERAÇÃO")
    print("=" * 60)

    print(
        f"🔗 Links novos/atualizados: "
        f"{links_novos}"
    )
    print(f"⏭️ Links pulados: {links_pulados}")
    print(f"❌ Links com erro: {links_erros}")
    print(f"🔄 Updates: {updates}")
    print(f"📖 Tópicos: {topicos}")
    print(f"🧩 Reworks: {reworks}")
    print(f"🧟 Personagens DBD: {personagens}")
    print(f"🧿 Perks DBD: {perks}")
    print(f"🏆 Conquistas: {conquistas}")

    print("-" * 60)
    print(f"🧠 TOTAL INTEGRADO: {total}")
    print("=" * 60)

    print("✅ Mineração concluída.")
    print(
        "🧠 O conhecimento foi enviado "
        "para ChromaDB e MySQL."
    )


def _registry():
    try:
        from core import source_registry
    except ImportError:
        import source_registry
    return source_registry


def aprender_extraido(source_url, extracted, *, learner=None, data_dir=None):
    """Persist actual content, preserving failures and confirmed provenance."""
    learner = learner or learn
    results = []
    raw_results = []
    documents = extracted.get("documentos", [])
    document_urls = {doc.get("url", "") for doc in documents}
    warnings = list(extracted.get("avisos", []))
    for item in extracted.get("itens", []):
        if item.get("url", "") in document_urls and item.get("status") == "EXTRAIDO":
            continue
        status = "skipped" if item.get("status") == "IGNORADO" else "failed"
        results.append({"url": item.get("url", ""), "status": status,
                        "reason": item.get("mensagem") or item.get("motivo") or "Nenhum conteúdo extraído."})
    for doc in documents:
        try:
            outcome = learner(
                titulo=doc["titulo"], conteudo=doc["conteudo"],
                categoria=doc.get("categoria", "web_mining"), id_documento=doc["id"],
                url=doc.get("url", ""), metadata=doc.get("metadata", {}),
            )
        except Exception as problem:
            outcome = "ERRO"
            warnings.append(f"Não foi possível salvar um documento ({type(problem).__name__}).")
        saved = outcome in _registry().SAVED_OUTCOMES
        raw_results.append({"id": doc.get("id", ""), "url": doc.get("url", ""), "outcome": outcome})
        results.append({"id": doc.get("id", ""), "url": doc.get("url", ""),
                        "titulo": doc.get("titulo", "Fonte"), "outcome": outcome,
                        "status": "existing" if outcome == "EXISTE" else "learned" if saved else "failed",
                        "reason": "Conteúdo já disponível." if outcome == "EXISTE" else "Conteúdo salvo." if saved else "Não foi possível salvar o conteúdo."})
    count = sum(item.get("outcome") in _registry().SAVED_OUTCOMES for item in results)
    learned = sum(item.get("outcome") in {"NOVO", "ATUALIZADO"} for item in results)
    registry_failed = False
    try:
        registered = _registry().record_source_result(source_url, extracted, raw_results, data_dir=data_dir)
    except (OSError, ValueError) as problem:
        registry_failed = True
        registered = {"saved_urls": [], "updated_urls": []}
        warnings.append(f"O conteúdo foi processado, mas o registro de fontes não pôde ser atualizado ({type(problem).__name__}).")
    failed = registry_failed or any(item["status"] == "failed" for item in results) or extracted.get("status") in {"ERRO", "failed"}
    status = "partial" if count and failed else "failed" if failed else "completed" if count else "skipped" if results else "failed"
    return {"source": source_url, "status": status, "document_count": count, "learned_count": learned,
            "results": results, "warnings": warnings, "registry": registered}


def aprender_fonte(url, options=None, *, extractor=None, learner=None, data_dir=None):
    if extractor is None:
        try:
            from core.knowledge_sources import extract_source
        except ImportError:
            from knowledge_sources import extract_source
        extractor = extract_source
    try:
        extracted = extractor(url, options or {})
    except Exception as problem:
        return {"source": url, "status": "failed", "document_count": 0, "learned_count": 0,
                "results": [{"url": url, "status": "failed", "reason": f"Não foi possível extrair a fonte ({type(problem).__name__})."}], "warnings": []}
    return aprender_extraido(url, extracted, learner=learner, data_dir=data_dir)


def _file_candidates(directory):
    """Read a bounded queue's candidates without deleting or consuming files."""
    registry = _registry()
    candidates = []
    title_file = directory / "titulos_para_buscar.txt"
    title_text = registry.read_text(title_file)
    # Este arquivo também contém explicações manuais, não só títulos de busca.
    for index, block in enumerate(re.split(r"\n\s*\n", title_text), 1):
        lines = [line.strip() for line in block.splitlines() if line.strip() and not line.lstrip().startswith("#")]
        prose_lines = [line for line in lines if not re.fullmatch(r"https?://\S+", line, re.I)]
        prose = "\n".join(prose_lines).strip()
        if not prose:
            continue
        words = re.findall(r"\w+", prose)
        supplied_content = len(prose) >= 160 or (len(words) >= 18 and re.search(r"[.,:;!?]", prose))
        if supplied_content:
            identifier = "arquivo_" + hashlib.sha256(f"{title_file.resolve()}#bloco={index}".encode("utf-8")).hexdigest()[:48]
            candidates.append({"kind": "local", "file": str(title_file), "id": identifier,
                               "titulo": prose.splitlines()[0][:120], "conteudo": prose, "block": index})
        else:
            for line in prose_lines:
                if not registry.source_urls(line):
                    candidates.append({"kind": "topic", "topic": line, "file": str(title_file)})
    seen = set()
    urls = []
    for filename in registry.SOURCE_FILES:
        for url in registry.source_urls(registry.read_text(directory / filename)):
            if url in seen:
                continue
            seen.add(url)
            urls.append({"kind": "url", "url": url, "file": str(directory / filename),
                         "category": "update" if filename == "update_sources.txt" else "web_mining"})
    # URLs escritas na lista de tópicos seguem o extrator, nunca viram textos.
    for url in registry.source_urls(title_text):
        if url not in seen:
            seen.add(url)
            urls.append({"kind": "url", "url": url, "file": str(title_file), "category": "web_mining"})
    local = [item for item in candidates if item["kind"] == "local"]
    topics = [item for item in candidates if item["kind"] == "topic"]
    return local + urls + topics


def _content_game(options, content):
    """Use an explicit game, or infer DBD only from this content itself."""
    configured = (options or {}).get("jogo")
    if configured is None:
        configured = (options or {}).get("game")
    if configured is not None:
        if not isinstance(configured, str) or not 1 <= len(configured.strip()) <= 120:
            raise ValueError("jogo deve ser um nome de jogo de até 120 caracteres.")
        return configured.strip()
    if re.search(r"(?<!\w)DBD(?!\w)|Dead[\s/_-]+by[\s/_-]+Daylight", str(content), re.I):
        return "DBD"
    return None


def learn_from_files(max_sources=None, options=None, *, data_dir=None, extractor=None,
                     learner=None, topic_lookup=None, progress=None):
    """Learn only the existing source files, with an explicit bounded workload.

    Long passages supplied in titulos_para_buscar.txt are local knowledge.
    Short titles require an actual Wikipedia extract before becoming knowledge.
    Completion/history files are retained; every run may refresh saved sources.
    """
    if max_sources is None:
        try:
            max_sources = int(os.getenv("IANA_FILE_MAX_SOURCES", "10"))
        except ValueError:
            max_sources = 10
    if isinstance(max_sources, bool) or not isinstance(max_sources, int) or not 1 <= max_sources <= 100:
        raise ValueError("max_sources deve ser um inteiro entre 1 e 100.")
    _content_game(options, "")  # Validar a configuração antes de iniciar o lote.
    registry = _registry()
    directory = registry.data_directory(data_dir)
    candidates = _file_candidates(directory)
    signature = content_hash_for_batch(candidates)
    offset = registry.file_batch_cursor(signature, directory)
    if offset >= len(candidates):
        offset = 0
    selected = candidates[offset:offset + max_sources]
    source_results = []
    for index, candidate in enumerate(selected, 1):
        kind = candidate["kind"]
        if progress:
            progress({"index": index, "total": len(selected), "kind": kind,
                      "source": candidate.get("url") or candidate.get("topic") or candidate.get("titulo")})
        if kind == "url":
            result = aprender_fonte(candidate["url"], {**(options or {}), "categoria": candidate["category"]},
                                    extractor=extractor, learner=learner, data_dir=directory)
        elif kind == "local":
            metadata = {"tipo": "texto_local", "arquivo": candidate["file"], "natureza": "conteudo_fornecido",
                        "verificado": False, "bloco": candidate["block"]}
            game = _content_game(options, candidate["conteudo"])
            if game:
                metadata["jogo"] = game
            doc = {"id": candidate["id"], "titulo": candidate["titulo"], "conteudo": candidate["conteudo"],
                   "categoria": "texto_local", "url": "", "metadata": metadata}
            result = aprender_extraido(candidate["file"], {"documentos": [doc], "itens": []}, learner=learner, data_dir=directory)
        else:
            lookup = topic_lookup or buscar_wikipedia
            try:
                found = lookup(candidate["topic"])
            except Exception:
                found = None
            if found and len(str(found[1] or "").strip()) >= 100:
                title, content, url = found
                doc = {"id": "fonte_" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:48],
                       "titulo": title, "conteudo": content, "categoria": "topico", "url": url,
                       "metadata": {"tipo": "site", "metodo": "wikipedia_extract", "consulta": candidate["topic"], "arquivo": candidate["file"]}}
                game = _content_game(options, content)
                if game:
                    doc["metadata"]["jogo"] = game
                result = aprender_extraido(url, {"documentos": [doc], "itens": []}, learner=learner, data_dir=directory)
            else:
                result = {"source": candidate["topic"], "status": "failed", "document_count": 0, "learned_count": 0,
                          "results": [{"status": "failed", "reason": "Título pendente: não foi encontrado conteúdo suficiente na Wikipedia."}], "warnings": []}
        result["source_file"] = candidate["file"]
        result["kind"] = kind
        source_results.append(result)
        registry.save_file_batch_cursor(signature, offset + len(source_results), directory)
    count = sum(item["document_count"] for item in source_results)
    failures = sum(item["status"] in {"failed", "partial"} for item in source_results)
    status = "partial" if count and failures else "failed" if failures else "completed" if source_results else "empty"
    return {"status": status, "data_dir": str(directory), "processed_sources": len(source_results),
            "available_sources": len(candidates), "remaining_sources": max(0, len(candidates) - offset - len(selected)),
            "batch_offset": offset, "next_batch_offset": offset + len(selected),
            "document_count": count, "learned_count": sum(item["learned_count"] for item in source_results),
            "failed_sources": failures, "results": source_results}


def content_hash_for_batch(candidates):
    # Alterações no conteúdo manual ou nas listas iniciam uma nova passagem.
    # O histórico cresce durante a coleta e não deve reiniciar o próprio lote.
    queue = [item for item in candidates if Path(item["file"]).name != "links_concluidos.txt"]
    return _registry().content_hash(json.dumps(queue, ensure_ascii=False, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description="Aprende com os arquivos de fontes existentes da Iana.")
    parser.add_argument("--max-sources", type=int, default=None)
    parser.add_argument("--max-videos", type=int, default=5)
    parser.add_argument("--recent-days", type=int, default=7)
    parser.add_argument("--game", help="Jogo associado aos textos locais e tópicos deste lote.")
    args = parser.parse_args()
    report = learn_from_files(args.max_sources, {"max_videos": args.max_videos, "recent_days": args.recent_days, "jogo": args.game},
                              progress=lambda item: print(f"[{item['index']}/{item['total']}] {item['source']}", file=sys.stderr))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if report["status"] == "failed" else 0


def _legacy_main():
    inicio = time.time()

    print("\n" + "=" * 60)
    print(
        "⚡ IANA — "
        "SISTEMA DE MINERAÇÃO E APRENDIZADO"
    )
    print("=" * 60)

    print(f"📁 Base: {BASE_DIR}")
    print(f"📁 Dados: {DATA_DIR}")
    print()

    links_concluidos = minerar_links_concluidos()
    links_extras = minerar_links()

    links_novos = (
        links_concluidos[0]
        + links_extras[0]
    )

    links_pulados = (
        links_concluidos[1]
        + links_extras[1]
    )

    links_erros = (
        links_concluidos[2]
        + links_extras[2]
    )

    updates = minerar_atualizacoes()
    topicos = minerar_topicos()
    reworks = minerar_reworks()
    personagens = minerar_personagens_dbd()
    perks = minerar_perks_dbd()
    conquistas = minerar_conquistas()

    mostrar_resumo(
        links_novos,
        links_pulados,
        links_erros,
        updates,
        topicos,
        reworks,
        personagens,
        perks,
        conquistas,
    )

    tempo = time.time() - inicio

    print(
        f"\n⏱️ Tempo total: "
        f"{tempo:.1f}s"
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())

    except KeyboardInterrupt:
        print("\n⚠️ Mineração interrompida.")
        print(
            "O que já foi aprendido "
            "permanece salvo."
        )

    except Exception as e:
        print(f"\n❌ ERRO FATAL: {e}")
        raise
