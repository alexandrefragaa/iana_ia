# scrape_learning.py - Pipeline único de mineração (consolidado)
#
# Substitui mine.py + scrape_learning.py antigos.
# Motivo da consolidação: os dois faziam a mesma coisa (extrair conteúdo
# de links/tópicos e chamar learn()), com fixes diferentes cada um —
# risco real de bug corrigido em um lado e esquecido no outro (já
# aconteceu com o hash() não-determinístico).
#
# O que foi puxado de cada um:
#   - de scrape_learning.py: headers de navegador, delay entre requests,
#     id_estavel() com hashlib (determinístico), caminhos relativos ao
#     script (não quebra em cron/deploy)
#   - de mine.py: controle "já aprendeu" via arquivo (evita reprocessar
#     URLs/tópicos que não mudaram, economiza tempo e banda)
#
# ATUALIZAÇÃO: Agora usa MySQL (via memory.py) para persistência real do controle "já aprendeu".

import requests
import hashlib
import time
from bs4 import BeautifulSoup
from pathlib import Path
from learning_engine import learn
import memory # Importa a memória persistente no MySQL

DIRETORIO_RAIZ = Path(__file__).parent.resolve()
PASTA_DATA = DIRETORIO_RAIZ / "data"
# ARQUIVO_APRENDIDOS = PASTA_DATA / "aprendidos.txt" # Desativado em favor do MySQL

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": "https://www.google.com/",
    "Connection": "keep-alive",
}

DELAY_ENTRE_REQUESTS = 1  # segundos, evita rate-limit/bloqueio
LIMITE_CARACTERES = 2000  # tamanho do texto salvo por item


def id_estavel(prefixo, texto):
    """ID determinístico (mesmo texto -> mesmo ID sempre), pra upsert funcionar certo."""
    return f"{prefixo}_" + hashlib.md5(texto.strip().lower().encode('utf-8')).hexdigest()


# =========================================================
# CONTROLE "JÁ APRENDEU" (Agora usando MySQL para persistência real)
# =========================================================
def ja_aprendeu(chave):
    # Tenta no MySQL primeiro para persistência garantida
    if memory.ja_aprendeu_mysql(chave):
        return True
    return False

def registrar_aprendizado(chave, tipo="url"):
    # Registra no MySQL para persistência garantida
    memory.registrar_aprendizado_mysql(chave, tipo)


# =========================================================
# EXTRAÇÃO E APRENDIZADO
# =========================================================
def scrape_and_learn(url):
    """Extrai o conteúdo de uma URL e manda pro learning_engine."""
    if ja_aprendeu(url):
        print(f"  ⏩ [PULANDO] Já sei isso: {url}")
        return None  # None = pulado (diferente de False = falhou)

    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")

        for el in soup(["script", "style", "nav", "footer", "header"]):
            el.decompose()

        title = soup.title.text.strip() if soup.title else url.split("/")[-1]
        content = soup.get_text(separator="\n", strip=True)[:LIMITE_CARACTERES]

        if len(content) <= 50:
            print(f"  ⚠️ Conteúdo insuficiente, ignorando: {url}")
            return False

        ok = learn(title, content, "mining", id_estavel("url", url))
        if ok:
            registrar_aprendizado(url)
        return ok

    except Exception as e:
        print(f"  ❌ Erro ao minerar {url}: {e}")
        return False
    finally:
        time.sleep(DELAY_ENTRE_REQUESTS)


def learn_topics(filepath):
    """Aprende tópicos direto como conhecimento estruturado (sem scraping)."""
    if not filepath.exists():
        print(f"⚠️ Arquivo não encontrado: {filepath}")
        return 0, 0

    with open(filepath, 'r', encoding='utf-8') as f:
        topics = [line.strip() for line in f if line.strip()]

    sucesso, ignorados = 0, 0
    for topic in topics:
        if ja_aprendeu(topic):
            ignorados += 1
            continue
        ok = learn(f"Tópico: {topic}", f"Guia sobre: {topic}", "topics", id_estavel("topic", topic))
        if ok:
            registrar_aprendizado(topic, tipo="topic")
            sucesso += 1

    return sucesso, ignorados


# =========================================================
# EXECUÇÃO
# =========================================================
def run():
    print("=" * 50)
    print("⚡ MINERAÇÃO")
    print("=" * 50 + "\n")

    arquivo_links = PASTA_DATA / "links_para_mineracao.txt"
    arquivo_topicos = PASTA_DATA / "titulos_para_buscar.txt"

    # FASE 1: links
    print("📥 FASE 1: Extraindo conteúdo dos links\n")
    if not arquivo_links.exists():
        print(f"⚠️ Arquivo não encontrado: {arquivo_links}")
        urls = []
    else:
        with open(arquivo_links, encoding='utf-8') as f:
            urls = [line.strip() for line in f if line.strip().startswith("http")]

    print(f"🔗 {len(urls)} links no arquivo\n")
    novos, ignorados, falhas = 0, 0, 0
    for url in urls:
        resultado = scrape_and_learn(url)
        if resultado is None:
            ignorados += 1
        elif resultado:
            novos += 1
        else:
            falhas += 1

    print(f"\n✅ FASE 1 CONCLUÍDA: {novos} novos, {ignorados} repetidos pulados, {falhas} falharam.\n")

    # FASE 2: tópicos
    print("📚 FASE 2: Processando tópicos\n")
    topicos_novos, topicos_ignorados = learn_topics(arquivo_topicos)
    print(f"✅ FASE 2 CONCLUÍDA: {topicos_novos} tópicos novos, {topicos_ignorados} já conhecidos ignorados.\n")

    print(f"🎉 Total: {novos + topicos_novos} itens novos integrados ao conhecimento!")


if __name__ == "__main__":
    run()
