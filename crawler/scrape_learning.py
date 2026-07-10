# scrape_learning.py - Pipeline direto e eficiente

import requests
import hashlib
from bs4 import BeautifulSoup
from learning_engine import learn
from pathlib import Path
import time

DIRETORIO_RAIZ = Path(__file__).parent.resolve()
PASTA_DATA = DIRETORIO_RAIZ / "data"


def id_estavel(prefixo, texto):
    # FIX: hash() nativo do Python é randomizado por processo (PYTHONHASHSEED),
    # então a mesma URL/tópico gerava um ID diferente a cada execução do script,
    # causando duplicação infinita do mesmo conteúdo no ChromaDB.
    # hashlib.md5 é determinístico: mesmo texto -> sempre o mesmo ID.
    return f"{prefixo}_" + hashlib.md5(texto.strip().lower().encode('utf-8')).hexdigest()


def scrape_and_learn(url, game=None):
    """Extrai e aprende em um passo"""
    try:
        r = requests.get(url, timeout=6)
        soup = BeautifulSoup(r.text, "html.parser")

        title = soup.title.text if soup.title else "sem título"

        # Remove lixo
        for el in soup(["script", "style", "nav", "footer"]):
            el.decompose()

        # Extrai texto
        content = soup.get_text(separator="\n", strip=True)[:1000]

        if len(content) > 50:
            learn(title, content, "mining", id_estavel("url", url))
            return True
    except Exception as e:
        print(f"⚠️ Erro ao minerar {url}: {e}")
    return False


def learn_topics(filepath):
    """Aprende tópicos direto como conhecimento estruturado"""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            topics = [line.strip() for line in f if line.strip()]

        for topic in topics:
            learn(f"Tópico: {topic}", f"Informação sobre: {topic}", "mining", id_estavel("topic", topic))

        return len(topics)
    except Exception as e:
        print(f"⚠️ Erro ao processar tópicos ({filepath}): {e}")
        return 0


def run():
    print("⚡ Mineração Turbo Iniciada!\n")

    # FIX: caminhos agora são relativos à pasta do script (DIRETORIO_RAIZ),
    # não ao diretório de onde o script é executado — evita quebrar em cron/deploy.
    arquivo_links = PASTA_DATA / "links_para_mineracao.txt"
    arquivo_topicos = PASTA_DATA / "titulos_para_buscar.txt"

    # 1. Minerar TODOS os links
    if not arquivo_links.exists():
        print(f"⚠️ Arquivo não encontrado: {arquivo_links}")
        urls = []
    else:
        with open(arquivo_links, encoding='utf-8') as f:
            urls = [line.strip() for line in f if line.strip().startswith("http")]

    print(f"🔗 {len(urls)} links → minerando...")
    success = sum(scrape_and_learn(url) for url in urls)
    print(f"✅ {success}/{len(urls)} links aprendidos\n")

    # 2. Aprender TODOS os tópicos
    print(f"📚 Tópicos → processando...")
    topics = learn_topics(arquivo_topicos) if arquivo_topicos.exists() else 0
    if not arquivo_topicos.exists():
        print(f"⚠️ Arquivo não encontrado: {arquivo_topicos}")
    print(f"✅ {topics} tópicos aprendidos\n")

    # 3. Resultado final
    print(f"🎉 Total: {success + topics} itens integrados ao conhecimento!")


if __name__ == "__main__":
    run()