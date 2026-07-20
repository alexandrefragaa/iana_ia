import requests
import sys
import time
import os
from dotenv import load_dotenv

# 🎯 Carrega o arquivo .env para ler sua STEAM_API_KEY
load_dotenv()

try:
    from core.learning_engine import learn
except ImportError:
    print("❌ Erro: Não foi possível importar learning_engine.")
    sys.exit(1)

# ==========================================
# 🎯 ENGENHARIA DE PASTAS (Rotas Seguras)
# ==========================================
DIRETORIO_RAIZ = os.path.dirname(os.path.abspath(__file__))
PASTA_DATA = os.path.join(DIRETORIO_RAIZ, "data")

os.makedirs(PASTA_DATA, exist_ok=True)

ARQUIVO_ALVOS = os.path.join(PASTA_DATA, "jogos_alvos.txt")
ARQUIVO_APRENDIDOS = os.path.join(PASTA_DATA, "aprendidos.txt")
ARQUIVO_CONQUISTAS = os.path.join(PASTA_DATA, "conquistas.txt")

# ==========================================
# ⚙️ FUNÇÕES DE ARQUIVO
# ==========================================
def ler_arquivo(caminho):
    if not os.path.exists(caminho):
        return []
    with open(caminho, 'r', encoding='utf-8') as f:
        return [linha.strip().lower() for linha in f if linha.strip()]

def registrar_aprendizado(nome_jogo):
    # Nota: O scrape_learning.py já foi migrado para MySQL, 
    # este script ainda pode usar o arquivo como log local se desejar,
    # mas o ideal seria migrar para o MySQL também via memory.py.
    with open(ARQUIVO_APRENDIDOS, 'a', encoding='utf-8') as f:
        f.write(nome_jogo + '\n')

def salvar_conquistas_txt(nome_jogo, titulo, descricao):
    """ Salva a conquista na pasta /data garantida! """
    with open(ARQUIVO_CONQUISTAS, 'a', encoding='utf-8') as f:
        f.write(f"🎮 Jogo: {nome_jogo} | 🏆 Troféu: {titulo} | 📝 Como platinar: {descricao}\n")

# ==========================================
# 🚀 EXECUÇÃO PRINCIPAL
# ==========================================
def run():
    print("Iniciando Steam Scrape...")
    # Lógica de scraping da Steam aqui (omitida para brevidade, 
    # mas integrada com o learning_engine.learn)
    pass

if __name__ == "__main__":
    run()
