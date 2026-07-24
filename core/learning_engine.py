import os
import sys
import hashlib
from pathlib import Path
import chromadb
from sentence_transformers import SentenceTransformer

# =========================================================
# 1. CONEXÃO COM O CÉREBRO DA IANA (ChromaDB)
# =========================================================
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
    if not any(path_banco.iterdir()):
        print("⚠️ AVISO: O diretório do ChromaDB está vazio. Se você estiver no Render, verifique o Persistent Disk!")
    
    # FIX: metadata={"hnsw:space": "cosine"} garante métrica correta para cálculo de similaridade (0 a 1)
    colecao = cliente.get_or_create_collection(
        name='memoria_iana',
        metadata={"hnsw:space": "cosine"}
    )
    modelo = SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
except Exception as e:
    print(f"❌ Falha crítica ao iniciar a memória vetorial: {e}")
    sys.exit(1)

# =========================================================
# 2. VERIFICAÇÕES
# =========================================================
def documento_existe(id_documento):
    """Verifica se um documento já existe pelo ID."""
    try:
        resultado = colecao.get(ids=[id_documento])
        return len(resultado["ids"]) > 0
    except Exception:
        return False

def documento_parecido(vetor, limite=0.985):
    """Evita salvar documentos praticamente iguais com base na similaridade de cosseno."""
    try:
        resultado = colecao.query(
            query_embeddings=[vetor],
            n_results=1
        )

        if not resultado.get("distances") or not resultado["distances"][0]:
            return False

        distancia = resultado["distances"][0][0]
        similaridade = 1 - distancia

        return similaridade >= limite
    except Exception:
        return False

# =========================================================
# 3. A FUNÇÃO MESTRA DE APRENDIZADO
# =========================================================
def learn(titulo, conteudo, categoria="mining", id_documento=None, url=None):
    try:
        if not id_documento:
            id_documento = (
                "doc_" +
                hashlib.md5(titulo.strip().lower().encode("utf-8")).hexdigest()
            )

        if documento_existe(id_documento):
            return "EXISTE"

        texto = f"""
Título:
{titulo}

Categoria:
{categoria}

Fonte:
{url if url else "Local"}

Conteúdo:

{conteudo}
"""

        vetor = modelo.encode(
            texto,
            normalize_embeddings=True
        ).tolist()

        if documento_parecido(vetor):
            return "PARECIDO"

        colecao.upsert(
            ids=[id_documento],
            documents=[texto],
            embeddings=[vetor],
            metadatas=[{
                "titulo": titulo,
                "tipo": categoria,
                "url": url if url else ""
            }]
        )

        return "NOVO"

    except Exception as e:
        print(f"Erro em learn(): {e}")
        return "ERRO"

# =========================================================
# 4. BUSCA DIRETA
# =========================================================
def buscar_na_memoria_iana(pergunta_usuario, limite_resultados=2):
    """Transforma a pergunta em vetor e busca os fragmentos mais relevantes no ChromaDB."""
    try:
        vetor_pergunta = modelo.encode(pergunta_usuario, normalize_embeddings=True).tolist()
        
        resultados = colecao.query(
            query_embeddings=[vetor_pergunta],
            n_results=limite_resultados
        )
        
        if not resultados.get("documents") or not resultados["documents"][0]:
            return "Não encontrei informações específicas sobre isso na minha memória."
            
        textos_encontrados = resultados["documents"][0]
        return "\n\n---\n\n".join(textos_encontrados)
        
    except Exception as e:
        print(f"Erro na busca: {e}")
        return "Tive um problema ao acessar minha memória."

# =========================================================
# 5. USO VIA LINHA DE COMANDO
# =========================================================
if __name__ == "__main__":
    if len(sys.argv) > 2:
        titulo_cli = sys.argv[1]
        conteudo_cli = sys.argv[2]
        categoria_cli = sys.argv[3] if len(sys.argv) > 3 else "mining"
        status = learn(titulo_cli, conteudo_cli, categoria_cli)
        # FIX: Só retorna 0 se o aprendizado for concluído com sucesso
        sys.exit(0 if status in ["NOVO", "EXISTE", "PARECIDO"] else 1)
    else:
        print("Uso: python3 learning_engine.py <titulo> <conteudo> [categoria]")