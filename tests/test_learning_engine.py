import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from textwrap import dedent


class LightweightRagTests(unittest.TestCase):
    def test_keyword_mode_skips_ml_imports_and_searches_fallback_documents(self):
        project_root = Path(__file__).resolve().parents[1]
        script = dedent(
            """
            import sys
            from core import learning_engine as engine

            assert engine.RAG_MODE == "keyword"
            assert engine.chromadb is None
            assert engine.SentenceTransformer is None
            assert "torch" not in sys.modules
            assert "chromadb" not in sys.modules
            assert "sentence_transformers" not in sys.modules

            engine._carregar_fallback = lambda: [
                {
                    "conteudo": "O lago fica ao norte do castelo.",
                    "titulo": "Lago",
                    "categoria": "local",
                    "url": "",
                },
                {
                    "conteudo": "O mercador fica perto do mercado.",
                    "titulo": "Mercador",
                    "categoria": "personagem",
                    "url": "",
                },
            ]
            resultados = engine.buscar_resultados("Onde fica o lago?", 5)
            assert resultados[0]["metadata"]["titulo"] == "Lago"
            assert engine.status_memoria()["fallback"] is True
            """
        )

        with tempfile.TemporaryDirectory() as database_path:
            environment = os.environ.copy()
            environment["IANA_RAG_MODE"] = "keyword"
            environment["IANA_DB_PATH"] = database_path
            result = subprocess.run(
                [sys.executable, "-c", script],
                cwd=project_root,
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
