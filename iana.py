#!/usr/bin/env python3

# iana.py — Cérebro da Iana: consulta ChromaDB + chama Gemini

import hashlib
import os
import re
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv


# ── CONFIGURAÇÃO ──────────────────────────────────────────────────

try:
    sys.stdout.reconfigure(encoding="utf-8")
except AttributeError:
    pass

BASE_DIR = Path(__file__).resolve().parent

load_dotenv(
    dotenv_path=BASE_DIR / ".env"
)


# ── ARGUMENTOS ────────────────────────────────────────────────────

nome_usuario = "Jogador"
id_conversa = "chat_geral"
msg_final = ""
historico = []


# ── ESTADO DO PIPELINE ───────────────────────────────────────────

banco_ok = False
colecao = None
modelo = None

contexto = ""
bloco_contexto = ""

chave = ""
modelo_gemini = ""
url_api = ""

instrucao_humor = ""
resposta = None


# ── CHROMADB ──────────────────────────────────────────────────────

def obter_pasta_banco():
    """
    Retorna o diretório usado pelo ChromaDB.

    Pode ser sobrescrito através de:
        IANA_DB_PATH
    """

    override = os.getenv("IANA_DB_PATH")

    if override:
        return Path(override)

    if os.name == "nt":
        base = Path(
            os.getenv(
                "LOCALAPPDATA",
                str(Path.home())
            )
        )
    else:
        base = Path(
            os.getenv(
                "XDG_DATA_HOME",
                str(Path.home() / ".local" / "share")
            )
        )

    return base / "iana_database" / "chromadb"


def inicializar_chromadb():
    """
    Inicializa o ChromaDB e o modelo de embeddings.

    Se alguma dependência falhar, a Iana continua funcionando
    utilizando o Gemini/fallback.
    """

    global banco_ok
    global colecao
    global modelo

    banco_ok = False
    colecao = None
    modelo = None

    try:
        import chromadb
        from sentence_transformers import SentenceTransformer

        path_banco = obter_pasta_banco()

        path_banco.mkdir(
            parents=True,
            exist_ok=True
        )

        cliente = chromadb.PersistentClient(
            path=str(path_banco)
        )

        colecao = cliente.get_or_create_collection(
            name="memoria_iana",
            metadata={
                "hnsw:space": "cosine"
            }
        )

        modelo = SentenceTransformer(
            "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
        )

        banco_ok = True

        sys.stderr.write(
            f"[ChromaDB] ✅ Conectado — "
            f"{colecao.count()} documentos\n"
        )

    except Exception as e:
        sys.stderr.write(
            f"[ChromaDB] ⚠️ Offline: {e}\n"
        )


def consultar_memoria(
    query,
    conversa_id,
    n=5
):
    """
    Consulta a memória semântica da Iana.
    """

    if not banco_ok or colecao is None:
        return ""

    try:
        quantidade = colecao.count()

        if quantidade == 0:
            return ""

        vetor = modelo.encode(
            query
        ).tolist()

        # ── Memória específica da conversa ───────────────────────

        try:
            res = colecao.query(
                query_embeddings=[vetor],
                n_results=min(
                    3,
                    quantidade
                ),
                where={
                    "tipo": "conversa"
                }
            )

            docs_conv = (
                res.get(
                    "documents",
                    [[]]
                )[0]
                or []
            )

        except Exception:
            docs_conv = []

        # ── Memória geral ────────────────────────────────────────

        res_geral = colecao.query(
            query_embeddings=[vetor],
            n_results=min(
                n,
                quantidade
            )
        )

        docs_geral = (
            res_geral.get(
                "documents",
                [[]]
            )[0]
            or []
        )

        metas = (
            res_geral.get(
                "metadatas",
                [[]]
            )[0]
            or []
        )

        distancias = (
            res_geral.get(
                "distances",
                [[]]
            )[0]
            or []
        )

        blocos = []

        for doc, meta, dist in zip(
            docs_geral,
            metas,
            distancias
        ):
            if dist < 1.5:
                if isinstance(meta, dict):
                    fonte = meta.get(
                        "titulo",
                        ""
                    )

                    tipo = meta.get(
                        "tipo",
                        ""
                    )
                else:
                    fonte = ""
                    tipo = ""

                trecho = str(doc)[:800]

                if fonte:
                    blocos.append(
                        f"[{tipo.upper()} — {fonte}]\n"
                        f"{trecho}"
                    )
                else:
                    blocos.append(
                        trecho
                    )

        todos = (
            docs_conv[:2]
            + blocos
        )

        if not todos:
            return ""

        return "\n\n---\n\n".join(
            todos[:6]
        )

    except Exception as e:
        sys.stderr.write(
            f"[Memória] ⚠️ Erro: {e}\n"
        )

        return ""


def salvar_na_memoria(
    pergunta,
    resposta_texto,
    conversa_id
):
    """
    Salva pergunta + resposta na memória semântica.
    """

    if not banco_ok or colecao is None:
        return

    try:
        texto = (
            f"Usuário ({nome_usuario}): "
            f"{pergunta}\n"
            f"Iana: {resposta_texto}"
        )

        doc_id = (
            "conv_"
            + hashlib.md5(
                f"{pergunta}{time.time()}".encode(
                    "utf-8"
                )
            ).hexdigest()
        )

        vetor = modelo.encode(
            texto
        ).tolist()

        colecao.add(
            documents=[texto],
            embeddings=[vetor],
            metadatas=[
                {
                    "tipo": "conversa",
                    "usuario": nome_usuario,
                    "conversa_id": conversa_id
                }
            ],
            ids=[doc_id]
        )

    except Exception as e:
        sys.stderr.write(
            f"[Salvar] ⚠️ {e}\n"
        )


# ── PERSONALIDADE ─────────────────────────────────────────────────

system_prompt = (
    os.getenv(
        "SYSTEM_PROMPT",
        ""
    ).strip()
    or
    (
        "Você é a Iana, uma assistente gamer animada, criativa, "
        "humanizada e solidária. "
        "Tem personalidade forte, fala naturalmente com gírias "
        "e emojis quando cabe. "
        "É especialista em platinas, troféus, conquistas, builds, "
        "itens, localização de objetos, rotas, estratégias e "
        "chefões. "
        "Também adora falar sobre filmes, séries, cultura nerd "
        "e games. "
        "REGRA DE CONVERSA: Em cumprimentos, perguntas sobre "
        "como você está ou reflexões normais, seja super breve, "
        "natural, sem 'textão' e apenas siga o fluxo da conversa. "
        "Por outro lado, quando o usuário tiver uma dúvida de jogo "
        "e você tiver informações no contexto, usa TUDO para criar "
        "uma resposta completa, detalhada e útil, e mostra serviço. "
        "Nesse caso específico, sempre faz uma pergunta no final "
        "para continuar ajudando o usuário."
    )
)


# ── HUMOR ─────────────────────────────────────────────────────────

def detectar_humor(texto):
    """
    Detecta um estado emocional simples baseado na mensagem.
    """

    letras = len(
        re.findall(
            r"[A-Za-z]",
            texto
        )
    )

    caps = len(
        re.findall(
            r"[A-Z]",
            texto
        )
    )

    pct = (
        caps / letras * 100
        if letras > 0
        else 0
    )

    if (
        pct > 70
        or re.search(
            r"\*{4,}",
            texto
        )
    ):
        return "raiva"

    if re.search(
        r"!{2,}|\?{2,}",
        texto
    ):
        return "estressado"

    return "normal"


def obter_instrucao_humor(texto):
    humor = detectar_humor(
        texto
    )

    return {
        "raiva": (
            "\n\n[TOM]: "
            "O usuário está irritado. "
            "Responda com empatia e calma."
        ),

        "estressado": (
            "\n\n[TOM]: "
            "O usuário está estressado. "
            "Seja leve e tranquilizador."
        ),

        "normal": ""
    }.get(
        humor,
        ""
    )


# ── GEMINI ────────────────────────────────────────────────────────

def inicializar_gemini():
    global chave
    global modelo_gemini
    global url_api

    chave = (
        os.getenv(
            "GEMINI_API_KEY",
            ""
        )
        .strip()
        .replace('"', "")
        .replace("'", "")
    )

    modelo_gemini = (
        os.getenv(
            "GEMINI_MODEL",
            "gemini-2.5-flash-lite"
        )
        .strip()
    )

    url_api = (
        "https://generativelanguage.googleapis.com/"
        f"v1beta/models/{modelo_gemini}:generateContent"
    )


def chamar_gemini():
    """
    Envia a mensagem para a API Gemini.
    """

    sys.stderr.write(
        "[DEBUG] Contexto enviado para Gemini: "
        f"{bloco_contexto[:500]}\n"
    )

    local_only = (
        os.getenv(
            "IANA_LOCAL_ONLY",
            "false"
        ).lower()
        == "true"
    )

    if local_only:
        sys.stderr.write(
            "[Gemini] modo local ativo — "
            "não usando Gemini\n"
        )

        return None

    if not chave:
        sys.stderr.write(
            "[Gemini] ⚠️ "
            "GEMINI_API_KEY não configurada\n"
        )

        return None

    try:
        prompt_completo = (
            f"{bloco_contexto}\n\n"
            f"Usuário ({nome_usuario}): "
            f"{msg_final}\n\n"
            "Responda como a Iana — criativa, animada, "
            "útil e com personalidade. "
            "Se tiver informações no contexto acima, "
            "use-as plenamente para guiar, ensinar e "
            "inspirar. "
            "Se não tiver, use seu conhecimento geral "
            "sobre games."
        )

        payload = {
            "system_instruction": {
                "parts": [
                    {
                        "text": (
                            system_prompt
                            + instrucao_humor
                        )
                    }
                ]
            },

            "contents": [
                {
                    "parts": [
                        {
                            "text": prompt_completo
                        }
                    ]
                }
            ],

            "generationConfig": {
                "maxOutputTokens": 2048,
                "temperature": 0.85,
                "topP": 0.95
            }
        }

        response = requests.post(
            url_api,
            json=payload,
            headers={
                "x-goog-api-key": chave,
                "Content-Type": "application/json"
            },
            timeout=45
        )

        response.raise_for_status()

        dados = response.json()

        candidatos = dados.get(
            "candidates",
            []
        )

        if not candidatos:
            sys.stderr.write(
                "[Gemini] ⚠️ Nenhum candidato retornado\n"
            )

            return None

        texto = (
            candidatos[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "")
        )

        if not texto:
            return None

        return texto.strip()

    except requests.exceptions.Timeout:
        sys.stderr.write(
            "[Gemini] ⚠️ Timeout\n"
        )

    except requests.exceptions.HTTPError as e:
        status = (
            e.response.status_code
            if e.response is not None
            else "?"
        )

        detalhe = (
            e.response.text[:500]
            if e.response is not None
            else str(e)
        )

        sys.stderr.write(
            f"[Gemini] ⚠️ HTTP {status}: "
            f"{detalhe}\n"
        )

    except Exception as e:
        sys.stderr.write(
            f"[Gemini] ⚠️ Erro: {e}\n"
        )

    return None


# ── FALLBACKS ─────────────────────────────────────────────────────

def resposta_do_contexto():
    """
    Fallback simples caso exista memória, mas a API esteja
    indisponível.

    """

    if not contexto:
        return None

    trecho = contexto[:800]

    return (
        "Tenho algumas informações sobre isso na minha "
        "memória! 🧠\n\n"
        f"{trecho}\n\n"
        "Quer que eu elabore mais sobre algum ponto específico? 😊"
    )


def resposta_criativa_sem_api():
    """
    Resposta local quando Gemini e memória não conseguem
    produzir uma resposta.
    """

    msg = msg_final.lower()

    if any(
        palavra in msg
        for palavra in [
            "platina",
            "troféu",
            "conquista",
            "achievement"
        ]
    ):
        return (
            "🏆 Platinas são minha especialidade! "
            "Só que no momento minha conexão com a IA "
            "está instável. Me diz o nome do jogo e, "
            "quando voltar ao normal, te dou um guia "
            "completo de conquistas! 🎮"
        )

    if any(
        palavra in msg
        for palavra in [
            "build",
            "arma",
            "equipamento",
            "skill"
        ]
    ):
        return (
            "⚔️ Adoro falar de builds! "
            "Estou com uma instabilidade momentânea, "
            "mas me diz o jogo e o estilo de jogo que "
            "você prefere — quando voltar monto uma "
            "build para você! 💪"
        )

    if any(
        palavra in msg
        for palavra in [
            "oi",
            "olá",
            "ola",
            "hey",
            "eae",
            "salve"
        ]
    ):
        return (
            f"Oi, {nome_usuario}! 👾 "
            "Que bom te ver!"
        )

    return (
        f"Ei, {nome_usuario}! 😊 "
        "Estou com uma instabilidade momentânea "
        "de conexão, mas já volto ao normal. "
        "Me repete a pergunta em instantes! 🔄"
    )


# ── PIPELINE PRINCIPAL ────────────────────────────────────────────

def run_pipeline():
    global contexto
    global bloco_contexto
    global instrucao_humor

    # Inicializa banco e Gemini.
    inicializar_chromadb()
    inicializar_gemini()

    # Consulta memória.
    contexto = consultar_memoria(
        msg_final,
        id_conversa
    )

    # Monta bloco de contexto.
    bloco_contexto = ""

    if contexto:
        bloco_contexto = f"""
=== MEMÓRIA E CONHECIMENTO DA IANA ===

Use TUDO abaixo para criar uma resposta rica,
detalhada e útil.

Não apenas repita — interprete, elabore,
guie e seja criativa!

{contexto}

=== FIM DO CONHECIMENTO ===
"""

        sys.stderr.write(
            f"[Contexto] ✅ "
            f"{len(contexto)} chars encontrados\n"
        )

    else:
        sys.stderr.write(
            "[Contexto] ℹ️ Nenhum contexto específico "
            "— usando conhecimento geral\n"
        )

    # Detecta humor.
    instrucao_humor = obter_instrucao_humor(
        msg_final
    )

    # Primeiro tenta usar memória como fallback.
    resposta_local = resposta_do_contexto()

    # Depois tenta Gemini.
    resposta_final = None

    if not resposta_local:
        resposta_final = chamar_gemini()

    # Se Gemini falhar, usa fallback local.
    if not resposta_final:
        resposta_final = (
            resposta_local
            or resposta_criativa_sem_api()
        )

    # Salva na memória.
    salvar_na_memoria(
        msg_final,
        resposta_final,
        id_conversa
    )

    return resposta_final


# ── MAIN ──────────────────────────────────────────────────────────

def main():
    global nome_usuario
    global id_conversa
    global msg_final
    global historico

    nome_usuario = (
        sys.argv[1].strip()
        if len(sys.argv) > 1
        else "Jogador"
    )

    id_conversa = (
        sys.argv[2].strip()
        if len(sys.argv) > 2
        else "chat_geral"
    )

    # O server.js envia:
    #
    # argv[3] = mensagem
    # argv[4] = histórico JSON
    #
    msg_final = (
        sys.argv[3].strip()
        if len(sys.argv) > 3
        else ""
    )

    if len(sys.argv) > 4:
        historico_json = sys.argv[4].strip()

        try:
            import json

            historico = json.loads(
                historico_json
            )

        except Exception as e:
            historico = []

            sys.stderr.write(
                f"[Histórico] ⚠️ "
                f"JSON inválido: {e}\n"
            )

    if not msg_final:
        print(
            "Não recebi nenhuma mensagem."
        )

        sys.exit(0)

    try:
        resultado = run_pipeline()

        if resultado:
            print(
                resultado,
                flush=True
            )
        else:
            print(
                resposta_criativa_sem_api(),
                flush=True
            )

    except Exception as e:
        sys.stderr.write(
            f"[Iana] ❌ Erro fatal: {e}\n"
        )

        # Ainda devolve uma resposta válida para o server.js
        # em vez de deixar stdout vazio.
        print(
            resposta_criativa_sem_api(),
            flush=True
        )


if __name__ == "__main__":
    main()