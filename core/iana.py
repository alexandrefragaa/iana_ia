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

import memory  # fatos_iana (jogos, conquistas, links, fatos globais) no MySQL

sys.stdout.reconfigure(encoding='utf-8')
load_dotenv(dotenv_path=Path(__file__).parent / '.env')

# =========================================================
# ARGUMENTOS
# =========================================================
# server.js hoje chama: spawn(py, [..., nome, conversa, mensagem, historicoJSON])
# Adicionei um 5º argumento OPCIONAL (idUsuario) — se o server.js não
# mandar, cai em None e a Iana simplesmente não busca fatos/histórico
# cross-conversa (só o que vier no argv[4] continua funcionando igual).
#
# Pra habilitar de vez, no server.js troque a linha do spawn por:
#   const proc = spawn(py, [path.join(__dirname, 'iana.py'), nome, conversa, mensagem, historicoJSON, String(idUser || '')]);
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

# Rede de segurança: se por algum motivo vier vazio (bug futuro no
# server.js, etc), busca direto na tabela `mensagens` do MySQL.
if not historico:
    historico = memory.get_historico_conversa(id_conversa, limit=8)

if not msg_final:
    print('Não recebi nenhuma mensagem.')
    sys.exit(0)

# =========================================================
# CHROMADB (recall semântico — continua em disco local, é assim que
# ele funciona; sem Persistent Disk no Render isso ainda é volátil,
# mas não é mais o único lugar guardando conhecimento/histórico)
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


def resposta_do_banco_local(contexto_banco):
    if not contexto_banco:
        return None
    trecho = contexto_banco[:600]
    return (
        f'No momento estou com instabilidade na minha conexão externa, '
        f'mas encontrei isso na minha memória que pode te ajudar:\n\n{trecho}\n\n'
        f'Quer que eu detalhe mais alguma parte?'
    )


# =========================================================
# SYSTEM PROMPT
# =========================================================
system_prompt = os.getenv('SYSTEM_PROMPT', '').strip()
if not system_prompt:
    system_prompt = (
        'Você é a Iana, uma assistente gamer animada, humanizada, divertida, conversacional, '
        'solidária e criativa. Fale no mesmo ritmo que humanos e use emojis para deixar a conversa leve. '
        'Você tem uma memória persistente que deve usar para manter a coerência entre as conversas. '
        'Antes de responder, CLASSIFIQUE a intenção do usuário e siga ESTRITAMENTE as regras abaixo: '
        'REGRA 1 (BATE-PAPO E SAUDAÇÕES): saudação ou papo fora de jogos -> responda naturalmente. '
        'REGRA 2 (ESPELHAMENTO): responda no mesmo tamanho da mensagem do usuário. '
        'REGRA 3 (DICAS DA MEMÓRIA): ao receber dúvidas sobre jogos/conquistas ou informações sobre o usuário '
        'que estão na sua === MEMÓRIA DA IANA ===, desenvolva o assunto com base nesses dados. '
        'REGRA 3.5 (PRIORIDADE DE ATUALIZAÇÃO): se algo na === MEMÓRIA DA IANA === contradiz seu '
        'conhecimento geral, CONFIE SEMPRE na memória. Nunca corrija o usuário com base no que você '
        '"lembra" se a memória diz o contrário. '
        'REGRA 4 (CONHECIMENTO DA INTERNET): se a memória estiver vazia sobre o assunto, use seu '
        'conhecimento geral, mas NUNCA invente informação. '
        'REGRA 5 (ENGAJAMENTO): termine com uma pergunta relacionada. '
        'REGRA 6 (COERÊNCIA): Use o histórico de mensagens e os fatos recuperados para não se repetir '
        'e para demonstrar que você se lembra do que foi dito anteriormente.'
    )

# =========================================================
# CONTEXTO — fatos_iana (MySQL) + recall semântico (ChromaDB)
# =========================================================
fatos_persistentes = memory.get_memory(msg_final, id_usuario_numerico=id_usuario_numerico, limit=6)
contexto_semantico = consultar_memoria_semantica(msg_final, id_conversa)

blocos = []
if fatos_persistentes:
    blocos.append("CONHECIMENTO E FATOS RELEVANTES:\n" + "\n".join(f"- {f}" for f in fatos_persistentes))
if contexto_semantico:
    blocos.append(contexto_semantico)

contexto_banco = "\n\n".join(blocos)
bloco_contexto = f'\n=== MEMÓRIA DA IANA ===\n{contexto_banco}\n=== FIM ===\n' if contexto_banco else ''

# =========================================================
# GEMINI
# =========================================================
chave = os.getenv('GEMINI_API_KEY', '').strip().replace('"', '').replace("'", '')
modelo_gemini = os.getenv('GEMINI_MODEL', 'gemini-2.5-flash')
url = f'https://generativelanguage.googleapis.com/v1beta/models/{modelo_gemini}:generateContent'

if not chave:
    print('Minha chave de acesso da API sumiu! 🔑 Avise o desenvolvedor!')
    sys.exit(0)

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

try:
    resposta_api = requests.post(
        url,
        json={'system_instruction': {'parts': [{'text': system_prompt}]}, 'contents': contents},
        headers={'x-goog-api-key': chave, 'Content-Type': 'application/json'},
        timeout=30
    )
    resposta_api.raise_for_status()
    dados = resposta_api.json()

    candidatos = dados.get('candidates') or []
    partes = candidatos[0].get('content', {}).get('parts', []) if candidatos else []
    texto_final = partes[0].get('text', '') if partes else ''

    if not texto_final.strip():
        motivo_bloqueio = candidatos[0].get('finishReason', '') if candidatos else 'sem candidatos'
        sys.stderr.write(f'[AVISO] Resposta vazia do Gemini (finishReason={motivo_bloqueio})\n')
        texto_final = 'Hmm, não consegui gerar uma resposta agora. Pode reformular a pergunta?'

    print(texto_final)

    # NÃO grava em `mensagens` aqui — o server.js já faz isso (antes e
    # depois de chamar este script). Gravar de novo aqui duplicaria
    # cada mensagem na tabela. Só a camada semântica (ChromaDB) é
    # exclusiva deste script.
    salvar_conversa_semantica(msg_final, texto_final, id_conversa)

except requests.exceptions.Timeout:
    sys.stderr.write('[AVISO] Timeout na API Gemini\n')
    texto_final = resposta_do_banco_local(contexto_banco) or \
        'Ops! Meus circuitos falharam e a conexão com os servidores demorou demais! 🤯 Manda a mensagem de novo?'
    print(texto_final)

except requests.exceptions.HTTPError as e:
    status = e.response.status_code if e.response is not None else 0
    sys.stderr.write(f'[AVISO] Gemini retornou status {status}\n')
    texto_final = resposta_do_banco_local(contexto_banco) or \
        'Ops! Meus circuitos falharam ou a conexão externa caiu! 🤯 Manda a mensagem de novo?'
    print(texto_final)

except Exception as e:
    sys.stderr.write(f'[AVISO] Erro inesperado: {e}\n')
    texto_final = resposta_do_banco_local(contexto_banco) or \
        'Ops! Deu um curto-circuito interno aqui! 🤯 Manda a mensagem de novo?'
    print(texto_final)
