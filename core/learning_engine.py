# learning_engine.py
# ================================================================
# MOTOR DE APRENDIZADO DA IANA
#
# ChromaDB = memória semântica
# MySQL     = registro persistente dos documentos
#
# Fluxo:
#
# scraper.py
#     ↓
# learn()
#     ↓
# ChromaDB
#     ↓
# MySQL
#     ↓
# iana.py consulta por significado
# ================================================================

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


# ================================================================
# DEPENDÊNCIAS
# ================================================================

try:
    import chromadb
except Exception:
    chromadb = None


try:
    from sentence_transformers import SentenceTransformer
except Exception:
    SentenceTransformer = None


# ================================================================
# CONFIGURAÇÃO
# ================================================================

COLLECTION_NAME = "memoria_iana"

EMBEDDING_MODEL = os.getenv(
    "IANA_EMBEDDING_MODEL",
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
)

CHUNK_SIZE = int(
    os.getenv("IANA_CHUNK_SIZE", "3500")
)

CHUNK_OVERLAP = int(
    os.getenv("IANA_CHUNK_OVERLAP", "400")
)

SIMILARITY_LIMIT = float(
    os.getenv("IANA_SIMILARITY_LIMIT", "0.985")
)


# ================================================================
# CAMINHO DO BANCO
# ================================================================

def obter_pasta_banco() -> Path:

    override = os.getenv(
        "IANA_DB_PATH",
        ""
    ).strip()

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
                str(
                    Path.home()
                    / ".local"
                    / "share"
                )
            )
        )

    return (
        base
        / "iana_database"
        / "chromadb"
    )


path_banco = obter_pasta_banco()

path_banco.mkdir(
    parents=True,
    exist_ok=True
)


# ================================================================
# ESTADO
# ================================================================

cliente = None
colecao = None
modelo = None

memoria_inicializada = False
modo_fallback = False

arquivo_fallback = (
    path_banco
    / "memoria_fallback.json"
)


# ================================================================
# FALLBACK JSON
# ================================================================

def _carregar_fallback() -> List[Dict[str, Any]]:

    if not arquivo_fallback.exists():
        return []

    try:

        with arquivo_fallback.open(
            "r",
            encoding="utf-8"
        ) as fh:

            dados = json.load(fh)

        return (
            dados
            if isinstance(dados, list)
            else []
        )

    except Exception:

        return []


memoria_fallback = _carregar_fallback()


def _salvar_fallback(
    doc_id: str,
    titulo: str,
    conteudo: str,
    categoria: str,
    url: Optional[str],
    content_hash: str,
):

    global memoria_fallback

    memoria_fallback = [
        item
        for item in memoria_fallback
        if item.get("id") != doc_id
    ]

    memoria_fallback.append(
        {
            "id": doc_id,
            "titulo": titulo,
            "conteudo": conteudo,
            "categoria": categoria,
            "url": url or "",
            "content_hash": content_hash,
            "atualizado_em": int(time.time()),
        }
    )

    with arquivo_fallback.open(
        "w",
        encoding="utf-8"
    ) as fh:

        json.dump(
            memoria_fallback,
            fh,
            ensure_ascii=False,
            indent=2
        )


# ================================================================
# INICIALIZAÇÃO
# ================================================================

def _inicializar_memoria() -> bool:

    global cliente
    global colecao
    global modelo
    global memoria_inicializada
    global modo_fallback

    if memoria_inicializada:
        return not modo_fallback

    memoria_inicializada = True

    try:

        if chromadb is None:
            raise RuntimeError(
                "chromadb não está instalado"
            )

        if SentenceTransformer is None:
            raise RuntimeError(
                "sentence-transformers não está instalado"
            )

        cliente = chromadb.PersistentClient(
            path=str(path_banco)
        )

        colecao = cliente.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={
                "hnsw:space": "cosine"
            }
        )

        modelo = SentenceTransformer(
            EMBEDDING_MODEL
        )

        modo_fallback = False

        sys.stderr.write(
            "[learning_engine] "
            f"ChromaDB OK — "
            f"{colecao.count()} documentos\n"
        )

        return True

    except Exception as e:

        modo_fallback = True

        sys.stderr.write(
            "[learning_engine] "
            f"ChromaDB OFFLINE — {e}\n"
        )

        return False


# ================================================================
# NORMALIZAÇÃO
# ================================================================

def normalizar_texto(texto: str) -> str:

    texto = str(texto or "")

    texto = texto.replace(
        "\x00",
        ""
    )

    texto = texto.replace(
        "\r\n",
        "\n"
    )

    texto = texto.replace(
        "\r",
        "\n"
    )

    texto = re.sub(
        r"[ \t]+",
        " ",
        texto
    )

    texto = re.sub(
        r"\n{3,}",
        "\n\n",
        texto
    )

    return texto.strip()


def hash_texto(texto: str) -> str:

    texto = normalizar_texto(
        texto
    )

    return hashlib.sha256(
        texto.encode("utf-8")
    ).hexdigest()


def gerar_id_documento(texto: str) -> str:

    return (
        "doc_"
        + hashlib.sha256(
            texto.strip().lower().encode(
                "utf-8"
            )
        ).hexdigest()[:48]
    )


# ================================================================
# FRAGMENTAÇÃO
# ================================================================

def dividir_em_chunks(
    texto: str,
    tamanho: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> List[str]:

    texto = normalizar_texto(
        texto
    )

    if not texto:
        return []

    if len(texto) <= tamanho:
        return [texto]

    tamanho = max(
        500,
        int(tamanho)
    )

    overlap = max(
        0,
        min(
            int(overlap),
            tamanho // 2
        )
    )

    chunks = []

    inicio = 0

    while inicio < len(texto):

        fim = min(
            inicio + tamanho,
            len(texto)
        )

        trecho = texto[
            inicio:fim
        ].strip()

        if trecho:
            chunks.append(
                trecho
            )

        if fim >= len(texto):
            break

        novo_inicio = (
            fim - overlap
        )

        if novo_inicio <= inicio:
            novo_inicio = fim

        inicio = novo_inicio

    return chunks


# ================================================================
# MYSQL
# ================================================================

def _registrar_mysql(
    titulo: str,
    conteudo: str,
    categoria: str,
    doc_id: str,
    url: Optional[str],
    content_hash: str,
):

    try:

        from memory import (
            registrar_aprendizado_mysql,
            save_memory,
        )

        registrar_aprendizado_mysql(
            chave=doc_id,
            tipo=categoria,
            titulo=titulo,
            fonte_url=url,
            content_hash=content_hash
        )

        save_memory(
            texto=conteudo,
            categoria=categoria,
            fonte_url=url,
            doc_id=doc_id
        )

    except Exception as e:

        sys.stderr.write(
            "[learning_engine] "
            f"MySQL não atualizado: {e}\n"
        )


# ================================================================
# DOCUMENTO EXISTE
# ================================================================

def documento_existe(
    id_documento: str
) -> bool:

    if not id_documento:
        return False

    if not _inicializar_memoria():

        return any(
            item.get("id") == id_documento
            for item in _carregar_fallback()
        )

    try:

        resultado = colecao.get(
            ids=[id_documento]
        )

        return bool(
            resultado
            and resultado.get("ids")
        )

    except Exception:

        return False


# ================================================================
# BUSCA DE METADADOS DE DOCUMENTO
# ================================================================

def _obter_ids_documento(
    id_documento: str
) -> List[str]:

    if not _inicializar_memoria():
        return []

    try:

        resultado = colecao.get(
            where={
                "doc_id": id_documento
            }
        )

        return (
            resultado.get("ids", [])
            if resultado
            else []
        )

    except Exception:

        # Compatibilidade com documentos antigos
        try:

            if documento_existe(
                id_documento
            ):
                return [id_documento]

        except Exception:
            pass

        return []


# ================================================================
# REMOVER DOCUMENTO
# ================================================================

def remover_documento(
    id_documento: str
) -> bool:

    if not id_documento:
        return False

    if not _inicializar_memoria():

        global memoria_fallback

        memoria_fallback = [
            item
            for item in memoria_fallback
            if item.get("id") != id_documento
        ]

        with arquivo_fallback.open(
            "w",
            encoding="utf-8"
        ) as fh:

            json.dump(
                memoria_fallback,
                fh,
                ensure_ascii=False,
                indent=2
            )

        return True

    try:

        ids = _obter_ids_documento(
            id_documento
        )

        if ids:
            colecao.delete(
                ids=ids
            )

        # Documento antigo sem metadata doc_id
        try:

            colecao.delete(
                ids=[id_documento]
            )

        except Exception:
            pass

        return True

    except Exception as e:

        sys.stderr.write(
            "[learning_engine] "
            f"Erro removendo documento: {e}\n"
        )

        return False


# ================================================================
# DOCUMENTO PARECIDO
# ================================================================

def documento_parecido(
    vetor,
    limite: float = SIMILARITY_LIMIT,
) -> bool:

    if not _inicializar_memoria():
        return False

    try:

        resultado = colecao.query(
            query_embeddings=[vetor],
            n_results=1
        )

        distancias = resultado.get(
            "distances"
        )

        if not distancias:
            return False

        if not distancias[0]:
            return False

        distancia = float(
            distancias[0][0]
        )

        similaridade = 1.0 - distancia

        return (
            similaridade >= limite
        )

    except Exception:

        return False


# ================================================================
# LEARN — FUNÇÃO PRINCIPAL
# ================================================================

def learn(
    titulo: str,
    conteudo: str,
    categoria: str = "mining",
    id_documento: Optional[str] = None,
    url: Optional[str] = None,
) -> str:

    titulo = normalizar_texto(
        titulo
    )

    conteudo = normalizar_texto(
        conteudo
    )

    categoria = (
        normalizar_texto(
            categoria
        )
        or "geral"
    )

    url = (
        str(url).strip()
        if url
        else None
    )

    if not titulo:
        titulo = "Documento sem título"

    if not conteudo:
        return "ERRO"

    if not id_documento:

        base_id = (
            url
            or titulo
        )

        id_documento = gerar_id_documento(
            base_id
        )

    id_documento = str(
        id_documento
    ).strip()

    content_hash = hash_texto(
        conteudo
    )

    texto_base = (
        f"TÍTULO: {titulo}\n\n"
        f"CATEGORIA: {categoria}\n\n"
        f"FONTE: {url or 'Local'}\n\n"
        f"CONTEÚDO:\n{conteudo}"
    )

    try:

        # --------------------------------------------------------
        # FALLBACK
        # --------------------------------------------------------

        if not _inicializar_memoria():

            existente = next(
                (
                    item
                    for item in _carregar_fallback()
                    if item.get("id")
                    == id_documento
                ),
                None
            )

            if existente:

                if (
                    existente.get(
                        "content_hash"
                    )
                    == content_hash
                ):

                    return "EXISTE"

                _salvar_fallback(
                    id_documento,
                    titulo,
                    texto_base,
                    categoria,
                    url,
                    content_hash
                )

                _registrar_mysql(
                    titulo,
                    texto_base,
                    categoria,
                    id_documento,
                    url,
                    content_hash
                )

                return "ATUALIZADO"

            _salvar_fallback(
                id_documento,
                titulo,
                texto_base,
                categoria,
                url,
                content_hash
            )

            _registrar_mysql(
                titulo,
                texto_base,
                categoria,
                id_documento,
                url,
                content_hash
            )

            return "NOVO"

        # --------------------------------------------------------
        # VERIFICA DOCUMENTO EXISTENTE
        # --------------------------------------------------------

        ids_antigos = _obter_ids_documento(
            id_documento
        )

        if ids_antigos:

            metadatas = []

            try:

                existente = colecao.get(
                    ids=ids_antigos,
                    include=[
                        "metadatas"
                    ]
                )

                metadatas = (
                    existente.get(
                        "metadatas",
                        []
                    )
                    or []
                )

            except Exception:
                pass

            hashes_antigos = {
                str(meta.get("content_hash"))
                for meta in metadatas
                if isinstance(meta, dict)
                and meta.get("content_hash")
            }

            if content_hash in hashes_antigos:

                _registrar_mysql(
                    titulo,
                    texto_base,
                    categoria,
                    id_documento,
                    url,
                    content_hash
                )

                return "EXISTE"

            # Conteúdo mudou:
            # remove os chunks antigos.
            try:
                colecao.delete(
                    ids=ids_antigos
                )
            except Exception:
                pass

            status = "ATUALIZADO"

        else:

            status = "NOVO"

            # ----------------------------------------------------
            # CHECAGEM DE DUPLICAÇÃO SEMÂNTICA
            # ----------------------------------------------------

            try:

                vetor_teste = modelo.encode(
                    texto_base[:5000],
                    normalize_embeddings=True
                ).tolist()

                if documento_parecido(
                    vetor_teste
                ):

                    # Não bloqueia quando é uma URL conhecida.
                    # Isso permite atualizar fontes.
                    if not url:

                        return "PARECIDO"

            except Exception as e:

                sys.stderr.write(
                    "[learning_engine] "
                    f"Falha na verificação de similaridade: {e}\n"
                )

        # --------------------------------------------------------
        # DIVIDE O DOCUMENTO
        # --------------------------------------------------------

        chunks = dividir_em_chunks(
            texto_base
        )

        if not chunks:
            return "ERRO"

        ids = []
        documentos = []
        embeddings = []
        metadatas = []

        for indice, chunk in enumerate(
            chunks
        ):

            chunk_id = (
                f"{id_documento}_"
                f"{indice}"
            )

            vetor = modelo.encode(
                chunk,
                normalize_embeddings=True
            ).tolist()

            ids.append(
                chunk_id
            )

            documentos.append(
                chunk
            )

            embeddings.append(
                vetor
            )

            metadatas.append(
                {
                    "doc_id": id_documento,
                    "titulo": titulo[:500],
                    "tipo": categoria[:100],
                    "url": (
                        url or ""
                    )[:2000],
                    "content_hash": content_hash,
                    "chunk_index": indice,
                    "chunk_total": len(chunks),
                    "timestamp": str(
                        int(time.time())
                    ),
                }
            )

        colecao.upsert(
            ids=ids,
            documents=documentos,
            embeddings=embeddings,
            metadatas=metadatas
        )

        # --------------------------------------------------------
        # ESPELHO NO MYSQL
        # --------------------------------------------------------

        _registrar_mysql(
            titulo,
            texto_base,
            categoria,
            id_documento,
            url,
            content_hash
        )

        return status

    except Exception as e:

        sys.stderr.write(
            "[learning_engine] "
            f"Erro em learn(): {e}\n"
        )

        return "ERRO"


# ================================================================
# BUSCA SEMÂNTICA
# ================================================================

def buscar_resultados(
    pergunta_usuario: str,
    limite_resultados: int = 6,
) -> List[Dict[str, Any]]:

    pergunta_usuario = normalizar_texto(
        pergunta_usuario
    )

    if not pergunta_usuario:
        return []

    limite_resultados = max(
        1,
        min(
            int(limite_resultados),
            20
        )
    )

    try:

        if not _inicializar_memoria():
            itens = _carregar_fallback()
            termos = set(re.findall(r"\w+", pergunta_usuario.lower()))
            candidatos = []
            for item in itens:
                texto = str(item.get("conteudo", ""))
                palavras = set(re.findall(r"\w+", texto.lower()))
                score = len(termos & palavras)
                if score > 0:
                    candidatos.append((score, item))
            candidatos.sort(key=lambda x: x[0], reverse=True)
            return [
                {
                    "documento": item.get("conteudo", ""),
                    "metadata": {
                        "titulo": item.get("titulo", ""),
                        "tipo": item.get("categoria", ""),
                        "url": item.get("url", ""),
                    },
                    "distancia": None,
                }
                for _, item in candidatos[:limite_resultados]
            ]

        vetor = modelo.encode(
            pergunta_usuario,
            normalize_embeddings=True
        ).tolist()

        resultado = colecao.query(
            query_embeddings=[vetor],
            n_results=limite_resultados,
            include=[
                "documents",
                "metadatas",
                "distances",
            ]
        )

        documentos = (
            resultado.get(
                "documents",
                [[]]
            )[0]
            or []
        )

        metadatas = (
            resultado.get(
                "metadatas",
                [[]]
            )[0]
            or []
        )

        distancias = (
            resultado.get(
                "distances",
                [[]]
            )[0]
            or []
        )

        resultados = []

        for documento, metadata, distancia in zip(
            documentos,
            metadatas,
            distancias
        ):

            resultados.append(
                {
                    "documento": documento,
                    "metadata": metadata or {},
                    "distancia": distancia,
                }
            )

        return resultados

    except Exception as e:

        sys.stderr.write(
            "[learning_engine] "
            f"Erro na busca semântica: {e}\n"
        )

        return []


def buscar_na_memoria_iana(
    pergunta_usuario: str,
    limite_resultados: int = 6,
) -> str:
    """
    Função compatível com seu iana.py atual.

    Retorna texto pronto para ser colocado no prompt.
    """

    resultados = buscar_resultados(
        pergunta_usuario,
        limite_resultados
    )

    if not resultados:

        return ""

    partes = []

    for resultado in resultados:

        documento = str(
            resultado.get(
                "documento",
                ""
            )
        ).strip()

        metadata = resultado.get(
            "metadata",
            {}
        )

        if not documento:
            continue

        titulo = (
            metadata.get(
                "titulo",
                ""
            )
            if isinstance(metadata, dict)
            else ""
        )

        tipo = (
            metadata.get(
                "tipo",
                ""
            )
            if isinstance(metadata, dict)
            else ""
        )

        url = (
            metadata.get(
                "url",
                ""
            )
            if isinstance(metadata, dict)
            else ""
        )

        cabecalho = ""

        if titulo:
            cabecalho += (
                f"[{tipo.upper()} — "
                f"{titulo}]"
                if tipo
                else f"[{titulo}]"
            )

        if url:
            cabecalho += (
                f"\nFonte: {url}"
            )

        if cabecalho:
            partes.append(
                f"{cabecalho}\n"
                f"{documento}"
            )

        else:
            partes.append(
                documento
            )

    if not partes:

        return ""

    return "\n\n---\n\n".join(
        partes[:limite_resultados]
    )


# ================================================================
# STATUS
# ================================================================

def status_memoria() -> Dict[str, Any]:

    resultado = {
        "chromadb": False,
        "documentos": 0,
        "modelo": EMBEDDING_MODEL,
        "banco": str(path_banco),
        "fallback": False,
    }

    if _inicializar_memoria():

        resultado["chromadb"] = True

        try:
            resultado["documentos"] = (
                colecao.count()
            )
        except Exception:
            resultado["documentos"] = 0

    else:

        resultado["fallback"] = True

        resultado["documentos"] = len(
            _carregar_fallback()
        )

    return resultado


# ================================================================
# CLI
# ================================================================

def main():

    print("=" * 60)
    print("🧠 IANA — LEARNING ENGINE")
    print("=" * 60)

    if len(sys.argv) >= 3:

        titulo = sys.argv[1]
        conteudo = sys.argv[2]

        categoria = (
            sys.argv[3]
            if len(sys.argv) > 3
            else "mining"
        )

        status = learn(
            titulo=titulo,
            conteudo=conteudo,
            categoria=categoria
        )

        print(
            f"Resultado: {status}"
        )

        sys.exit(
            0
            if status in (
                "NOVO",
                "ATUALIZADO",
                "EXISTE",
                "PARECIDO"
            )
            else 1
        )

    status = status_memoria()

    print(
        f"📁 Banco: {status['banco']}"
    )

    print(
        f"🧠 ChromaDB: "
        f"{'OK' if status['chromadb'] else 'OFFLINE'}"
    )

    print(
        f"📚 Documentos: "
        f"{status['documentos']}"
    )

    print(
        f"🤖 Embedding: "
        f"{status['modelo']}"
    )


if __name__ == "__main__":
    main()