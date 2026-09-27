#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
===================================================================
SERVER_IANA_V2.PY — API RESTful Profissional para Iana AI (v1.0.0)
===================================================================

Recursos da Versão 1:
- Arquitetura RESTful com Versionamento no Path (/api/v1/);
- Autenticação Dupla (Header 'X-API-Key' ou 'Authorization: Bearer');
- Endpoints de Chat, Histórico, Modelos e Monitoramento (/health);
- Tratamento Padronizado de Erros e Códigos HTTP Oficiais;
- Conexão Dinâmica com o Cérebro RAG (iana_v2.py) e Fallback Seguro;
- Configuração Segura via Variáveis de Ambiente (.env);
- Logging Estruturado para Produção.
===================================================================
"""

import os
import sys
import time
import json
import logging
from typing import Dict, List, Any, Optional, Tuple
from pathlib import Path

from flask import Flask, request, jsonify, Response
from dotenv import load_dotenv

# Carrega variáveis de ambiente do arquivo .env
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(dotenv_path=BASE_DIR / ".env")

# Configuração de Logging Profissional
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(name)s]: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("IanaAPI")

# Tenta integrar o pipeline da Iana (iana_v2.py)
RUN_PIPELINE_OK = False
try:
    import iana_v2
    RUN_PIPELINE_OK = True
    logger.info("Pipeline 'iana_v2' carregado com sucesso.")
except ImportError:
    logger.warning("Módulo 'iana_v2.py' não encontrado. Operando em modo Standalone/Fallback.")
except Exception as e:
    logger.error(f"Erro ao inicializar 'iana_v2.py': {e}")

# Inicialização do App Flask
app = Flask(__name__)

# Configurações Globais
API_VERSION = "1.0.0"

IANA_API_KEY = os.getenv("IANA_API_KEY", "iana-v1-secret").strip()

if not IANA_API_KEY: logger.error("❌ IANA\_API\_KEY não definida no .env — a API não pode iniciar sem ela.")
sys.exit(1)

# System Prompt Base
SYSTEM_PROMPT_GAMER = """
<identidade>
Você é a Iana, uma assistente de IA com personalidade própria, apaixonada por videogames, cultura pop, troféus e platinas.
Sua comunicação é espontânea, fluida, humana e autêntica — como uma parceira de jogos em uma chamada do Discord.
</identidade>

<personalidade>
- Tom de voz: Animada, descontraída, inteligente, curiosa e parceira.
- Estilo de fala: Use gírias gamer brasileiras ("build", "platina", "buffar", "nerfar", "GG", "boss") e emojis de forma orgânica.
- Flexibilidade: Varie a extensão das respostas conforme a necessidade do contexto.
</personalidade>

<regras_de_conhecimento_rag>
1. Use estritamente as informações do contexto de conhecimento retornado sobre jogos e builds.
2. PROIBIDO ALUCINAR: Não invente nem extrapole fatos não presentes na base de conhecimento.
3. Se a informação for insuficiente, diga naturalmente que ainda não encontrou esse dado.
</regras_de_conhecimento_rag>
""".strip()

# Armazenamento de Sessões em Memória (Estrutura Thread-Safe em Memória)
sessoes_memoria: Dict[str, List[Dict[str, str]]] = {}


# ================================================================
# MIDDLEWARE DE AUTENTICAÇÃO E UTILITÁRIOS
# ================================================================

def verificar_autenticacao() -> Tuple[bool, Optional[Response]]:
    """
    Valida a chave de API nos headers:
    Aceita 'X-API-Key: <chave>' ou 'Authorization: Bearer <chave>'.
    """
    api_key = request.headers.get("X-API-Key")
    if not api_key:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            api_key = auth_header[7:].strip()

    if not api_key or api_key != IANA_API_KEY:
        logger.warning(f"Tentativa de acesso não autorizada de {request.remote_addr}")
        resposta_erro = jsonify({
            "status": "erro",
            "codigo": 401,
            "erro": "Unauthorized",
            "mensagem": "Acesso não autorizado! API Key ausente ou inválida."
        })
        return False, (resposta_erro, 401)

    return True, None


@app.after_request
def adicionar_headers_cors(response):
    """Garante suporte a requisições Cross-Origin (CORS) e JSON utf-8."""
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-API-Key"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return response


# ================================================================
# ENDPOINTS DA API RESTFUL (VERSÃO 1)
# ================================================================

@app.route('/health', methods=['GET'])
def health_check():
    """
    GET /health
    Verifica a saúde da API, status do pipeline e uso de memória.
    """
    return jsonify({
        "status": "online",
        "servico": "Iana AI REST API",
        "versao": API_VERSION,
        "pipeline_rag_ativo": RUN_PIPELINE_OK,
        "sessoes_ativas": len(sessoes_memoria),
        "timestamp": int(time.time())
    }), 200


@app.route('/api/v1/models', methods=['GET'])
def listar_modelos():
    """
    GET /api/v1/models
    Lista os modelos suportados (formato compatível com OpenAI/Claude).
    """
    autenticado, erro_resp = verificar_autenticacao()
    if not autenticado and erro_resp:
        return erro_resp

    return jsonify({
        "object": "list",
        "data": [
            {
                "id": "iana-v1",
                "object": "model",
                "created": 1700000000,
                "owned_by": "iana-ai",
                "description": "Modelo Iana v1 com RAG de jogos e personalização gamer."
            }
        ]
    }), 200


@app.route('/api/v1/chat', methods=['POST'])
def chat_iana():
    """
    POST /api/v1/chat
    Endpoint principal para conversar com a Iana.
    Payload JSON esperado:
    {
        "mensagem": "Como venço o Malenia em Elden Ring?",
        "sessao_id": "sessao_123",  (Opcional)
        "nome_usuario": "Jogador"    (Opcional)
    }
    """
    autenticado, erro_resp = verificar_autenticacao()
    if not autenticado and erro_resp:
        return erro_resp

    dados = request.get_json(silent=True) or {}
    mensagem_usuario = str(dados.get("mensagem", "")).strip()
    sessao_id = str(dados.get("sessao_id", "jogador_default")).strip()
    nome_usuario = str(dados.get("nome_usuario", "Jogador")).strip()

    if not mensagem_usuario:
        return jsonify({
            "status": "erro",
            "codigo": 400,
            "erro": "Bad Request",
            "mensagem": "O campo 'mensagem' é obrigatório e não pode estar vazio."
        }), 400

    # Inicializa o histórico da sessão se for nova
    if sessao_id not in sessoes_memoria:
        sessoes_memoria[sessao_id] = [
            {"role": "system", "content": SYSTEM_PROMPT_GAMER}
        ]

    # Registra a mensagem do usuário na sessão
    sessoes_memoria[sessao_id].append({"role": "user", "content": mensagem_usuario})

    # Processa a resposta via pipeline RAG ou Fallback
    resposta_final = None

    if RUN_PIPELINE_OK:
        try:
            # Injeta o contexto no pipeline
            iana_v2.msg_final = mensagem_usuario
            iana_v2.nome_usuario = nome_usuario
            iana_v2.historico = sessoes_memoria[sessao_id][-10:]
            resposta_final = iana_v2.run_pipeline()
        except Exception as e:
            logger.error(f"Erro na execução do pipeline RAG para sessão '{sessao_id}': {e}")

    # Fallback seguro caso o pipeline não retorne resposta
    if not resposta_final:
        resposta_final = (
            f"E aí, {nome_usuario}! 🎮 Recebi sua mensagem: '{mensagem_usuario}'. "
            f"Estou pronta para te ajudar a detonar nesse jogo e buscar essa platina! "
            f"Qual é o chefão ou desafio que estamos enfrentando hoje?"
        )

    # Registra a resposta da Iana no histórico da sessão
    sessoes_memoria[sessao_id].append({"role": "assistant", "content": resposta_final})

    return jsonify({
        "status": "sucesso",
        "versao_api": API_VERSION,
        "sessao_id": sessao_id,
        "resposta": resposta_final,
        "historico_count": len(sessoes_memoria[sessao_id]) - 1,
        "timestamp": int(time.time())
    }), 200


@app.route('/api/v1/chat/historico/<sessao_id>', methods=['GET'])
def obter_historico(sessao_id: str):
    """
    GET /api/v1/chat/historico/<sessao_id>
    Retorna o histórico recente de conversação de uma sessão específica.
    """
    autenticado, erro_resp = verificar_autenticacao()
    if not autenticado and erro_resp:
        return erro_resp

    if sessao_id not in sessoes_memoria:
        return jsonify({
            "status": "erro",
            "codigo": 404,
            "erro": "Not Found",
            "mensagem": f"Sessão '{sessao_id}' não encontrada."
        }), 404

    # Filtra as mensagens (descontando o system prompt interno)
    mensagens = [m for m in sessoes_memoria[sessao_id] if m.get("role") != "system"]

    return jsonify({
        "status": "sucesso",
        "sessao_id": sessao_id,
        "mensagens": mensagens,
        "total": len(mensagens)
    }), 200


@app.route('/api/v1/chat/historico/<sessao_id>', methods=['DELETE'])
def limpar_historico(sessao_id: str):
    """
    DELETE /api/v1/chat/historico/<sessao_id>
    Limpa e reseta o histórico de conversação de uma sessão.
    """
    autenticado, erro_resp = verificar_autenticacao()
    if not autenticado and erro_resp:
        return erro_resp

    if sessao_id in sessoes_memoria:
        del sessoes_memoria[sessao_id]
        logger.info(f"Sessão '{sessao_id}' resetada com sucesso.")

    return jsonify({
        "status": "sucesso",
        "sessao_id": sessao_id,
        "mensagem": f"Histórico da sessão '{sessao_id}' limpo com sucesso."
    }), 200


# ================================================================
# EXECUÇÃO DO SERVIDOR
# ================================================================

if __name__ == '__main__':
    porta = int(os.getenv("PORT", "5000"))
    logger.info(f"🚀 Iniciando Iana API Server v{API_VERSION} na porta {porta}...")
    app.run(host='0.0.0.0', port=porta, debug=True)
