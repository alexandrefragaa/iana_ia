# scrape_learning.py - Pipeline direto e eficiente

import requests
from bs4 import BeautifulSoup
from learning_engine import learn
from pathlib import Path
import time

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
            learn(f"{title}", content, "mining", f"url_{hash(url)}")
            return True
    except:
        pass
    return False


def learn_topics(filepath):
    """Aprende tópicos direto como conhecimento estruturado"""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            topics = [line.strip() for line in f if line.strip()]
        
        for topic in topics:
            learn(f"Tópico: {topic}", f"Informação sobre: {topic}", "mining", f"topic_{hash(topic)}")
        
        return len(topics)
    except:
        return 0


def run():
    print("⚡ Mineração Turbo Iniciada!\n")
    
    # 1. Minerar TODOS os links
    with open("./data/links_para_mineracao.txt") as f:
        urls = [line.strip() for line in f if line.startswith("http")]
    
    print(f"🔗 {len(urls)} links → minerando...")
    success = sum(scrape_and_learn(url) for url in urls)
    print(f"✅ {success}/{len(urls)} links aprendidos\n")
    
    # 2. Aprender TODOS os tópicos
    print(f"📚 Tópicos → processando...")
    topics = learn_topics("./data/titulos_para_buscar.txt")
    print(f"✅ {topics} tópicos aprendidos\n")
    
    # 3. Resultado final
    print(f"🎉 Total: {success + topics} itens integrados ao conhecimento!")


if __name__ == "__main__":
    run()