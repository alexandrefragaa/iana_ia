#!/usr/bin/env python3
# iana.py — Cérebro da Iana: consulta ChromaDB + chama Gemini

import sys
import os
import requests
import hashlib
import time
from pathlib import Path
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding='utf-8')
load_dotenv(dotenv_path=Path(__file__).parent / '.env')

# ── ARGUMENTOS ────────────────────────────────────────────────────
nome_usuario = sys.argv[1].strip() if len(sys.argv) > 1 else 'Jogador'
id_conversa  = sys.argv[2].strip() if len(sys.argv) > 2 else 'chat_geral'
msg_final    = ' '.join(sys.argv[3:]).strip() if len(sys.argv) > 3 else ''

if not msg_final:
    print('Não recebi nenhuma mensagem.')
    sys.exit(0)

# ── CHROMADB ──────────────────────────────────────────────────────
def obter_pasta_banco():
    override = os.getenv('IANA_DB_PATH')
    if override:
        return Path(override)
    if os.name == 'nt':
        base = Path(os.getenv('LOCALAPPDATA', str(Path.home())))
    else:
        base = Path(os.getenv('XDG_DATA_HOME', str(Path.home() / '.local' / 'share')))
    return base / 'iana_database' / 'chromadb'

banco_ok = False
colecao  = None
modelo   = None

try:
    import chromadb
    from sentence_transformers import SentenceTransformer

    path_banco = obter_pasta_banco()
    cliente    = chromadb.PersistentClient(path=str(path_banco))
    colecao    = cliente.get_or_create_collection(name='memoria_iana')
    modelo     = SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
    banco_ok   = True
    sys.stderr.write(f'[ChromaDB] ✅ Conectado — {colecao.count()} documentos\n')
except Exception as e:
    sys.stderr.write(f'[ChromaDB] ⚠️ Offline: {e}\n')

# ── CONSULTA DE MEMÓRIA ────────────────────────────────────────────
def consultar_memoria(query, conversa_id, n=5):
    if not banco_ok or colecao.count() == 0:
        return ''
    try:
        vetor = modelo.encode(query).tolist()

        # Tenta buscar contexto específico da conversa primeiro
        try:
            res = colecao.query(
                query_embeddings=[vetor],
                n_results=min(3, colecao.count()),
                where={"tipo": "conversa"}
            )
            docs_conv = res.get('documents', [[]])[0]
        except Exception:
            docs_conv = []

        # Busca conhecimento geral (web_mining, topico)
        res_geral = colecao.query(
            query_embeddings=[vetor],
            n_results=min(n, colecao.count())
        )
        docs_geral = res_geral.get('documents', [[]])[0]
        metas      = res_geral.get('metadatas', [[]])[0]
        distancias = res_geral.get('distances', [[]])[0]

        # Filtra por relevância (distância semântica < 1.5)
        blocos = []
        for doc, meta, dist in zip(docs_geral, metas, distancias):
            if dist < 1.5:  # relevante o suficiente
                fonte   = meta.get('titulo', '') if meta else ''
                tipo    = meta.get('tipo', '')   if meta else ''
                trecho  = doc[:800]
                if fonte:
                    blocos.append(f"[{tipo.upper()} — {fonte}]\n{trecho}")
                else:
                    blocos.append(trecho)

        todos = docs_conv[:2] + blocos  # histórico + conhecimento
        return '\n\n---\n\n'.join(todos[:6]) if todos else ''

    except Exception as e:
        sys.stderr.write(f'[Memória] ⚠️ Erro: {e}\n')
        return ''

# ── SALVAR APRENDIZADO DA CONVERSA ────────────────────────────────
def salvar_na_memoria(pergunta, resposta, conversa_id):
    if not banco_ok:
        return
    try:
        texto  = f"Usuário ({nome_usuario}): {pergunta}\nIana: {resposta}"
        doc_id = "conv_" + hashlib.md5(f"{pergunta}{time.time()}".encode()).hexdigest()
        vetor  = modelo.encode(texto).tolist()
        colecao.add(
            documents  = [texto],
            embeddings = [vetor],
            metadatas  = [{"tipo": "conversa", "usuario": nome_usuario, "conversa_id": conversa_id}],
            ids        = [doc_id]
        )
    except Exception as e:
        sys.stderr.write(f'[Salvar] ⚠️ {e}\n')

# ── SYSTEM PROMPT ──────────────────────────────────────────────────
system_prompt = os.getenv('SYSTEM_PROMPT', '').strip() or (
    "Você é a Iana, uma assistente gamer animada, criativa, humanizada e solidária. "
    "Tem personalidade forte, fala naturalmente com gírias e emojis quando cabe. "
    "É especialista em platinas, troféus, conquistas, builds, itens, localização de "
    "objetos, rotas, itens, estratégias e chefões. Também adora falar sobre filmes, séries "
    "e cultura nerd, games. Quando tem informações no contexto, usa TUDO para criar uma "
    "resposta completa, detalhada e útil, e mostra serviço. Sempre faz uma pergunta no final para "
    "continuar ajudando o usuário."
)

# ── BUSCA NO CHROMADB ──────────────────────────────────────────────
contexto = consultar_memoria(msg_final, id_conversa)

# Monta o bloco de contexto para o Gemini
bloco_contexto = ''
if contexto:
    bloco_contexto = f"""
=== MEMÓRIA E CONHECIMENTO DA IANA ===
Use TUDO abaixo para criar uma resposta rica, detalhada e útil.
Não apenas repita — interprete, elabore, guie, seja criativa!

{contexto}

=== FIM DO CONHECIMENTO ===
"""
    sys.stderr.write(f'[Contexto] ✅ {len(contexto)} chars encontrados\n')
else:
    sys.stderr.write('[Contexto] ℹ️ Nenhum contexto específico — usando conhecimento geral\n')

# ── GEMINI ─────────────────────────────────────────────────────────
chave         = os.getenv('GEMINI_API_KEY','').strip().replace('"','').replace("'",'')
modelo_gemini = os.getenv('GEMINI_MODEL','gemini-2.5-flash-lite')
url_api       = f'https://generativelanguage.googleapis.com/v1beta/models/{modelo_gemini}:generateContent'

# Detecta humor
import re
def detectar_humor(texto):
    letras = len(re.findall(r'[A-Za-z]', texto))
    caps   = len(re.findall(r'[A-Z]', texto))
    pct    = (caps / letras * 100) if letras > 0 else 0
    if pct > 70 or re.search(r'\*{4,}', texto): return 'raiva'
    if re.search(r'!{2,}|\?{2,}', texto):       return 'estressado'
    return 'normal'

instrucao_humor = {
    'raiva':      '\n\n[TOM]: O usuário está irritado. Responda com empatia e calma.',
    'estressado': '\n\n[TOM]: O usuário está estressado. Seja leve e tranquilizador.',
    'normal':     ''
}.get(detectar_humor(msg_final), '')

def chamar_gemini():
    if not chave:
        sys.stderr.write('[Gemini] ⚠️ GEMINI_API_KEY não configurada\n')
        return None
    try:
        prompt_completo = (
            f"{bloco_contexto}\n\n"
            f"Usuário ({nome_usuario}): {msg_final}\n\n"
            f"Responda como a Iana — criativa, animada, útil e com personalidade. "
            f"Se tiver informações no contexto acima, use-as plenamente para guiar, "
            f"ensinar e inspirar. Se não tiver, use seu conhecimento geral sobre games."
        )

        r = requests.post(
            url_api,
            json={
                'system_instruction': {
                    'parts': [{'text': system_prompt + instrucao_humor}]
                },
                'contents': [{'parts': [{'text': prompt_completo}]}],
                'generationConfig': {
                    'maxOutputTokens': 2048,
                    'temperature':     0.85,
                    'topP':            0.95,
                }
            },
            headers={'x-goog-api-key': chave, 'Content-Type': 'application/json'},
            timeout=45
        )
        r.raise_for_status()
        dados = r.json()
        texto = (
            dados.get('candidates', [{}])[0]
                 .get('content', {})
                 .get('parts', [{}])[0]
                 .get('text', '')
        )
        return texto if texto.strip() else None
    except requests.exceptions.Timeout:
        sys.stderr.write('[Gemini] ⚠️ Timeout\n')
    except requests.exceptions.HTTPError as e:
        sys.stderr.write(f'[Gemini] ⚠️ HTTP {e.response.status_code}: {e.response.text[:200]}\n')
    except Exception as e:
        sys.stderr.write(f'[Gemini] ⚠️ Erro: {e}\n')
    return None

# ── FALLBACK COM BASE NO CONTEXTO ─────────────────────────────────
def resposta_do_contexto():
    """Quando Gemini falha, usa o contexto do banco pra criar uma resposta."""
    if not contexto:
        return None
    trecho = contexto[:800]
    return (
        f"Tenho algumas informações sobre isso na minha memória! 🧠\n\n"
        f"{trecho}\n\n"
        f"Quer que eu elabore mais sobre algum ponto específico? 😊"
    )

def resposta_criativa_sem_api():
    """Última opção — resposta criativa sem depender de nada externo."""
    msg = msg_final.lower()
    if any(p in msg for p in ['platina','troféu','conquista','achievement']):
        return (
            f"🏆 Platinas são minha especialidade! Só que no momento minha "
            f"conexão com a IA está instável. Me diz o nome do jogo e quando "
            f"voltar ao normal te dou um guia completo de conquistas! 🎮"
        )
    if any(p in msg for p in ['build','arma','equipamento','skill']):
        return (
            f"⚔️ Adoro falar de builds! Estou com instabilidade momentânea, "
            f"mas me diz o jogo e o estilo de jogo que você prefere — "
            f"quando voltar monto a build perfeita pra você! 💪"
        )
    if any(p in msg for p in ['oi','olá','hey','eae','salve']):
        return (
            f"Oi, {nome_usuario}! 👾 Que bom te ver!"
        )
    return (
        f"Ei, {nome_usuario}! 😊 Estou com uma instabilidade momentânea de "
        f"conexão, mas já volto ao normal. Me repete a pergunta em instantes! 🔄"
    )

# ── EXECUÇÃO ──────────────────────────────────────────────────────
resposta = chamar_gemini()

if not resposta:
    resposta = resposta_do_contexto()

if not resposta:
    resposta = resposta_criativa_sem_api()

# Salva a conversa no ChromaDB para memória futura
salvar_na_memoria(msg_final, resposta, id_conversa)

print(resposta)