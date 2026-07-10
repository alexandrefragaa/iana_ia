import os
import sys
import hashlib
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
            # FIX: hash() nativo do Python é randomizado por processo (PYTHONHASHSEED),
            # então o mesmo título gerava um ID diferente a cada execução, causando
            # duplicação infinita do mesmo conteúdo no banco a cada re-mineração.
            # hashlib.md5 é determinístico: mesmo título -> sempre o mesmo ID.
            id_documento = "doc_" + hashlib.md5(titulo.strip().lower().encode('utf-8')).hexdigest()

        # Formatando o texto para a Iana entender o contexto depois
        texto_para_aprender = f"Guia/Conhecimento - {titulo}\n{conteudo}"

        # A mágica: Transformando o texto do jogo em Vetor (Embedding)
        vetor = modelo.encode(texto_para_aprender).tolist()

        # FIX: colecao.add() lança exceção se o ID já existir no banco (não faz update).
        # Como agora o ID é estável por título, rodar a mineração de novo sobre o mesmo
        # conteúdo precisa ATUALIZAR o registro em vez de falhar. upsert() faz add-ou-update.
        colecao.upsert(
            documents=[texto_para_aprender],
            embeddings=[vetor],
            metadatas=[{"tipo": categoria, "titulo": titulo}],
            ids=[id_documento]
        )
        print(f"✅ Aprendido/atualizado: {titulo}")
        return True
    except Exception as e:
        print(f"⚠️ Erro ao tentar aprender sobre ({titulo}): {e}")
        return False


# =========================================================
# 3. USO VIA LINHA DE COMANDO (opcional, para o scraper chamar direto)
# =========================================================
# Exemplo: python3 learning_engine.py "Titulo do guia" "conteudo completo aqui" mining
if __name__ == "__main__":
    if len(sys.argv) > 2:
        titulo_cli = sys.argv[1]
        conteudo_cli = sys.argv[2]
        categoria_cli = sys.argv[3] if len(sys.argv) > 3 else "mining"
        sucesso = learn(titulo_cli, conteudo_cli, categoria_cli)
        sys.exit(0 if sucesso else 1)
    else:
        print("Uso: python3 learning_engine.py <titulo> <conteudo> [categoria]")