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
import importlib
import hmac
import logging
import threading
from typing import Dict, List, Any, Optional, Tuple
from pathlib import Path

from flask import Flask, request, jsonify, Response
from dotenv import load_dotenv
from werkzeug.exceptions import RequestEntityTooLarge

# Carrega variáveis de ambiente do arquivo .env
BASE_DIR = Path(__file__).resolve().parent
_env_local = BASE_DIR / ".env"
_env_root = BASE_DIR.parent / ".env"
if _env_local.exists():
    load_dotenv(dotenv_path=_env_local)
else:
    load_dotenv(dotenv_path=_env_root)

# Configuração de Logging Profissional
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(name)s]: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("IanaAPI")

# Tenta integrar o pipeline da Iana (iana_v2.py)
RUN_PIPELINE_OK = False
sys.path.insert(0, str(BASE_DIR))
try:
    import iana_v2
    RUN_PIPELINE_OK = True
    logger.info("Pipeline 'iana_v2' carregado com sucesso.")
except ImportError:
    logger.warning("Módulo 'iana_v2.py' não encontrado. Operando em modo Standalone/Fallback.")
except Exception as e:
    logger.error(f"Erro ao inicializar 'iana_v2.py': {e}")

try:
    from core import vision_worker
except Exception:
    try:
        import vision_worker
    except Exception:
        vision_worker = None

# Inicialização do App Flask
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024

# Configurações Globais
API_VERSION = "1.0.0"


def resolve_api_key() -> str:
    """Resolve a chave de autenticação da API priorizando configuração explícita e fallback seguro para desenvolvimento."""
    explicit_key = os.getenv("IANA_API_KEY", "").strip()
    if explicit_key:
        return explicit_key

    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
    if gemini_key:
        logger.warning("IANA_API_KEY ausente; usando GEMINI_API_KEY como fallback para desenvolvimento local.")
        return gemini_key

    fallback_key = "dev-iana-local-key"
    logger.warning("IANA_API_KEY ausente; usando chave local de desenvolvimento. Configure IANA_API_KEY em produção.")
    return fallback_key


IANA_API_KEY = resolve_api_key()

# Armazenamento em memória protegido contra acesso concorrente.
sessoes_memoria: Dict[str, List[Dict[str, str]]] = {}
sessoes_lock = threading.RLock()
pipeline_lock = threading.Lock()
MAX_MESSAGE_LENGTH = 20_000
MAX_SESSION_ID_LENGTH = 128
MAX_NAME_LENGTH = 80
MAX_HISTORY_MESSAGES = 100


def normalizar_config_usuario(config: Any) -> Dict[str, Any]:
    """Valida e limita as preferências enviadas pela interface."""
    if config is None:
        return {}
    if not isinstance(config, dict):
        raise ValueError("config_usuario deve ser um objeto.")

    normalizada: Dict[str, Any] = {}
    campos_lista = {
        "personalidade": (10, 40),
        "foco": (10, 40),
        "plataforma": (10, 40),
        "voz": (10, 40),
    }
    for campo, (max_itens, max_tamanho) in campos_lista.items():
        valor = config.get(campo)
        if valor is None:
            continue
        if not isinstance(valor, list) or len(valor) > max_itens:
            raise ValueError(f"config_usuario.{campo} deve ser uma lista válida.")
        itens = []
        for item in valor:
            if not isinstance(item, str) or len(item.strip()) > max_tamanho:
                raise ValueError(f"config_usuario.{campo} contém um item inválido.")
            item = item.strip()
            if item:
                itens.append(item)
        normalizada[campo] = itens

    campos_texto = {
        "tamanho": 30,
        "emojis": 30,
        "instrucoes": 800,
        "sobreVoce": 400,
    }
    for campo, max_tamanho in campos_texto.items():
        valor = config.get(campo)
        if valor is None:
            continue
        if not isinstance(valor, str) or len(valor.strip()) > max_tamanho:
            raise ValueError(f"config_usuario.{campo} deve ser um texto de até {max_tamanho} caracteres.")
        normalizada[campo] = valor.strip()

    for campo in ("perguntas", "humor", "criatividade", "contexto"):
        valor = config.get(campo)
        if valor is None:
            continue
        if not isinstance(valor, bool):
            raise ValueError(f"config_usuario.{campo} deve ser verdadeiro ou falso.")
        normalizada[campo] = valor

    return normalizada


def limitar_historico(sessao: List[Dict[str, str]]) -> None:
    if len(sessao) > MAX_HISTORY_MESSAGES:
        sessao[:] = sessao[-MAX_HISTORY_MESSAGES:]


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

    if not api_key or not hmac.compare_digest(api_key, IANA_API_KEY):
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
    response.headers["Access-Control-Allow-Origin"] = os.getenv("IANA_ALLOWED_ORIGIN", "*")
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-API-Key"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return response


@app.errorhandler(RequestEntityTooLarge)
def payload_muito_grande(_erro):
    return jsonify({
        "status": "erro",
        "codigo": 413,
        "erro": "Payload Too Large",
        "mensagem": "O corpo da requisição excede o limite permitido."
    }), 413


# ================================================================
# ENDPOINTS DA API RESTFUL (VERSÃO 1)
# ================================================================

@app.route('/health', methods=['GET'])
def health_check():
    """
    GET /health
    Verifica a saúde da API, status do pipeline e uso de memória.
    """
    with sessoes_lock:
        sessoes_ativas = len(sessoes_memoria)

    return jsonify({
        "status": "online",
        "servico": "Iana AI REST API",
        "versao": API_VERSION,
        "pipeline_rag_ativo": RUN_PIPELINE_OK,
        "sessoes_ativas": sessoes_ativas,
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

    dados = request.get_json(silent=True)
    if not isinstance(dados, dict):
        return jsonify({
            "status": "erro",
            "codigo": 400,
            "erro": "Bad Request",
            "mensagem": "O corpo da requisição deve ser um objeto JSON válido."
        }), 400

    try:
        config_usuario = normalizar_config_usuario(dados.get("config_usuario"))
    except ValueError as erro:
        return jsonify({
            "status": "erro",
            "codigo": 400,
            "erro": "Bad Request",
            "mensagem": str(erro)
        }), 400

    mensagem_usuario = dados.get("mensagem", "")
    sessao_id = dados.get("sessao_id", "jogador_default")
    nome_usuario = dados.get("nome_usuario", "Jogador")
    if not isinstance(mensagem_usuario, str) or not isinstance(sessao_id, str) or not isinstance(nome_usuario, str):
        return jsonify({
            "status": "erro",
            "codigo": 400,
            "erro": "Bad Request",
            "mensagem": "mensagem, sessao_id e nome_usuario devem ser textos."
        }), 400

    mensagem_usuario = mensagem_usuario.strip()
    sessao_id = sessao_id.strip()
    nome_usuario = nome_usuario.strip() or "Jogador"

    if not mensagem_usuario:
        return jsonify({
            "status": "erro",
            "codigo": 400,
            "erro": "Bad Request",
            "mensagem": "O campo 'mensagem' é obrigatório e não pode estar vazio."
        }), 400

    if len(mensagem_usuario) > MAX_MESSAGE_LENGTH or len(sessao_id) > MAX_SESSION_ID_LENGTH or len(nome_usuario) > MAX_NAME_LENGTH:
        return jsonify({
            "status": "erro",
            "codigo": 413,
            "erro": "Payload Too Large",
            "mensagem": "Mensagem, identificador de sessão ou nome excede o limite permitido."
        }), 413

    if not sessao_id:
        return jsonify({
            "status": "erro",
            "codigo": 400,
            "erro": "Bad Request",
            "mensagem": "O campo 'sessao_id' não pode estar vazio."
        }), 400

    # Inicializa o histórico da sessão se for nova
    with sessoes_lock:
        sessoes_memoria.setdefault(sessao_id, [])
        sessoes_memoria[sessao_id].append({"role": "user", "content": mensagem_usuario})
        limitar_historico(sessoes_memoria[sessao_id])
        historico_sessao = list(sessoes_memoria[sessao_id][:-1][-10:])

    # Processa a resposta via pipeline RAG ou Fallback
    resposta_final = None

    if RUN_PIPELINE_OK:
        try:
            with pipeline_lock:
                iana_v2.msg_final = mensagem_usuario
                iana_v2.nome_usuario = nome_usuario
                iana_v2.historico = historico_sessao
                iana_v2.config_usuario = config_usuario
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
    with sessoes_lock:
        sessoes_memoria[sessao_id].append({"role": "assistant", "content": str(resposta_final)})
        limitar_historico(sessoes_memoria[sessao_id])
        historico_count = len(sessoes_memoria[sessao_id]) - 1

    return jsonify({
        "status": "sucesso",
        "versao_api": API_VERSION,
        "sessao_id": sessao_id,
        "resposta": resposta_final,
        "historico_count": historico_count,
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

    with sessoes_lock:
        sessao = sessoes_memoria.get(sessao_id)
        mensagens = [dict(m) for m in sessao if m.get("role") != "system"] if sessao else None

    if mensagens is None:
        return jsonify({
            "status": "erro",
            "codigo": 404,
            "erro": "Not Found",
            "mensagem": f"Sessão '{sessao_id}' não encontrada."
        }), 404

    # Filtra as mensagens (descontando o system prompt interno)
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

    with sessoes_lock:
        sessoes_memoria.pop(sessao_id, None)
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
    debug = os.getenv("FLASK_DEBUG", "false").lower() == "true"
    logger.info(f"Iniciando Iana API Server v{API_VERSION} na porta {porta}...")
    if debug:
        app.run(host="0.0.0.0", port=porta, debug=True)
    else:
        try:
            waitress = importlib.import_module("waitress")
        except ImportError as erro:
            if os.getenv("NODE_ENV", "").lower() == "production":
                raise RuntimeError("Waitress é obrigatório em produção.") from erro
            logger.warning("Waitress não instalado; usando servidor Flask de desenvolvimento.")
            app.run(host="0.0.0.0", port=porta, debug=False)
        else:
            waitress.serve(app, host="0.0.0.0", port=porta)
