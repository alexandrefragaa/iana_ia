#!/usr/bin/env python3

"""
IANA — cérebro da assistente.

Responsabilidades:
- consultar memória semântica no ChromaDB;
- receber histórico recente;
- montar contexto;
- aplicar personalidade/configuração;
- chamar Gemini;
- salvar pergunta + resposta na memória;
- fornecer fallback quando a API estiver indisponível.

Argumentos esperados:

argv[1] = nome do usuário
argv[2] = ID da conversa
argv[3] = mensagem atual
argv[4] = histórico JSON
argv[5] = configuração JSON opcional
"""

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv


# ================================================================
# CONFIGURAÇÃO
# ================================================================

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except AttributeError:
    pass


BASE_DIR = Path(__file__).resolve().parent

load_dotenv(
    dotenv_path=BASE_DIR / ".env"
)


# ================================================================
# ESTADO GLOBAL
# ================================================================

nome_usuario = "Jogador"
id_conversa = "chat_geral"
msg_final = ""

historico = []
config_usuario = {}

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


# ================================================================
# CHROMADB
# ================================================================

def obter_pasta_banco():
    """
    Retorna o diretório usado pelo ChromaDB.

    Pode ser sobrescrito por:

        IANA_DB_PATH
    """

    override = os.getenv("IANA_DB_PATH", "").strip()

    if override:
        return Path(override).expanduser()

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

    Se falhar, a Iana continua funcionando com Gemini.
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
            f"[ChromaDB] OK — "
            f"{colecao.count()} documentos\n"
        )

    except Exception as e:
        sys.stderr.write(
            f"[ChromaDB] OFFLINE — {e}\n"
        )


def consultar_memoria(
    query,
    conversa_id,
    n=5
):
    """
    Consulta memória semântica.

    A memória recuperada será usada como contexto do Gemini.
    """

    if not banco_ok or colecao is None or modelo is None:
        return ""

    query = str(query or "").strip()

    if not query:
        return ""

    try:
        quantidade = colecao.count()

        if quantidade == 0:
            return ""

        vetor = modelo.encode(
            query,
            normalize_embeddings=True
        ).tolist()

        documentos = []

        # --------------------------------------------------------
        # Memória específica da conversa
        # --------------------------------------------------------

        try:
            res_conv = colecao.query(
                query_embeddings=[vetor],
                n_results=min(3, quantidade),
                where={
                    "tipo": "conversa",
                    "conversa_id": conversa_id
                }
            )

            docs_conv = (
                res_conv.get(
                    "documents",
                    [[]]
                )[0]
                or []
            )

            metas_conv = (
                res_conv.get(
                    "metadatas",
                    [[]]
                )[0]
                or []
            )

            dist_conv = (
                res_conv.get(
                    "distances",
                    [[]]
                )[0]
                or []
            )

            for doc, meta, dist in zip(
                docs_conv,
                metas_conv,
                dist_conv
            ):
                if dist <= 1.2:
                    documentos.append(
                        formatar_memoria(
                            doc,
                            meta,
                            dist
                        )
                    )

        except Exception as e:
            sys.stderr.write(
                f"[Memória conversa] {e}\n"
            )

        # --------------------------------------------------------
        # Memória geral
        # --------------------------------------------------------

        try:
            res_geral = colecao.query(
                query_embeddings=[vetor],
                n_results=min(n, quantidade)
            )

            docs_geral = (
                res_geral.get(
                    "documents",
                    [[]]
                )[0]
                or []
            )

            metas_geral = (
                res_geral.get(
                    "metadatas",
                    [[]]
                )[0]
                or []
            )

            dist_geral = (
                res_geral.get(
                    "distances",
                    [[]]
                )[0]
                or []
            )

            for doc, meta, dist in zip(
                docs_geral,
                metas_geral,
                dist_geral
            ):
                if dist <= 1.2:
                    item = formatar_memoria(
                        doc,
                        meta,
                        dist
                    )

                    if item and item not in documentos:
                        documentos.append(item)

        except Exception as e:
            sys.stderr.write(
                f"[Memória geral] {e}\n"
            )

        if not documentos:
            return ""

        return "\n\n---\n\n".join(
            documentos[:6]
        )

    except Exception as e:
        sys.stderr.write(
            f"[Memória] Erro: {e}\n"
        )

        return ""


def formatar_memoria(
    documento,
    metadata,
    distancia
):
    """
    Formata uma memória para ser enviada ao modelo.
    """

    texto = str(documento or "").strip()

    if not texto:
        return ""

    texto = texto[:1200]

    if isinstance(metadata, dict):
        tipo = metadata.get(
            "tipo",
            ""
        )

        titulo = metadata.get(
            "titulo",
            ""
        )
    else:
        tipo = ""
        titulo = ""

    if titulo:
        cabecalho = (
            f"[{tipo.upper()} — {titulo}]"
            if tipo
            else f"[{titulo}]"
        )

        return (
            f"{cabecalho}\n"
            f"{texto}"
        )

    return texto


def salvar_na_memoria(
    pergunta,
    resposta_texto,
    conversa_id
):
    """
    Salva pergunta + resposta no ChromaDB.
    """

    if not banco_ok or colecao is None or modelo is None:
        return

    pergunta = str(pergunta or "").strip()
    resposta_texto = str(resposta_texto or "").strip()

    if not pergunta or not resposta_texto:
        return

    try:
        texto = (
            f"Usuário ({nome_usuario}): "
            f"{pergunta}\n"
            f"Iana: "
            f"{resposta_texto}"
        )

        identificador_base = (
            f"{conversa_id}|"
            f"{pergunta}|"
            f"{time.time_ns()}"
        )

        doc_id = (
            "conv_"
            + hashlib.sha256(
                identificador_base.encode("utf-8")
            ).hexdigest()
        )

        vetor = modelo.encode(
            texto,
            normalize_embeddings=True
        ).tolist()

        colecao.add(
            documents=[texto],
            embeddings=[vetor],
            metadatas=[
                {
                    "tipo": "conversa",
                    "usuario": nome_usuario,
                    "conversa_id": conversa_id,
                    "timestamp": str(int(time.time()))
                }
            ],
            ids=[doc_id]
        )

    except Exception as e:
        sys.stderr.write(
            f"[Salvar memória] Erro: {e}\n"
        )


# ================================================================
# PERSONALIDADE
# ================================================================

DEFAULT_SYSTEM_PROMPT = (
    "Você é a Iana, uma assistente gamer animada, "
    "criativa, humanizada e solidária. "
    "Tem personalidade forte, fala naturalmente, "
    "pode usar gírias e emojis quando fizer sentido. "

    "É especialista em jogos, platinas, troféus, "
    "conquistas, builds, itens, localização de objetos, "
    "rotas, estratégias, chefões e mecânicas. "

    "Também gosta de filmes, séries, cultura nerd e tecnologia. "

    "REGRA DE CONVERSA: "
    "Em cumprimentos simples, perguntas sobre como você está "
    "ou conversas casuais, seja breve e natural. "

    "Quando o usuário tiver uma dúvida técnica ou sobre jogos, "
    "se houver contexto suficiente, seja detalhada, prática "
    "e útil. "

    "Não invente fatos apresentados como certeza. "
    "Quando não souber algo, deixe isso claro. "

    "Use o histórico recente para manter continuidade. "
    "Use a memória semântica como referência, mas não trate "
    "memórias antigas como verdade absoluta se houver "
    "contradição com a conversa atual."
)


system_prompt = (
    os.getenv(
        "SYSTEM_PROMPT",
        ""
    ).strip()
    or DEFAULT_SYSTEM_PROMPT
)


def montar_config_prompt():
    """
    Converte a configuração enviada pelo frontend
    em instruções para o modelo.
    """

    if not isinstance(config_usuario, dict):
        return ""

    linhas = []

    personalidade = config_usuario.get("personalidade")
    foco = config_usuario.get("foco")
    plataforma = config_usuario.get("plataforma")
    voz = config_usuario.get("voz")

    tamanho = config_usuario.get("tamanho")
    emojis = config_usuario.get("emojis")

    instrucoes = config_usuario.get("instrucoes")
    sobre_voce = config_usuario.get("sobreVoce")

    if isinstance(personalidade, list) and personalidade:
        linhas.append(
            "Estilo de personalidade: "
            + ", ".join(map(str, personalidade))
            + "."
        )

    if isinstance(foco, list) and foco:
        linhas.append(
            "Foco principal: "
            + ", ".join(map(str, foco))
            + "."
        )

    if isinstance(plataforma, list) and plataforma:
        linhas.append(
            "Plataforma do usuário: "
            + ", ".join(map(str, plataforma))
            + "."
        )

    if isinstance(voz, list) and voz:
        linhas.append(
            "Estilo de escrita: "
            + ", ".join(map(str, voz))
            + "."
        )

    if tamanho:
        linhas.append(
            f"Tamanho preferido das respostas: {tamanho}."
        )

    if emojis:
        linhas.append(
            f"Uso de emojis: {emojis}."
        )

    if instrucoes:
        linhas.append(
            "Instruções específicas do usuário: "
            + str(instrucoes)
        )

    if sobre_voce:
        linhas.append(
            "Informações fornecidas pelo usuário sobre si: "
            + str(sobre_voce)
        )

    comportamentos = []

    if config_usuario.get("perguntas") is False:
        comportamentos.append(
            "Não termine respostas com uma pergunta."
        )

    if config_usuario.get("humor") is False:
        comportamentos.append(
            "Não adapte o tom com base no humor detectado."
        )

    if config_usuario.get("criatividade") is False:
        comportamentos.append(
            "Não invente informações quando não souber."
        )

    if config_usuario.get("contexto") is False:
        comportamentos.append(
            "Não dependa de mensagens anteriores."
        )

    if comportamentos:
        linhas.extend(comportamentos)

    if not linhas:
        return ""

    return (
        "\n\n"
        "=== CONFIGURAÇÕES DO USUÁRIO ===\n"
        + "\n".join(linhas)
        + "\n"
        "=== FIM DAS CONFIGURAÇÕES ==="
    )


# ================================================================
# HUMOR
# ================================================================

def detectar_humor(texto):
    """
    Detecta apenas sinais simples de tom.
    Não é uma análise psicológica.
    """

    texto = str(texto or "")

    letras = len(
        re.findall(
            r"[A-Za-zÀ-ÿ]",
            texto
        )
    )

    caps = len(
        re.findall(
            r"[A-ZÁÀÃÂÉÊÍÓÔÕÚÇ]",
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
    humor = detectar_humor(texto)

    if config_usuario.get("humor") is False:
        return ""

    return {
        "raiva": (
            "\n\n[TOM]: "
            "O usuário parece irritado. "
            "Responda com calma, empatia e objetividade."
        ),

        "estressado": (
            "\n\n[TOM]: "
            "O usuário parece estressado. "
            "Seja leve, claro e tranquilizador."
        ),

        "normal": ""
    }.get(
        humor,
        ""
    )


# ================================================================
# HISTÓRICO
# ================================================================

def formatar_historico():
    """
    Converte o histórico recebido pelo frontend em texto.
    """

    if not isinstance(historico, list):
        return ""

    if not historico:
        return ""

    linhas = []

    # Somente uma quantidade razoável de mensagens recentes.
    recentes = historico[-12:]

    for item in recentes:
        if not isinstance(item, dict):
            continue

        papel = (
            item.get("role")
            or item.get("papel")
            or item.get("autor")
            or ""
        )

        texto = (
            item.get("content")
            or item.get("texto")
            or item.get("mensagem")
            or ""
        )

        if not texto:
            continue

        texto = str(texto).strip()

        if not texto:
            continue

        if papel in ("assistant", "ia", "iana"):
            nome = "Iana"
        elif papel in ("user", "usuario", "usuário"):
            nome = f"Usuário ({nome_usuario})"
        else:
            nome = str(papel or "Mensagem")

        linhas.append(
            f"{nome}: {texto[:3000]}"
        )

    if not linhas:
        return ""

    return (
        "=== HISTÓRICO RECENTE ===\n"
        + "\n".join(linhas)
        + "\n=== FIM DO HISTÓRICO ==="
    )


# ================================================================
# GEMINI
# ================================================================

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


def construir_prompt_gemini():
    """
    Monta o contexto final enviado ao Gemini.
    """

    partes = []

    if bloco_contexto:
        partes.append(
            bloco_contexto
        )

    historico_texto = formatar_historico()

    if historico_texto:
        partes.append(
            historico_texto
        )

    partes.append(
        f"=== MENSAGEM ATUAL ===\n"
        f"Usuário ({nome_usuario}): "
        f"{msg_final}\n"
        f"=== FIM DA MENSAGEM ATUAL ==="
    )

    partes.append(
        "Responda diretamente ao usuário como Iana. "
        "Não mencione que recebeu um prompt interno, "
        "memória, contexto ou instruções de sistema."
    )

    return "\n\n".join(partes)


def chamar_gemini():
    """
    Envia a mensagem para Gemini.
    """

    local_only = (
        os.getenv(
            "IANA_LOCAL_ONLY",
            "false"
        ).lower()
        == "true"
    )

    if local_only:
        sys.stderr.write(
            "[Gemini] modo local ativo\n"
        )
        return None

    if not chave:
        sys.stderr.write(
            "[Gemini] GEMINI_API_KEY não configurada\n"
        )
        return None

    prompt_completo = construir_prompt_gemini()

    sys.stderr.write(
        "[Gemini] Enviando contexto — "
        f"{len(prompt_completo)} chars\n"
    )

    payload = {
        "system_instruction": {
            "parts": [
                {
                    "text": (
                        system_prompt
                        + montar_config_prompt()
                        + instrucao_humor
                    )
                }
            ]
        },

        "contents": [
            {
                "role": "user",
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

    try:
        response = requests.post(
            url_api,
            json=payload,
            headers={
                "x-goog-api-key": chave,
                "Content-Type": "application/json"
            },
            timeout=45
        )

        if not response.ok:
            detalhe = response.text[:1000]

            sys.stderr.write(
                f"[Gemini] HTTP "
                f"{response.status_code}: "
                f"{detalhe}\n"
            )

            return None

        dados = response.json()

        candidatos = dados.get(
            "candidates",
            []
        )

        if not candidatos:
            sys.stderr.write(
                "[Gemini] nenhum candidato retornado\n"
            )
            return None

        candidato = candidatos[0]

        content = candidato.get(
            "content",
            {}
        )

        parts = content.get(
            "parts",
            []
        )

        textos = []

        for part in parts:
            if isinstance(part, dict):
                texto = part.get("text")

                if texto:
                    textos.append(
                        str(texto)
                    )

        resultado = "\n".join(
            textos
        ).strip()

        if not resultado:
            sys.stderr.write(
                "[Gemini] resposta vazia\n"
            )
            return None

        return resultado

    except requests.exceptions.Timeout:
        sys.stderr.write(
            "[Gemini] timeout\n"
        )

    except requests.exceptions.RequestException as e:
        sys.stderr.write(
            f"[Gemini] erro HTTP: {e}\n"
        )

    except Exception as e:
        sys.stderr.write(
            f"[Gemini] erro: {e}\n"
        )

    return None


# ================================================================
# FALLBACKS
# ================================================================

def resposta_do_contexto():
    """
    Fallback caso Gemini esteja indisponível.
    """

    if not contexto:
        return None

    trecho = contexto[:1200]

    return (
        "Encontrei algo relevante na minha memória. 🧠\n\n"
        f"{trecho}\n\n"
        "A conexão com minha IA está temporariamente "
        "indisponível, então não consegui elaborar "
        "uma resposta completa agora."
    )


def resposta_criativa_sem_api():
    """
    Fallback completamente local.
    """

    msg = msg_final.lower()

    if any(
        palavra in msg
        for palavra in (
            "platina",
            "troféu",
            "trofeu",
            "conquista",
            "achievement"
        )
    ):
        return (
            "🏆 Platinas são minha especialidade! "
            "Minha conexão com a IA está instável agora, "
            "mas posso continuar assim que ela voltar."
        )

    if any(
        palavra in msg
        for palavra in (
            "build",
            "arma",
            "equipamento",
            "skill"
        )
    ):
        return (
            "⚔️ Adoro falar de builds! "
            "Estou com uma instabilidade momentânea "
            "na IA, então não consegui montar a resposta "
            "completa agora."
        )

    if any(
        palavra in msg
        for palavra in (
            "oi",
            "olá",
            "ola",
            "hey",
            "eae",
            "salve"
        )
    ):
        return (
            f"Oi, {nome_usuario}! 👾 "
            "Que bom te ver!"
        )

    return (
        f"Ei, {nome_usuario}! 😊 "
        "Estou com uma instabilidade momentânea "
        "na minha conexão com a IA. "
        "Tenta novamente em instantes. 🔄"
    )


# ================================================================
# PIPELINE PRINCIPAL
# ================================================================

def run_pipeline():
    global contexto
    global bloco_contexto
    global instrucao_humor

    inicializar_chromadb()
    inicializar_gemini()

    # ------------------------------------------------------------
    # Memória semântica
    # ------------------------------------------------------------

    contexto = consultar_memoria(
        msg_final,
        id_conversa
    )

    bloco_contexto = ""

    if contexto:
        bloco_contexto = (
            "=== MEMÓRIA SEMÂNTICA DA IANA ===\n"
            "Use essas informações como contexto útil. "
            "Não trate memórias antigas como fatos absolutos "
            "se a conversa atual contradizê-las.\n\n"
            f"{contexto}\n\n"
            "=== FIM DA MEMÓRIA SEMÂNTICA ==="
        )

        sys.stderr.write(
            f"[Contexto] {len(contexto)} chars\n"
        )
    else:
        sys.stderr.write(
            "[Contexto] nenhuma memória relevante\n"
        )

    # ------------------------------------------------------------
    # Humor
    # ------------------------------------------------------------

    instrucao_humor = obter_instrucao_humor(
        msg_final
    )

    # ------------------------------------------------------------
    # Gemini PRIMEIRO
    # ------------------------------------------------------------

    resposta_final = chamar_gemini()

    # ------------------------------------------------------------
    # Fallback
    # ------------------------------------------------------------

    if not resposta_final:
        resposta_final = resposta_do_contexto()

    if not resposta_final:
        resposta_final = resposta_criativa_sem_api()

    # ------------------------------------------------------------
    # Salva memória
    # ------------------------------------------------------------

    salvar_na_memoria(
        msg_final,
        resposta_final,
        id_conversa
    )

    return resposta_final


# ================================================================
# ARGUMENTOS
# ================================================================

def carregar_argumentos():
    global nome_usuario
    global id_conversa
    global msg_final
    global historico
    global config_usuario

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

    msg_final = (
        sys.argv[3].strip()
        if len(sys.argv) > 3
        else ""
    )

    # ------------------------------------------------------------
    # Histórico
    # ------------------------------------------------------------

    if len(sys.argv) > 4:
        historico_json = sys.argv[4].strip()

        if historico_json:
            try:
                valor = json.loads(
                    historico_json
                )

                if isinstance(valor, list):
                    historico = valor

            except Exception as e:
                historico = []

                sys.stderr.write(
                    f"[Histórico] JSON inválido: {e}\n"
                )

    # ------------------------------------------------------------
    # Configuração do usuário
    # ------------------------------------------------------------

    if len(sys.argv) > 5:
        config_json = sys.argv[5].strip()

        if config_json:
            try:
                valor = json.loads(
                    config_json
                )

                if isinstance(valor, dict):
                    config_usuario = valor

            except Exception as e:
                config_usuario = {}

                sys.stderr.write(
                    f"[Config] JSON inválido: {e}\n"
                )


# ================================================================
# MAIN
# ================================================================

def main():
    carregar_argumentos()

    if not msg_final:
        print(
            "Não recebi nenhuma mensagem.",
            flush=True
        )
        return

    try:
        resultado = run_pipeline()

        print(
            resultado or resposta_criativa_sem_api(),
            flush=True
        )

    except KeyboardInterrupt:
        sys.stderr.write(
            "[Iana] interrompida\n"
        )

        print(
            "A resposta foi interrompida.",
            flush=True
        )

    except Exception as e:
        sys.stderr.write(
            f"[Iana] erro fatal: {e}\n"
        )

        print(
            resposta_criativa_sem_api(),
            flush=True
        )


if __name__ == "__main__":
    main()