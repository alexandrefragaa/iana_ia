import sys
import os
import requests
from bs4 import BeautifulSoup
from pathlib import Path
import time

# =======================================================================
# 1. INJEÇÃO DE ROTA
# =======================================================================
ia_platina = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(ia_platina)

# Importa o motor da Iana depois de arrumar a rota
from learning_engine import learn

# =======================================================================
# 2. SISTEMA DE CONTROLE (O Caderno da Iana)
# =======================================================================
caminho_aprendidos = os.path.join(ia_platina, "data", "aprendidos.txt")

def ja_aprendeu(item):
    """Verifica se o link ou tópico já está no caderno de aprendidos"""
    try:
        with open(caminho_aprendidos, 'r', encoding='utf-8') as f:
            # Lê o arquivo e checa se o item já está listado
            return item in f.read()
    except FileNotFoundError:
        # Se o arquivo não existe ainda, é porque ela não aprendeu nada
        return False

def registrar_aprendizado(item):
    """Anota no caderno que este item já foi dominado"""
    with open(caminho_aprendidos, 'a', encoding='utf-8') as f:
        f.write(item + "\n")

# =======================================================================
# 3. MOTORES DE MINERAÇÃO
# =======================================================================
def scrape_and_learn(url):
    """Extrai e aprende, ignorando os repetidos"""
    if ja_aprendeu(url):
        print(f"⏩ [PULANDO] Já sei isso de cor: {url}")
        return False

    print(f"⏳ [EM ANDAMENTO] Lendo e aprendendo: {url}...")
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
            registrar_aprendizado(url) # Anota no caderno!
            print(f"✅ [APRENDIDO] Injetado na memória: {title}")
            return True
    except Exception as e:
        print(f"❌ [ERRO] Falha ao acessar {url}: {e}")
        
    return False

def learn_topics(filepath):
    """Aprende tópicos, ignorando os repetidos"""
    sucesso = 0
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            topics = [line.strip() for line in f if line.strip()]
        
        for topic in topics:
            if ja_aprendeu(topic):
                print(f"⏩ [PULANDO] Tópico já dominado: {topic}")
                continue
                
            print(f"⏳ [EM ANDAMENTO] Estudando tópico: {topic}...")
            learn(f"Tópico: {topic}", f"Informação sobre: {topic}", "mining", f"topic_{hash(topic)}")
            registrar_aprendizado(topic) # Anota no caderno!
            print(f"✅ [APRENDIDO] Tópico salvo na memória!")
            sucesso += 1
            
        return sucesso
    except FileNotFoundError:
        return 0

# =======================================================================
# 4. START DO PIPELINE
# =======================================================================
def run():
    print("⚡ Sistema Neural de Mineração Iniciado!\n")
    
    caminho_links = os.path.join(ia_platina, "data", "links_para_mineracao.txt")
    caminho_titulos = os.path.join(ia_platina, "data", "titulos_para_buscar.txt")
    
    urls = []
    try:
        with open(caminho_links, 'r', encoding='utf-8') as f:
            urls = [line.strip() for line in f if line.startswith("http")]
    except FileNotFoundError:
        print(f"⚠️ Aviso: Arquivo não encontrado em {caminho_links}")
        
    print(f"🔗 Analisando {len(urls)} links na fila...\n")
    success = sum(scrape_and_learn(url) for url in urls)
    
    print(f"\n📚 Analisando tópicos pendentes...\n")
    topics = learn_topics(caminho_titulos)
    
    print(f"\n🎉 Relatório Final: {success} novos links e {topics} novos tópicos integrados!")

if __name__ == "__main__":
    run()