## memory.py

import json
from db_config import get_db_path

DB_FILE = get_db_path("memory.json")


def load():
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except:
        return []


def save(data):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# -----------------------------
# BUSCA INTELIGENTE (SIMPLES)
# -----------------------------
def get_memory(user_id, query, limit=5):
    data = load()

    filtered = [
        d["text"]
        for d in data
        if str(d["user_id"]) == str(user_id)
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

    scored.sort(reverse=True)

    return [t for _, t in scored[:limit]]


# -----------------------------
# SALVAR MEMÓRIA
# -----------------------------
def save_memory(user_id, text):
    data = load()

    data.append({
        "user_id": user_id,
        "text": text
    })

    save(data)