import requests
import sys
import time
import os
from dotenv import load_dotenv

# 🎯 Carrega o arquivo .env para ler sua STEAM_API_KEY
load_dotenv()

try:
    from learning_engine import learn
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
    with open(ARQUIVO_APRENDIDOS, 'a', encoding='utf-8') as f:
        f.write(nome_jogo + '\n')

def salvar_conquistas_txt(nome_jogo, titulo, descricao):
    """ Salva a conquista na pasta /data garantida! """
    with open(ARQUIVO_CONQUISTAS, 'a', encoding='utf-8') as f:
        f.write(f"🎮 Jogo: {nome_jogo} | 🏆 Troféu: {titulo} | 📝 Como platinar: {descricao}\n")

# ==========================================
# 🌐 FUNÇÕES DA API DA STEAM
# ==========================================
def obter_todos_os_ids_da_steam(api_key):
    print("🌐 Baixando o catálogo mestre via API...")
    url_api = f"https://api.steampowered.com/IStoreService/GetAppList/v1/?key={api_key}&max_results=50000"
    try:
        resposta = requests.get(url_api, timeout=15)
        resposta.raise_for_status()
        jogos = resposta.json().get('response', {}).get('apps', [])
        return jogos
    except Exception as e:
        print(f"❌ Erro ao buscar a lista mestre: {e}")
        return []

def minerar_conquistas_api(app_id, nome_jogo, api_key):
    url = f"https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key={api_key}&appid={app_id}&l=brazilian"
    try:
        response = requests.get(url, timeout=10)
        if response.status_code != 200:
            return False

        dados = response.json()
        if 'game' in dados and 'availableGameStats' in dados['game'] and 'achievements' in dados['game']['availableGameStats']:
            conquistas = dados['game']['availableGameStats']['achievements']
            print(f"🎮 {nome_jogo} - Encontradas {len(conquistas)} conquistas! Injetando no Cérebro e no TXT...")
            
            for ach in conquistas:
                titulo = ach.get('displayName', 'Oculto')
                descricao = ach.get('description', 'Conquista Secreta / Sem descrição')
                conteudo = f"O jogo '{nome_jogo}' possui a conquista '{titulo}'. Como platinar / Descrição: {descricao}."
                
                # Injeta na mente
                learn(titulo=f"Steam_{app_id}_{titulo}", conteudo=conteudo, categoria="conquistas_steam")
                
                # Injeta no caderno FÍSICO usando a rota segura
                salvar_conquistas_txt(nome_jogo, titulo, descricao)
            
            return True 
        return False
    except Exception:
        return False

# ==========================================
# 🚀 EXECUÇÃO PRINCIPAL
# ==========================================
if __name__ == "__main__":
    print("-" * 50)
    print("👾 ROBÔ HÍBRIDO DA IANA (COM PASTAS CORRETAS) 👾")
    print("-" * 50)

    steam_api_key = os.getenv("STEAM_API_KEY")
    if not steam_api_key:
        print("⚠️ ATENÇÃO: Configure a STEAM_API_KEY no arquivo .env!")
        sys.exit(1)

    jogo_manual = input("Digite o nome do jogo que deseja aprender agora\n(Ou aperte ENTER para processar o jogos_alvos.txt): ").strip().lower()

    if jogo_manual:
        jogos_alvo = [jogo_manual]
        limite = 1
    else:
        jogos_alvo = ler_arquivo(ARQUIVO_ALVOS)
        if not jogos_alvo:
            print(f"⚠️ O arquivo {ARQUIVO_ALVOS} está vazio. E nenhum jogo foi digitado!")
            sys.exit(1)
        limite = int(input("Quantos jogos da lista deseja analisar agora? (Ex: 50): "))

    jogos_aprendidos = ler_arquivo(ARQUIVO_APRENDIDOS)

    catalogo_steam = obter_todos_os_ids_da_steam(steam_api_key)
    
    if not catalogo_steam:
        sys.exit(1)

    print("\n🔍 Analisando...")

    contador = 0

    for nome_buscado in jogos_alvo:
        if nome_buscado in jogos_aprendidos:
            print(f"✅ [PULANDO] A Iana já aprendeu as conquistas de: {nome_buscado.title()}")
            continue
        
        print(f"🔎 Buscando ID para: {nome_buscado.title()}...")
        jogo_encontrado = None
        
        for jogo_steam in catalogo_steam:
            if jogo_steam.get('name', '').lower() == nome_buscado:
                jogo_encontrado = jogo_steam
                break
        
        if jogo_encontrado:
            app_id = jogo_encontrado['appid']
            nome_oficial = jogo_encontrado['name']
            
            sucesso = minerar_conquistas_api(app_id, nome_oficial, steam_api_key)
            
            if sucesso:
                registrar_aprendizado(nome_buscado)
                print(f"📝 {nome_oficial} registrado no aprendidos.txt com sucesso!\n")
            else:
                print(f"⚠️ {nome_oficial} não possui conquistas públicas ou deu erro.\n")
                
            contador += 1
            time.sleep(1.5) 

            if limite > 0 and contador >= limite:
                print(f"\n✅ Lote concluído com sucesso!")
                break
        else:
            print(f"❌ Jogo '{nome_buscado.title()}' não encontrado na loja da Steam.\n")

    print("🚀 Operação finalizada.")