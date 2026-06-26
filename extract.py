# mine.py - Pipeline completo de mineração

import requests
from bs4 import BeautifulSoup
from learning_engine import learn
import time
import json

def extract_content(url):
    """Extrai conteúdo real da página"""
    try:
        r = requests.get(url, timeout=10)
        soup = BeautifulSoup(r.text, "html.parser")

        # Remove lixo
        for el in soup(["script", "style", "nav", "footer", "header"]):
            el.decompose()

        # Título
        title = soup.title.text if soup.title else url.split("/")[-1]

        # Conteúdo (comentários, dicas, tudo)
        text = soup.get_text(separator="\n", strip=True)[:2000]

        return title, text
    except:
        return None, None

def mine_links():
    """Extrai conteúdo de todos os links"""
    print("📥 FASE 1: Extraindo conteúdo dos links\n")
    
    with open("./data/links_para_mineracao.txt") as f:
        urls = [line.strip() for line in f if line.startswith("http")]
    
    print(f"🔗 {len(urls)} links para extrair\n")
    
    success = 0
    for i, url in enumerate(urls, 1):
        title, content = extract_content(url)
        
        if content:
            learn(title, content, "extracted", f"url_{hash(url)}")
            success += 1
            if i % 20 == 0:
                print(f"  [{i}/{len(urls)}] ✅")
        
        time.sleep(0.3)
    
    print(f"\n✅ {success}/{len(urls)} links extraídos\n")

def mine_topics():
    """Aprende tópicos estruturados"""
    print("📚 FASE 2: Processando tópicos\n")
    
    with open("./data/titulos_para_buscar.txt") as f:
        topics = [line.strip() for line in f if line.strip()]
    
    print(f"📋 {len(topics)} tópicos para aprender\n")
    
    for topic in topics:
        learn(f"Tópico: {topic}", f"Guia sobre: {topic}", "topics", f"topic_{hash(topic)}")
    
    print(f"✅ {len(topics)} tópicos aprendidos\n")

def show_summary():
    """Mostra resumo do conhecimento"""
    print("📊 FASE 3: Validação\n")
    
    try:
        with open("./knowledge.json") as f:
            data = json.load(f)
        
        sources = {}
        for item in data:
            s = item.get('source', 'unknown')
            sources[s] = sources.get(s, 0) + 1
        
        print(f"✅ Total de itens aprendidos: {len(data)}")
        print(f"\n📚 Por fonte:")
        for s, c in sorted(sources.items(), key=lambda x: -x[1]):
            print(f"   • {s}: {c}")
    except:
        pass
    
    print(f"\n🎉 MINERAÇÃO CONCLUÍDA!")

if __name__ == "__main__":
    print("="*50)
    print("⚡ SISTEMA DE MINERAÇÃO COMPLETO")
    print("="*50 + "\n")
    
    mine_links()
    mine_topics()
    show_summary()
