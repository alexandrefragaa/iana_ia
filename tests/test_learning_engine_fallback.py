import builtins
import importlib
import sys


def test_learning_engine_fallback_sem_dependencias(monkeypatch, tmp_path):
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name in {"chromadb", "sentence_transformers"}:
            raise ModuleNotFoundError(f"No module named '{name}'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    monkeypatch.setenv("IANA_DB_PATH", str(tmp_path))
    sys.modules.pop("core.learning_engine", None)

    learning_engine = importlib.import_module("core.learning_engine")

    status = learning_engine.learn("Título teste", "Conteúdo teste", "mining", id_documento="doc_fallback")

    assert status in {"NOVO", "ATUALIZADO", "PARECIDO"}
