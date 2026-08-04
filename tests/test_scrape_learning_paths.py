import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import scrape_learning


def test_resolver_arquivo_fallback_para_raiz(tmp_path):
    raiz = tmp_path
    (raiz / "data").mkdir(exist_ok=True)
    (raiz / "reworks_dbd.txt").write_text("Killer Rework - The Shape\n", encoding="utf-8")

    caminho = scrape_learning.resolver_arquivo("reworks_dbd.txt", pasta_raiz=raiz)

    assert caminho == raiz / "reworks_dbd.txt"


def test_extrair_textos_reworks_filtra_linhas_vazias():
    linhas = ["", "Killer Rework - The Shape", "  ", "The Shape Rework", "   "]

    itens = scrape_learning.extrair_textos_reworks(linhas)

    assert itens == ["Killer Rework - The Shape", "The Shape Rework"]
