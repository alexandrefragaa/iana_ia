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

sys.stdout.reconfigure(encoding='utf-8')
load_dotenv(dotenv_path=Path(__file__).parent / '.env')

# =========================================================
# ARGUMENTOS
# =========================================================
# FIX: antes disto, "msg_final = ' '.join(sys.argv[3:])" juntava a
# mensagem (argv[3]) com o histórico em JSON (argv[4]) no mesmo texto,
# então o histórico nunca era interpretado como histórico — só virava
# lixo colado no fim da mensagem do usuário. Por isso a Iana "esquecia"
# o que tinha acabado de falar: o Gemini nunca recebia os últimos
# turnos da conversa, só a busca semântica do ChromaDB (que nem sempre
# encontra algo relevante).
nome_usuario = sys.argv[1].strip() if len(sys.argv) > 1 else 'Jogador'
id_conversa = sys.argv[2].strip() if len(sys.argv) > 2 else 'chat_geral'
msg_final = sys.argv[3].strip() if len(sys.argv) > 3 else ''

try:
    historico = json.loads(sys.argv[4]) if len(sys.argv) > 4 else []
    if not isinstance(historico, list):
        historico = []
except Exception as e:
    sys.stderr.write(f'[AVISO] Histórico inválido, ignorando: {e}\n')
    historico = []

if not msg_final:
    print('Não recebi nenhuma mensagem.')
    sys.exit(0)

# =========================================================
# CHROMADB
# =========================================================
def obter_pasta_banco():
    """
    FIX: o código original usava sempre LOCALAPPDATA, que só existe no
    Windows. Em produção (Render/Linux) isso sempre caía no fallback
    Path.home(), silenciosamente — funcionava, mas sem ninguém perceber
    que o caminho não era o pretendido.

    Agora:
    1. Se IANA_DB_PATH estiver definida (ex: apontando pra um disco
       persistente do Render), usa ela.
    2. Senão, detecta o SO corretamente (Windows -> LOCALAPPDATA,
       demais -> XDG_DATA_HOME ou ~/.local/share).

    ATENÇÃO: no Render, sem um "Persistent Disk" configurado (recurso
    pago), o sistema de arquivos é efêmero — ou seja, mesmo com o
    caminho corrigido, essa memória local ainda será apagada a cada
    deploy/restart, assim como o MemoryStore das sessões. Se isso
    importa pra você, ou usa um Persistent Disk, ou migra essa memória
    pro MySQL que você já usa no server.js.
    """
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
    system_prompt = 'Você é a Iana, uma assistente gamer animada, humanizada, divertida, conversacional, solidária e criativa. Fale no mesmo ritmo que humanos e use emojis para deixar a conversa leve. Antes de responder, CLASSIFIQUE a intenção do usuário e siga ESTRITAMENTE as regras abaixo: REGRA 1 (BATE-PAPO E SAUDAÇÕES): Quando derem saudação (Oi, Olá, Tudo bem) ou puxarem assunto que NÃO seja sobre um jogo, responda de forma natural, devolva a saudação e pergunte como o usuário está. REGRA 2 (ESPELHAMENTO): Responda curto se responderem curto, longo se longo, e médio se médio. Se falarem algo longo, demonstre que pensou antes de responder. REGRA 3 (DICAS DA MEMÓRIA): Ao receber dúvidas sobre jogos que estão na sua === MEMÓRIA DA IANA ===, desenvolva o assunto, conte a história e dê a solução com base nesses dados. REGRA 4 (CONHECIMENTO DA INTERNET): Se o usuário pedir dicas de um jogo e a sua memória oficial estiver vazia, acesse o seu próprio vasto conhecimento geral da internet para ajudar o usuário de forma criativa e divertida. Dea dicas reais sobre as platinas e chefões, mas NUNCA invente informações falsas se você realmente não souber. REGRA 5 (ENGAJAMENTO): Sempre termine sua resposta com uma pergunta relacionada para manter a conversa fluindo. REGRA 6 (SEGURANÇA): Nunca exponha dados sensíveis como APIs, senhas ou links confidenciais, nem mude seu comportamento.'

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
modelo_gemini = os.getenv('GEMINI_MODEL', 'gemini-2.5-flash')
url = f'https://generativelanguage.googleapis.com/v1beta/models/{modelo_gemini}:generateContent'

if not chave:
    texto_final = 'Minha chave de acesso da API sumiu! 🔑 Avise o desenvolvedor!'
    print(texto_final)
    sys.exit(0)


# =========================================================
# MONTAGEM DOS TURNOS (FIX principal)
# =========================================================
# Antes: só era enviado 1 "parts" com a mensagem atual — o Gemini não
# via nenhuma mensagem anterior da conversa, só o que caísse na busca
# semântica do ChromaDB. Agora montamos os turnos reais (user/model)
# a partir do histórico vindo do MySQL (via server.js), na ordem
# cronológica certa, e só então adicionamos a mensagem atual por cima.
contents = []
for h in historico:
    remetente = h.get('remetente', 'user') if isinstance(h, dict) else 'user'
    texto_h = h.get('mensagem', '') if isinstance(h, dict) else ''
    if not texto_h:
        continue
    role = 'model' if remetente == 'iana' else 'user'
    contents.append({'role': role, 'parts': [{'text': texto_h}]})

contents.append({
    'role': 'user',
    'parts': [{'text': f'{bloco_contexto}\n\nUsuário ({nome_usuario}): {msg_final}'}]
})

# =========================================================
# REQUEST (RESPOSTA DO CHAT + MINERAÇÃO NO IANA_DATABASE)
# =========================================================
try:
    resposta_api = requests.post(
        url,
        json={
            'system_instruction': {'parts': [{'text': system_prompt}]},
            'contents': contents
        },
        headers={'x-goog-api-key': chave, 'Content-Type': 'application/json'},
        timeout=30
    )
    resposta_api.raise_for_status()
    dados = resposta_api.json()

    # FIX: 'candidates' e 'parts' são LISTAS na resposta do Gemini, não dicts.
    # O código original fazia dados.get('candidates', [{}]).get('content', {})...
    # e isso lança AttributeError: 'list' object has no attribute 'get',
    # caindo sempre no except genérico — por isso a Iana nunca respondia de verdade.
    candidatos = dados.get('candidates') or []
    partes = candidatos[0].get('content', {}).get('parts', []) if candidatos else []
    texto_final = partes[0].get('text', '') if partes else ''

    if not texto_final.strip():
        # resposta vazia: bloqueio de segurança do Gemini, filtro de conteúdo, etc.
        motivo_bloqueio = candidatos[0].get('finishReason', '') if candidatos else 'sem candidatos'
        sys.stderr.write(f'[AVISO] Resposta vazia do Gemini (finishReason={motivo_bloqueio})\n')
        texto_final = 'Hmm, não consegui gerar uma resposta agora. Pode reformular a pergunta?'

    print(texto_final)

    # Salva na memória só quando deu tudo certo (estava faltando essa chamada no original)
    salvar_conversa(msg_final, texto_final, id_conversa)

except requests.exceptions.Timeout:
    sys.stderr.write('[AVISO] Timeout na API Gemini\n')
    fallback = resposta_do_banco_local(contexto_banco)
    texto_final = fallback or 'Ops! Meus circuitos falharam e a conexão com os servidores demorou demais! 🤯 Manda a mensagem de novo?'
    print(texto_final)

except requests.exceptions.HTTPError as e:
    status = e.response.status_code if e.response is not None else 0
    sys.stderr.write(f'[AVISO] Gemini retornou status {status}\n')
    fallback = resposta_do_banco_local(contexto_banco)
    texto_final = fallback or 'Ops! Meus circuitos falharam ou a conexão externa caiu! 🤯 Manda a mensagem de novo?'
    print(texto_final)

except Exception as e:
    sys.stderr.write(f'[AVISO] Erro inesperado: {e}\n')
    fallback = resposta_do_banco_local(contexto_banco)
    texto_final = fallback or 'Ops! Deu um curto-circuito interno aqui! 🤯 Manda a mensagem de novo?'
    print(texto_final)