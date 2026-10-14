"""Aprendizados declarados pelo usuário, na mesma memória das fontes extraídas.

Não usa um modelo para extrair fatos nem grava respostas da Iana. O texto é
conservado como relato do autor, com escopo privado e origem na conversa.
"""
from __future__ import annotations

import hashlib
import re
import threading
import unicodedata
from datetime import datetime, timezone
from typing import Any, Iterable

try:
    from core import learning_engine
except ModuleNotFoundError as problem:
    if problem.name != "core":
        raise
    import learning_engine


_lock = threading.RLock()
_GREETING = re.compile(
    r"^(?:(?:oi|ola|bom dia|boa tarde|boa noite|obrigad[oa]|valeu|ok|okay|"
    r"certo|entendi|sim|continue|continua|tudo bem|tudo certo)(?:\s+iana)?[\s!,.;?]*)+$"
)
_QUESTION = re.compile(
    r"^(?:qual|quais|como|onde|quando|por que|porque|quem|quanto|quantos|"
    r"o que|oq|que|voce (?:pode|sabe|consegue|acha|pensa|conhece)|"
    r"eu (?:posso|devo|consigo|poderia)|pode(?:ria)?|consegue|sera que)\b"
)
_REQUEST = re.compile(
    r"^(?:crie|cria|criar|faca|faz|fazer|desenvolva|desenvolver|mostre|mostra|"
    r"explique|explica|pesquise|busque|procure|gere|gera|continue|continua|"
    r"me (?:ajude|mostre|explique|diga|fale))\b"
)
_TEACHING = re.compile(
    r"\b(?:eu|meu|minha|meus|minhas|prefiro|preferencia|gosto|costumo|sempre uso|"
    r"na verdade|corrija|corrigir|correcao|lembre|lembra|aprenda|anote|guarde|"
    r"minha ideia|minha proposta|proponho|imagino|poderiamos)\b"
)
_CONTEXTUAL = re.compile(
    r"^(?:na verdade|corrija|corrigindo|correcao|lembre|lembra|aprenda|anote|"
    r"guarde|nao[, ]+(?:isso|ela|ele|a |o |e )|isso|ela|ele)\b"
)
_SECRET = re.compile(
    r"(?:-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|"
    r"\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|"
    r"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b|"
    r"\b(?:[a-z][a-z0-9_]*_)?(?:senha|password|passwd|api[_ -]?key|access[_ -]?token|"
    r"chave(?:\s+(?:da|de))?\s+api|token)\s*[\"']?\s*(?:=|:|\be\b|\bis\b)\s*\S+|"
    r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|https?://[^\s/:]+:[^\s/@]+@)", re.I
)
_PROVIDER_ERROR = re.compile(
    r"^(?:resourceexhausted|(?:error\s*)?429\b|quota exceeded|"
    r"you exceeded your current quota|erro (?:ao gerar|na api)|gemini request failed)", re.I
)


def _fold(value: str) -> str:
    return "".join(char for char in unicodedata.normalize("NFKD", value.casefold())
                   if not unicodedata.combining(char))


def _has_secret(value: str) -> bool:
    return bool(_SECRET.search(_fold(value)))


def _has_learning(message: str) -> bool:
    folded = _fold(message)
    if _GREETING.fullmatch(folded) or _PROVIDER_ERROR.match(folded):
        return False
    folded = re.sub(r"^(?:(?:oi|ola|bom dia|boa tarde|boa noite)[ ,!]+)?(?:iana[ ,:]+)?", "", folded)
    # Avalia frases separadamente: uma pergunta pode vir junto de um ensinamento.
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", folded):
        words = re.findall(r"\w+", sentence)
        if len(words) < 2:
            continue
        if _TEACHING.search(sentence):
            # "Como eu faço...?" ou "Crie meu site" são pedidos, não relatos.
            if not _QUESTION.match(sentence) and not _REQUEST.match(sentence) and "?" not in sentence:
                return True
            continue
        if len(words) >= 3 and not _QUESTION.match(sentence) and not _REQUEST.match(sentence) and "?" not in sentence:
            return True
    return False


def _previous_user_context(history: Iterable[dict[str, Any]] | None, message: str) -> str:
    """Somente a última fala anterior do usuário; nenhuma resposta gerada."""
    if not history:
        return ""
    for item in reversed(list(history)):
        if not isinstance(item, dict) or item.get("role") != "user":
            continue
        content = item.get("content", item.get("text", ""))
        if not isinstance(content, str):
            continue
        content = learning_engine.normalizar_texto(content)
        if not content or content == message or _has_secret(content):
            continue
        if _GREETING.fullmatch(_fold(content)) or _PROVIDER_ERROR.match(content):
            continue
        # Um trecho basta para identificar o assunto de correções como "é 3 segundos".
        return content[:800]
    return ""


def learn_from_message(message: str, user_id: Any, conversation_id: Any,
                       game: str | None = None,
                       history: Iterable[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Salva a fala do usuário sem depender da cota de uma API de geração.

    ``user_id`` deve ser o identificador estável da conta, também usado na busca.
    O chamador passa apenas a mensagem recebida do usuário. ``history`` é opcional
    e só fornece assunto anterior a uma correção, usando entradas ``role=user``.
    Repetições pertencentes ao mesmo usuário mantêm um documento; as conversas
    de origem ficam registradas em ``metadata.conversa_ids``.
    """
    skipped = {"status": "IGNORADO", "document_id": None}
    if not isinstance(message, str) or not message.strip():
        return {**skipped, "reason": "mensagem_vazia"}
    if user_id is None or not str(user_id).strip() or conversation_id is None or not str(conversation_id).strip():
        return {**skipped, "reason": "origem_ausente"}
    message = learning_engine.normalizar_texto(message)
    if _has_secret(message):
        return {**skipped, "reason": "credencial"}
    if not _has_learning(message):
        return {**skipped, "reason": "sem_aprendizado"}

    user_id, conversation_id = str(user_id).strip(), str(conversation_id).strip()
    context = _previous_user_context(history, message) if _CONTEXTUAL.match(_fold(message)) else ""
    content = (f"Contexto anterior do usuário:\n{context}\n\nMensagem do usuário:\n{message}"
               if context else message)
    canonical = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", content).casefold()).strip()
    document_id = "conversa_" + hashlib.sha256((user_id + "\x00" + canonical).encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc).isoformat()

    try:
        with _lock:
            previous = learning_engine.get_document(document_id, usuario_id=user_id)
            metadata = dict(previous["metadata"]) if previous else {}
            origins = list(metadata.get("conversa_ids", []))
            if conversation_id not in origins:
                origins.append(conversation_id)
            metadata.update({
                "tipo": "conversa", "usuario_id": user_id,
                "conversa_id": metadata.get("conversa_id", conversation_id), "conversa_ids": origins,
                "escopo": "usuario", "natureza": "relato_usuario", "extraido_em": now,
            })
            if game:
                metadata["jogo"] = str(game).strip()
            if context:
                metadata["tem_contexto_usuario"] = True
            title = previous["titulo"] if previous else "Aprendizado de conversa do usuário"
            # Conserva a primeira grafia da fala para duplicações com capitalização/espaços diferentes.
            stored_content = previous["conteudo"] if previous else content
            status = learning_engine.learn(title, stored_content, "conversa_usuario", document_id,
                                          metadata=metadata)
        return {"status": status, "document_id": document_id if status != "ERRO" else None}
    except Exception:
        return {"status": "ERRO", "document_id": None, "reason": "falha_memoria"}
