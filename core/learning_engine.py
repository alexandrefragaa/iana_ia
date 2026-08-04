import os
import sys
import hashlib
import json
from pathlib import Path

try:
    import chromadb
except Exception:  # pragma: no cover - ambiente sem dependência
    chromadb = None

try:
    from sentence_transformers import SentenceTransformer
except Exception:  # pragma: no cover - ambiente sem dependência
    SentenceTransformer = None

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
cliente = None
colecao = None
modelo = None
modo_fallback = False
memoria_inicializada = False


def _inicializar_memoria():
    global cliente, colecao, modelo, modo_fallback, memoria_inicializada
    if memoria_inicializada:
        return not modo_fallback

    memoria_inicializada = True
    try:
        if chromadb is None:
            raise RuntimeError("Dependências de embeddings não disponíveis")

        cliente = chromadb.PersistentClient(path=str(path_banco))
        if not any(path_banco.iterdir()):
            print("⚠️ AVISO: O diretório do ChromaDB está vazio. Se você estiver no Render, verifique o Persistent Disk!")

        colecao = cliente.get_or_create_collection(
            name='memoria_iana',
            metadata={"hnsw:space": "cosine"}
        )

        if SentenceTransformer is None:
            raise RuntimeError("sentence-transformers não disponível")

        modelo = SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
        print("🧠 Memória vetorial ativa")
        return True
    except Exception as e:
        modo_fallback = True
        print(f"⚠️ Memória vetorial indisponível, usando fallback simples: {e}")
        return False

# fallback simples em arquivo JSON para não depender de ChromaDB/embeddings
arquivo_fallback = path_banco / 'memoria_fallback.json'
if arquivo_fallback.exists():
    try:
        with arquivo_fallback.open('r', encoding='utf-8') as fh:
            memoria_fallback = json.load(fh)
    except Exception:
        memoria_fallback = []
else:
    memoria_fallback = []


def _salvar_memoria_fallback(doc_id, titulo, conteudo, categoria, url):
    global memoria_fallback
    memoria_fallback = [item for item in memoria_fallback if item.get('id') != doc_id]
    memoria_fallback.append({
        'id': doc_id,
        'titulo': titulo,
        'conteudo': conteudo,
        'categoria': categoria,
        'url': url or ''
    })
    with arquivo_fallback.open('w', encoding='utf-8') as fh:
        json.dump(memoria_fallback, fh, ensure_ascii=False, indent=2)


def _carregar_memoria_fallback():
    if not arquivo_fallback.exists():
        return []
    try:
        with arquivo_fallback.open('r', encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return []

# =========================================================
# 2. VERIFICAÇÕES
# =========================================================
def documento_existe(id_documento):
    """Verifica se um documento já existe pelo ID."""
    if not _inicializar_memoria():
        return any(item.get('id') == id_documento for item in memoria_fallback)
    try:
        resultado = colecao.get(ids=[id_documento])
        return len(resultado["ids"]) > 0
    except Exception:
        return False

def documento_parecido(vetor, limite=0.985):
    """Evita salvar documentos praticamente iguais com base na similaridade de cosseno."""
    if not _inicializar_memoria():
        return False
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

        if not _inicializar_memoria():
            if documento_existe(id_documento):
                _salvar_memoria_fallback(id_documento, titulo, texto, categoria, url)
                return "ATUALIZADO"
            _salvar_memoria_fallback(id_documento, titulo, texto, categoria, url)
            return "NOVO"

        vetor = modelo.encode(
            texto,
            normalize_embeddings=True
        ).tolist()

        if documento_existe(id_documento):
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
            return "ATUALIZADO"

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
        if not _inicializar_memoria():
            itens = _carregar_memoria_fallback()[-limite_resultados:]
            if not itens:
                return "Não encontrei informações específicas sobre isso na minha memória."
            return "\n\n---\n\n".join(
                f"[{item.get('categoria', 'memoria')}] {item.get('titulo', '')}\n{item.get('conteudo', '')}"
                for item in itens
            )

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