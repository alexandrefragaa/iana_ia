## memory.py

import json
import threading
from db_config import get_db_path

DB_FILE = get_db_path("memory.json")

# Trava simples para evitar race condition em load->modifica->save
# quando duas chamadas acontecem "ao mesmo tempo" no MESMO processo.
# Atenção: não protege contra múltiplos processos/workers acessando o
# mesmo arquivo — pra isso seria necessário lock de arquivo (ex: filelock)
# ou migrar para um banco de verdade (SQLite, por exemplo).
_lock = threading.Lock()


def load():
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return []
    except json.JSONDecodeError as e:
        # FIX: antes era um "except:" genérico que engolia isso e
        # devolvia [] silenciosamente. Se alguém chamasse save_memory()
        # depois, o arquivo original (corrompido, mas ainda com dados)
        # seria sobrescrito e os dados antigos seriam perdidos pra sempre.
        # Agora avisamos e propagamos, pra não mascarar o problema.
        print(f"⚠️ memory.json corrompido, não foi possível ler: {e}")
        raise


def save(data):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# -----------------------------
# BUSCA INTELIGENTE (SIMPLES)
# -----------------------------
def get_memory(user_id, query, limit=5):
    with _lock:
        data = load()

    filtered = [
        d["text"]
        for d in data
        # FIX: usa .get() pra não quebrar com KeyError se algum
        # registro do JSON estiver malformado (faltando "user_id" ou "text")
        if str(d.get("user_id")) == str(user_id) and d.get("text")
    ]

    # ranking simples por relevância
    scored = []
    for text in filtered:
        score = 0

        if query.lower() in text.lower():
            score += 3

        if len(text) > 80:
            score += 1

        scored.append((score, text))

    # FIX: ordenar só pela chave "score" — antes, empates eram
    # desempatados por ordem alfabética decrescente do texto (efeito
    # colateral de ordenar a tupla inteira, provavelmente não intencional)
    scored.sort(key=lambda item: item[0], reverse=True)

    return [t for _, t in scored[:limit]]


# -----------------------------
# SALVAR MEMÓRIA
# -----------------------------
def save_memory(user_id, text):
    with _lock:
        data = load()

        data.append({
            "user_id": user_id,
            "text": text
        })

        save(data)