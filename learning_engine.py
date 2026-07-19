import os
import sys
import hashlib
import chromadb
from sentence_transformers import SentenceTransformer
from pathlib import Path

# =========================================================
# 1. CONEXÃO COM O CÉREBRO DA IANA (ChromaDB)
# =========================================================
# FIX: antes usava sempre LOCALAPPDATA (só existe no Windows), o que no
# Render caía silenciosamente no fallback Path.home() — e podia ser uma
# pasta DIFERENTE da que o iana.py usa, fazendo o que o scraper aprende
# nunca aparecer nas respostas do chat. Agora usa a MESMA lógica do
# iana.py: respeita IANA_DB_PATH se definido, senão detecta o SO certo.
def obter_pasta_banco():
    override = os.getenv('IANA_DB_PATH')
    if override:
        return Path(override)
    if os.name == 'nt':
        base = Path(os.getenv('LOCALAPPDATA', str(Path.home())))
    else:
        base = Path(os.getenv('XDG_DATA_HOME', str(Path.home() / '.local' / 'share')))
    return base / 'iana_database' / 'chromadb'

path_banco = obter_pasta_banco()
path_banco.mkdir(parents=True, exist_ok=True)

print(f"🧠 Ligando os motores neurais da Iana... (banco em: {path_banco})")
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
            # ID determinístico: mesmo título -> sempre o mesmo ID (evita duplicação).
            id_documento = "doc_" + hashlib.md5(titulo.strip().lower().encode('utf-8')).hexdigest()

        texto_para_aprender = f"Guia/Conhecimento - {titulo}\n{conteudo}"
        vetor = modelo.encode(texto_para_aprender).tolist()

        # upsert() em vez de add(): permite ATUALIZAR quando o ID já existe,
        # em vez de lançar exceção.
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
if __name__ == "__main__":
    if len(sys.argv) > 2:
        titulo_cli = sys.argv[1]
        conteudo_cli = sys.argv[2]
        categoria_cli = sys.argv[3] if len(sys.argv) > 3 else "mining"
        sucesso = learn(titulo_cli, conteudo_cli, categoria_cli)
        sys.exit(0 if sucesso else 1)
    else:
        print("Uso: python3 learning_engine.py <titulo> <conteudo> [categoria]")