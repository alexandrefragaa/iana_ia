import os
import sys
import chromadb
from sentence_transformers import SentenceTransformer
from pathlib import Path

# =========================================================
# 1. CONEXÃO COM O CÉREBRO DA IANA (ChromaDB)
# =========================================================
# Buscando o caminho do banco exatamente como está na sua arquitetura
path_banco = ( Path(os.getenv('LOCALAPPDATA', str(Path.home()))) / 'iana_database' / 'chromadb' )
path_banco.mkdir(parents=True, exist_ok=True)

print("🧠 Ligando os motores neurais da Iana...")
try:
    cliente = chromadb.PersistentClient(path=str(path_banco))
    # Conectando na mesma coleção que a Iana usa para o chat
    colecao = cliente.get_or_create_collection(name='memoria_iana')
    # O modelo que transforma texto em vetores matemáticos
    modelo = SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
except Exception as e:
    print(f"❌ Falha crítica ao iniciar a memória vetorial: {e}")
    sys.exit(1)

# =========================================================
# 2. A FUNÇÃO MESTRA DE APRENDIZADO
# =========================================================
def learn(titulo, conteudo, categoria="mining", id_documento=None):
    """
    Recebe o texto extraído das wikis, artigos, links, comentarios pelo scraper, transforma em vetor 
    (embedding) e injeta na memória permanente da Iana.
    """
    try:
        if not id_documento:
            id_documento = f"doc_{hash(titulo)}"
        
        # Formatando o texto para a Iana entender o contexto depois
        texto_para_aprender = f"Guia/Conhecimento - {titulo}\n{conteudo}"
        
        # A mágica: Transformando o texto do jogo em Vetor (Embedding)
        vetor = modelo.encode(texto_para_aprender).tolist()
        
        # Injetando na memória local
        colecao.add(
            documents=[texto_para_aprender],
            embeddings=[vetor],
            metadatas=[{"tipo": categoria, "titulo": titulo}],
            ids=[id_documento]
        )
        return True
    except Exception as e:
        print(f"⚠️ Erro ao tentar aprender sobre ({titulo}): {e}")
        return False