import os
import time
import random
from pathlib import Path
from googlesearch import search 
import requests 
from bs4 import BeautifulSoup 
import chromadb
from sentence_transformers import SentenceTransformer

# 1. CAMINHOS ABSOLUTOS
caminho_script = Path(__file__).resolve().parent
caminho_raiz = caminho_script.parent

path_banco = Path(os.getenv('LOCALAPPDATA')) / "iana_database" / "chromadb"
path_txt = caminho_raiz / "data" / "titulos_para_buscar.txt"
path_concluidos = caminho_raiz / "data" / "titulos_concluidos.txt" # Novo arquivo de controle

# 2. CRIAÇÃO SEGURA
path_banco.mkdir(parents=True, exist_ok=True)

print("⏳ Carregando modelo BGE-Large... (isso pode demorar na primeira vez)")
encoder = SentenceTransformer('BAAI/bge-large-en-v1.5')

# 3. BLINDAGEM DO BANCO DE DADOS
try:
    client = chromadb.PersistentClient(path=str(path_banco))
    collection = client.get_or_create_collection(name="conhecimento_jogos")
    print(f"✅ Banco de dados conectado em: {path_banco}")
except Exception as e:
    print(f"⚠️ Erro ao abrir banco: {e}")
    exit()

def minerar_e_salvar(titulo):
    print(f"\n🔍 Buscando: {titulo}")
    try:
        links = list(search(titulo, num_results=3))
        for url in links:
            try:
                headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
                resposta = requests.get(url, headers=headers, timeout=10)         
                soup = BeautifulSoup(resposta.text, 'html.parser')
                for script in soup(["script", "style", "nav", "footer", "header"]):
                    script.extract()
                texto = soup.get_text(separator=' ', strip=True)
                if len(texto) < 100: continue
                vetor = encoder.encode(texto).tolist()
                collection.add(documents=[texto], metadatas=[{"url": url, "titulo": titulo}], ids=[url], embeddings=[vetor])
                print(f"✅ Salvo: {url}")
            except Exception as e:
                print(f"⚠️ Erro no link {url}: {e}")
    except Exception as e:
        print(f"❌ Erro na busca '{titulo}': {e}")

def processar_lista(caminho_do_arquivo):
    print("🤖 Iniciando Iana (Modo Recuperação Ativado)...")
    
    # Carrega a lista do que já foi feito
    concluidos = set()
    if path_concluidos.exists():
        with open(path_concluidos, 'r', encoding='utf-8') as f:
            concluidos = set(line.strip() for line in f)

    try:
        with open(caminho_do_arquivo, 'r', encoding='utf-8') as f:
            for titulo in f:
                titulo = titulo.strip()
                if not titulo or titulo in concluidos:
                    continue
                
                minerar_e_salvar(titulo)
                
                # Marca como concluído
                with open(path_concluidos, 'a', encoding='utf-8') as f_out:
                    f_out.write(titulo + '\n')
                
                # Espera aleatória entre 45 e 90 segundos (evita bloqueio do Google)
                espera = random.uniform(45, 90)
                print(f"⏳ Descansando {int(espera)}s...")
                time.sleep(espera)
                
        print("\n🎉 TODOS OS TÍTULOS PROCESSADOS!")
    except FileNotFoundError:
        print(f"❌ Erro: Arquivo não achado em {caminho_do_arquivo}")

processar_lista(str(path_txt))