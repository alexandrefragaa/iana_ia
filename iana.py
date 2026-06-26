
import sys
import os
import requests
import hashlib
import time
import chromadb
from pathlib import Path
from sentence_transformers import SentenceTransformer
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding='utf-8')
load_dotenv(dotenv_path=Path(__file__).parent / '.env')

# =========================================================
# ARGUMENTOS
# =========================================================
nome_usuario = sys.argv[1].strip() if len(sys.argv) > 1 else 'Jogador'
id_conversa = sys.argv[2].strip() if len(sys.argv) > 2 else 'chat_geral'
msg_final = ' '.join(sys.argv[3:]).strip() if len(sys.argv) > 3 else ''

if not msg_final:
    print('Não recebi nenhuma mensagem.')
    sys.exit(0)

# =========================================================
# CHROMADB
# =========================================================
path_banco = (
    Path(os.getenv('LOCALAPPDATA', str(Path.home())))
    / 'iana_database'
    / 'chromadb'
)

banco_ok = False
colecao = None
modelo = None

try:
    cliente = chromadb.PersistentClient(path=str(path_banco))
    colecao = cliente.get_or_create_collection(name='memoria_iana')
    modelo = SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
    banco_ok = True
except Exception as e:
    sys.stderr.write(f'[AVISO] ChromaDB offline: {e}\n')

# =========================================================
# MEMÓRIA
# =========================================================
def consultar_memoria(query, conversa_id):
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
        if not resultados.get('documents') or not resultados['documents']:
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
            if url:
                blocos.append(f'[Fonte: {url}]\n{trecho}')
            else:
                blocos.append(trecho)
        return '\n\n---\n\n'.join(blocos)
    except Exception as e:
        sys.stderr.write(f'[AVISO] Erro memória: {e}\n')
        return ''

def salvar_conversa(pergunta, resposta, conversa_id):
    if not banco_ok:
        return
    try:
        texto = f'Usuário ({nome_usuario}): {pergunta}\nIana: {resposta}'
        doc_id = 'conv_' + hashlib.md5(f'{pergunta}{time.time()}'.encode()).hexdigest()
        colecao.add(
            documents=[texto],
            embeddings=[modelo.encode(texto).tolist()],
            metadatas=[{
                'tipo': 'conversa',
                'usuario': nome_usuario,
                'conversa_id': conversa_id
            }],
            ids=[doc_id]
        )
    except Exception as e:
        sys.stderr.write(f'[AVISO] Erro salvar conversa: {e}\n')

# =========================================================
# FALLBACK LOCAL — usa o banco antes de mostrar erro
# =========================================================
def resposta_do_banco_local(contexto_banco):
    if not contexto_banco:
        return None
    trecho = contexto_banco[:600]
    return (
        f'No momento estou com instabilidade na minha conexão externa, '
        f'mas encontrei isso na minha memória que pode te ajudar:\n\n'
        f'{trecho}\n\n'
        f'Quer que eu detalhe mais alguma parte?'
    )

def resposta_manutencao():
    return (
        f'Oi, {nome_usuario}! 😊 Esse conteúdo ainda está chegando para mim — '
        f'estou em atualização constante e em breve terei mais informações sobre isso. '
        f'Enquanto isso, posso te ajudar com outra coisa?'
    )

# =========================================================
# SYSTEM PROMPT
# =========================================================
system_prompt = os.getenv('SYSTEM_PROMPT', '').strip()
if not system_prompt:
    system_prompt = 'Você é a Iana, assistente gamer animada e inteligente.'

# =========================================================
# CONTEXTO
# =========================================================
contexto_banco = consultar_memoria(msg_final, id_conversa)

bloco_contexto = ''
if contexto_banco:
    bloco_contexto = f'''
=== MEMÓRIA DA IANA ===
{contexto_banco}
=== FIM ===
'''

# =========================================================
# GEMINI
# =========================================================
chave = os.getenv('GEMINI_API_KEY', '').strip().replace('"', '').replace("'", '')
modelo_gemini = os.getenv('GEMINI_MODEL', 'gemini-2.5-flash-lite')
url = f'https://generativelanguage.googleapis.com/v1beta/models/{modelo_gemini}:generateContent'

if not chave:
    texto_final = resposta_do_banco_local(contexto_banco) or resposta_manutencao()
    print(texto_final)
    sys.exit(0)

# =========================================================
# REQUEST (RESPOSTA DO CHAT + MINERAÇÃO NO IANA_DATABASE)
# =========================================================
try:
    resposta_api = requests.post(
        url,
        json={
            'system_instruction': {'parts': [{'text': system_prompt}]},
            'contents': [{
                'parts': [{
                    'text': f'{bloco_contexto}\n\nUsuário ({nome_usuario}): {msg_final}'
                }]
            }]
        },
        headers={'x-goog-api-key': chave, 'Content-Type': 'application/json'},
        timeout=30
    )
    resposta_api.raise_for_status()
    dados = resposta_api.json()
    texto_final = (
        dados.get('candidates', [{}])[0]
             .get('content', {})
             .get('parts', [{}])[0]
             .get('text', '')
    )

    if not texto_final:
        texto_final = resposta_do_banco_local(contexto_banco) or resposta_manutencao()

    # 1. Salva o histórico padrão da conversa
    salvar_conversa(msg_final, texto_final, id_conversa)

    # 2. Mineração Automática do Título/Tópico para o iana_database
    if banco_ok and len(msg_final) > 5:
        try:
            prompt_mineracao = (
                "Leia a mensagem do usuário a seguir e extraia o tópico ou assunto principal "
                "em um título curto de no máximo 4 palavras. Seja direto, traga apenas o título "
                f"sem aspas e sem pontuação. Mensagem: {msg_final}"
            )

            req_mineracao = requests.post(
                url,
                json={'contents': [{'parts': [{'text': prompt_mineracao}]}]},
                headers={'x-goog-api-key': chave, 'Content-Type': 'application/json'},
                timeout=10
            )

            if req_mineracao.ok:
                dados_minados = req_mineracao.json()
                titulo_minerado = (
                    dados_minados.get('candidates', [{}])[0]
                                  .get('content', {})
                                  .get('parts', [{}])[0]
                                  .get('text', '')
                                  .strip()
                )

                if titulo_minerado and len(titulo_minerado) < 60:
                    topic_id = 'topic_' + hashlib.md5(f'{titulo_minerado}'.encode()).hexdigest()
                    colecao.add(
                        documents=[f"Tópico: {titulo_minerado} | Contexto original: {msg_final}"],
                        embeddings=[modelo.encode(titulo_minerado).tolist()],
                        metadatas=[{
                            'tipo': 'topico_minerado',
                            'titulo_busca': titulo_minerado,
                            'conversa_id': id_conversa,
                            'timestamp': time.time()
                        }],
                        ids=[topic_id]
                    )
        except Exception as e_min:
            sys.stderr.write(f'[AVISO] Falha ao minerar título: {e_min}\n')

    print(texto_final)

except requests.exceptions.Timeout:
    texto_final = resposta_do_banco_local(contexto_banco)
    if not texto_final:
        sys.stderr.write('[AVISO] Timeout na API Gemini\n')
        texto_final = 'Erro 504'
    print(texto_final)

except requests.exceptions.HTTPError as e:
    status = e.response.status_code if e.response is not None else 0
    texto_final = resposta_do_banco_local(contexto_banco) or resposta_manutencao()
    sys.stderr.write(f'[AVISO] Gemini retornou status {status}\n')
    print(texto_final)

except Exception as e:
    texto_final = resposta_do_banco_local(contexto_banco)
    if not texto_final:
        sys.stderr.write(f'[AVISO] Erro inesperado: {e}\n')
        texto_final = 'Erro 500'
    print(texto_final)