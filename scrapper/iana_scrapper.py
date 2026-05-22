import os
import time
import random
from pathlib import Path
import requests 
from bs4 import BeautifulSoup 
import chromadb
from sentence_transformers import SentenceTransformer

# 1. CONFIGURAÇÃO DE CAMINHOS
path_banco = Path(os.getenv('LOCALAPPDATA')) / "iana_database" / "chromadb"
path_links = Path(__file__).parent.parent / "data" / "links_para_mineracao.txt"

# Cria a pasta do banco se não existir
path_banco.mkdir(parents=True, exist_ok=True)

# 2. CARREGAMENTO DO MODELO 
print("⏳ Carregando modelo BGE-Base... (isso pode demorar na primeira vez)")

encoder = SentenceTransformer('BAAI/bge-base-en-v1.5')

# 3. BLINDAGEM DO BANCO
client = chromadb.PersistentClient(path=str(path_banco))
collection = client.get_or_create_collection(name="conhecimento_jogos")
print(f"✅ Banco de dados conectado em: {path_banco}")

def minerar_url_direta(url):
    print(f"\n🔍 Minerando: {url}")
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
        resposta = requests.get(url, headers=headers, timeout=15)
        
        soup = BeautifulSoup(resposta.text, 'html.parser')
        
        # Remove elementos desnecessários para limpar o texto
        for script in soup(["script", "style", "nav", "footer", "header"]):
            script.extract()
        
        texto = soup.get_text(separator=' ', strip=True)
        
        if len(texto) < 200: 
            print(f"⚠️ Página muito curta ou inacessível: {url}")
            return 

        # Gera o vetor e salva no banco
        vetor = encoder.encode(texto).tolist()
        collection.add(
            documents=[texto], 
            metadatas=[{"url": url}], 
            ids=[url], 
            embeddings=[vetor]
        )
        print(f"✅ Sucesso: {url}")
        
    except Exception as e:
        print(f"⚠️ Erro ao acessar {url}: {e}")

def processar_lista_links(caminho_do_arquivo):
    if not os.path.exists(caminho_do_arquivo):
        print(f"❌ ERRO: Arquivo de links não encontrado em {caminho_do_arquivo}")
        return

    print("🤖 Iniciando mineração por links diretos...")
    with open(caminho_do_arquivo, 'r', encoding='utf-8') as f:
        for url in f:
            url = url.strip()
            if not url or url.startswith("#"): continue # Pula linhas vazias ou comentários
            
            minerar_url_direta(url)
            
            # Descanso para não sobrecarregar os servidores dos sites
            tempo = random.uniform(5, 10)
            time.sleep(tempo)
    
    print("\n🎉 Processo finalizado!")

# Inicia o processo
processar_lista_links(str(path_links))