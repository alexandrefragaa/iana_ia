import os
from pathlib import Path

# FIX: o código original usava sempre os.environ["LOCALAPPDATA"], que só
# existe no Windows. No Render (Linux), essa variável não existe e o
# processo quebrava com KeyError já na importação do módulo — pior que
# o bug equivalente no iana.py (aquele ao menos tinha um fallback).
#
# Agora:
# 1. Se IANA_DB_PATH estiver definida (aponte ela pro seu Persistent Disk
#    no Render), usa ela — mesma variável já usada pelo ChromaDB no
#    iana.py, então um único disco persistente cobre as duas memórias.
# 2. Senão, detecta o SO corretamente: Windows -> LOCALAPPDATA,
#    outros -> XDG_DATA_HOME ou ~/.local/share.
#
# ATENÇÃO (igual no ChromaDB): sem um Persistent Disk configurado no
# Render, o filesystem é efêmero — memory.json também vai zerar a cada
# deploy/restart, mesmo com o caminho corrigido. Configure IANA_DB_PATH
# apontando pro disco persistente se quiser que isso realmente dure.

def _base_path() -> Path:
    override = os.getenv("IANA_DB_PATH")
    if override:
        return Path(override) / "iana_database"

    if os.name == "nt":
        base = Path(os.getenv("LOCALAPPDATA", str(Path.home())))
    else:
        base = Path(os.getenv("XDG_DATA_HOME", str(Path.home() / ".local" / "share")))

    return base / "iana_database"


BASE_PATH = _base_path()
BASE_PATH.mkdir(parents=True, exist_ok=True)


def get_db_path(filename: str) -> str:
    return str(BASE_PATH / filename)