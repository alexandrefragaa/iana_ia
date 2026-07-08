# mine.py - Pipeline completo de mineração

import requests
from bs4 import BeautifulSoup
from learning_engine import learn
import time
import json
import os

# =========================================================
# SISTEMA DE CONTROLE (O Caderno de Aprendizados)
# =========================================================
caminho_aprendidos = "./data/aprendidos.txt"

def ja_aprendeu(url):
    """Verifica se o link já foi minerado antes"""
    if not os.path.exists(caminho_aprendidos):
        return False
    with open(caminho_aprendidos, 'r', encoding='utf-8') as f:
        return url in f.read()

def registrar_aprendizado(url):
    """Salva o link para não minerar de novo"""
    with open(caminho_aprendidos, 'a', encoding='utf-8') as f:
        f.write(url + "\n")
# =========================================================

# Criando a Sessão Global
sessao_navegador = requests.Session()

# O Disfarce Nível Máximo (Headers completos de um Google Chrome real)
sessao_navegador.headers.update({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://www.google.com/', # Finge que viemos de uma pesquisa do Google
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
})

def extract_content(url):
    """Extrai conteúdo real da página tentando burlar bloqueios básicos"""
    try:
        # Usamos a sessão global disfarçada em vez do requests puro
        r = sessao_navegador.get(url, timeout=15)
        r.raise_for_status() 
        
        soup = BeautifulSoup(r.text, "html.parser")

        # Remove lixo
        for el in soup(["script", "style", "nav", "footer", "header"]):
            el.decompose()

        title = soup.title.text if soup.title else url.split("/")[-1]
        text = soup.get_text(separator="\n", strip=True)[:2000]

        return title, text
    except Exception as e:
        print(f"  ❌ Erro ao raspar {url}: {e}")
        return None, None

def mine_links():
    """Extrai conteúdo de todos os links"""
    print("📥 FASE 1: Extraindo conteúdo dos links\n")
    
    with open("./data/links_para_mineracao.txt") as f:
        urls = [line.strip() for line in f if line.startswith("http")]
    
    print(f"🔗 {len(urls)} links para extrair\n")
    
    success = 0
    ignorados = 0
    for i, url in enumerate(urls, 1):
        # 🚀 A MÁGICA ACONTECE AQUI: Se já aprendeu, pula!
        if ja_aprendeu(url):
            print(f"  ⏩ [PULANDO] Já sei isso de cor: {url}")
            ignorados += 1
            continue

        title, content = extract_content(url)
        
        if content:
            learn(title, content, "extracted", f"url_{hash(url)}")
            registrar_aprendizado(url) # 🧠 Anota que já aprendeu!
            success += 1
            if success % 20 == 0:
                print(f"  [{success} novos links] ✅")
        
        time.sleep(0.3)
    
    print(f"\n✅ FASE 1 CONCLUÍDA: {success} novos links extraídos ({ignorados} repetidos pulados).\n")

def mine_topics():
    """Aprende tópicos estruturados"""
    print("📚 FASE 2: Processando tópicos\n")
    
    with open("./data/titulos_para_buscar.txt") as f:
        topics = [line.strip() for line in f if line.strip()]
    
    print(f"📋 {len(topics)} tópicos para aprender\n")
    
    sucesso = 0
    ignorados = 0
    for topic in topics:
        # Trava para tópicos também!
        if ja_aprendeu(topic):
            ignorados += 1
            continue

        learn(f"Tópico: {topic}", f"Guia sobre: {topic}", "topics", f"topic_{hash(topic)}")
        registrar_aprendizado(topic)
        sucesso += 1
    
    print(f"✅ FASE 2 CONCLUÍDA: {sucesso} tópicos novos ({ignorados} já conhecidos ignorados)\n")

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
''
if __name__ == "__main__":
    print("="*50)
    print("⚡MINERAÇÃO")
    print("="*50 + "\n")
    
    mine_links()
    mine_topics()
    show_summary()