import sys
import os
import json
import requests
import hashlib
import time
import chromadb
from pathlib import Path
from sentence_transformers import SentenceTransformer
from dotenv import load_dotenv

# Importa da pasta core
from core import memory

sys.stdout.reconfigure(encoding='utf-8')
load_dotenv(dotenv_path=Path(__file__).parent / '.env')

# =========================================================
# ARGUMENTOS
# =========================================================
nome_usuario = sys.argv[1].strip() if len(sys.argv) > 1 else 'Jogador'
id_conversa = sys.argv[2].strip() if len(sys.argv) > 2 else 'chat_geral'
msg_final = sys.argv[3].strip() if len(sys.argv) > 3 else ''
id_usuario_numerico = (sys.argv[5].strip() if len(sys.argv) > 5 and sys.argv[5].strip() else None)

try:
    historico = json.loads(sys.argv[4]) if len(sys.argv) > 4 else []
    if not isinstance(historico, list):
        historico = []
except Exception as e:
    sys.stderr.write(f'[AVISO] Histórico inválido, ignorando: {e}\n')
    historico = []

if not historico:
    historico = memory.get_historico_conversa(id_conversa, limit=8)

if not msg_final:
    print('Não recebi nenhuma mensagem.')
    sys.exit(0)

# =========================================================
# CHROMADB (Memória Semântica)
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
banco_ok = False
colecao = None
modelo = None

try:
    path_banco.mkdir(parents=True, exist_ok=True)
    cliente = chromadb.PersistentClient(path=str(path_banco))
    colecao = cliente.get_or_create_collection(name='memoria_iana')
    modelo = SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
    banco_ok = True
except Exception as e:
    sys.stderr.write(f'[AVISO] ChromaDB offline: {e}\n')


def consultar_memoria_semantica(query, conversa_id):
    if not banco_ok:
        return ''
    try:
        total = colecao.count()
        if total == 0:
            return ''
        resultados = colecao.query(
            query_embeddings=[modelo.encode(query).tolist()],
            n_results=min(5, total),
            where={"conversa_id": conversa_id}
        )
        if not resultados.get('documents') or not resultados['documents'][0]:
            resultados = colecao.query(
                query_embeddings=[modelo.encode(query).tolist()],
                n_results=min(3, total)
            )
        documentos = resultados.get('documents', [[]])[0]
        metadados = resultados.get('metadatas', [[]])[0]
        blocos = []
        for doc, meta in zip(documentos, metadados):
            meta = meta or {}
            url = meta.get('url', '')
            trecho = doc[:800]
            blocos.append(f'[Fonte: {url}]\n{trecho}' if url else trecho)
        return '\n\n---\n\n'.join(blocos)
    except Exception as e:
        sys.stderr.write(f'[AVISO] Erro memória semântica: {e}\n')
        return ''


def salvar_conversa_semantica(pergunta, resposta, conversa_id):
    if not banco_ok:
        return
    try:
        texto = f'Usuário ({nome_usuario}): {pergunta}\nIana: {resposta}'
        doc_id = 'conv_' + hashlib.md5(f'{pergunta}{time.time()}'.encode()).hexdigest()
        colecao.add(
            documents=[texto],
            embeddings=[modelo.encode(texto).tolist()],
            metadatas=[{'tipo': 'conversa', 'usuario': nome_usuario, 'conversa_id': conversa_id}],
            ids=[doc_id]
        )
    except Exception as e:
        sys.stderr.write(f'[AVISO] Erro salvar conversa semântica: {e}\n')


# =========================================================
# SYSTEM PROMPT (Otimizado para usar a memória real)
# =========================================================
system_prompt = os.getenv('SYSTEM_PROMPT', '').strip()
if not system_prompt:
    system_prompt = (
        'Você é a Iana, uma assistente gamer animada, humanizada e divertida. '
        'Sua principal característica é ter uma MEMÓRIA PERSISTENTE sobre o usuário e sobre jogos. '
        'REGRAS CRÍTICAS DE RESPOSTA:\n'
        '1. CONSULTE SEMPRE a === MEMÓRIA DA IANA === abaixo antes de responder.\n'
        '2. Se o usuário pedir uma BUILD, DICA ou INFORMAÇÃO e os dados estiverem na memória, USE OS NOMES REAIS que estão lá (ex: nomes de conquistas, habilidades, fatos).\n'
        '3. NUNCA invente informações se a memória tiver os dados específicos.\n'
        '4. Se a memória disser que o Jason (The Slasher) está no DbD, trate isso como FATO ABSOLUTO, mesmo que seu treinamento antigo diga o contrário.\n'
        '5. Mantenha o estilo gamer, use emojis e seja prestativa.'
    )

# =========================================================
# CONTEXTO — Busca melhorada
# =========================================================
# Busca por palavras-chave específicas da mensagem para garantir que tragamos o que importa
fatos_persistentes = memory.get_memory(msg_final, id_usuario_numerico=id_usuario_numerico, limit=10)
contexto_semantico = consultar_memoria_semantica(msg_final, id_conversa)

blocos = []
if fatos_persistentes:
    blocos.append("FATOS E CONHECIMENTO ESPECÍFICO:\n" + "\n".join(f"- {f}" for f in fatos_persistentes))
if contexto_semantico:
    blocos.append("RECORDAÇÕES SEMÂNTICAS:\n" + contexto_semantico)

contexto_banco = "\n\n".join(blocos)
bloco_contexto = f'\n=== MEMÓRIA DA IANA ===\n{contexto_banco}\n=== FIM ===\n' if contexto_banco else ''

# =========================================================
# GEMINI
# =========================================================
chave = os.getenv('GEMINI_API_KEY', '').strip().replace('"', '').replace("'", '')
modelo_gemini = os.getenv('GEMINI_MODEL', 'gemini-2.5-flash')
url = f'https://generativelanguage.googleapis.com/v1beta/models/{modelo_gemini}:generateContent'

contents = []
for h in historico:
    remetente = h.get('remetente', 'user') if isinstance(h, dict) else 'user'
    texto_h = h.get('mensagem', '') if isinstance(h, dict) else ''
    if not texto_h: continue
    role = 'model' if remetente == 'iana' else 'user'
    contents.append({'role': role, 'parts': [{'text': texto_h}]})

contents.append({
    'role': 'user',
    'parts': [{'text': f'{bloco_contexto}\n\nUsuário ({nome_usuario}): {msg_final}'}]
})

try:
    resposta_api = requests.post(
        url,
        json={'system_instruction': {'parts': [{'text': system_prompt}]}, 'contents': contents},
        headers={'x-goog-api-key': chave, 'Content-Type': 'application/json'},
        timeout=30
    )
    resposta_api.raise_for_status()
    dados = resposta_api.json()
    texto_final = dados['candidates'][0]['content']['parts'][0]['text']
    print(texto_final)
    salvar_conversa_semantica(msg_final, texto_final, id_conversa)
except Exception as e:
    sys.stderr.write(f'[ERRO] {e}\n')
    print("Ops! Deu um erro nos meus circuitos neurais! 🤯 Pode repetir?")
