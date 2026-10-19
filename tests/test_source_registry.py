import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import Mock

from core import source_registry as registry
from core import scrape_learning as scraper


SEARCH = "https://www.youtube.com/results?search_query=nuild+end+game+dbd&sp=EgIIAw%253D%253D"


def document(url, text="Texto extraído e salvo da fonte real."):
    return {"id": "id_" + hashlib.sha256(url.encode()).hexdigest(), "url": url,
            "titulo": "Fonte", "conteudo": text, "metadata": {}}


class SourceRegistryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def test_partial_search_records_only_confirmed_videos_and_preserves_files(self):
        existing = "# Histórico anterior\nhttps://example.com/antigo\n"
        (self.directory / "links_concluidos.txt").write_text(existing, encoding="utf-8")
        (self.directory / "update_source_state.json").write_text(json.dumps({"https://example.com/antigo": "legacyhash"}), encoding="utf-8")
        queued = "# Não consumir esta fila\nhttps://example.com/pendente\n"
        (self.directory / "links_para_mineracao.txt").write_text(queued, encoding="utf-8")
        one = document("https://www.youtube.com/watch?v=abcdefghijk")
        failed = document("https://www.youtube.com/watch?v=zyxwvutsrqp")
        similar = document("https://example.com/parecido")
        extracted = {"documentos": [one, failed, similar], "itens": [{"url": "https://youtube.com/watch?v=semlegendas", "status": "SEM_TRANSCRICAO"}]}
        outcomes = [{"id": one["id"], "url": one["url"], "outcome": "NOVO"},
                    {"id": failed["id"], "url": failed["url"], "outcome": "ERRO"},
                    {"id": similar["id"], "url": similar["url"], "outcome": "PARECIDO"}]
        saved = registry.record_source_result(SEARCH, extracted, outcomes, data_dir=self.directory)
        self.assertEqual(saved["saved_urls"], [one["url"]])
        completed = (self.directory / "links_concluidos.txt").read_text(encoding="utf-8")
        self.assertEqual(completed, existing + one["url"] + "\n")
        self.assertNotIn(SEARCH, completed)
        state = registry.load_state(self.directory)
        self.assertEqual(state[one["url"]], registry.content_hash(one["conteudo"]))
        self.assertEqual(state["https://example.com/antigo"], "legacyhash")
        self.assertEqual((self.directory / "links_para_mineracao.txt").read_text(encoding="utf-8"), queued)

    def test_repeated_source_is_idempotent_and_content_change_updates_hash(self):
        doc = document("https://example.com/article")
        outcomes = [{"id": doc["id"], "outcome": "EXISTE"}]
        for _ in range(2):
            registry.record_source_result(doc["url"], {"documentos": [doc]}, outcomes, data_dir=self.directory)
        self.assertEqual((self.directory / "links_concluidos.txt").read_text(encoding="utf-8"), doc["url"] + "\n")
        doc["conteudo"] = "Texto atualizado realmente extraído."
        result = registry.record_source_result(doc["url"], {"documentos": [doc]}, outcomes, data_dir=self.directory)
        self.assertEqual(result["updated_urls"], [doc["url"]])
        self.assertEqual(registry.load_state(self.directory)[doc["url"]], registry.content_hash(doc["conteudo"]))

    def test_failed_or_title_only_result_does_not_create_completion_or_state(self):
        doc = document("https://example.com/article", "")
        registry.record_source_result(doc["url"], {"documentos": [doc]}, [{"id": doc["id"], "outcome": "NOVO"}], data_dir=self.directory)
        registry.record_source_result(SEARCH, {"documentos": [], "itens": [{"status": "ERRO"}]}, [], data_dir=self.directory)
        self.assertFalse((self.directory / "links_concluidos.txt").exists())
        self.assertFalse((self.directory / "update_source_state.json").exists())

    def test_corrupt_state_is_preserved_instead_of_overwritten(self):
        path = self.directory / "update_source_state.json"
        path.write_text("{invalid existing state", encoding="utf-8")
        doc = document("https://example.com/article")
        with self.assertRaises(ValueError):
            registry.record_source_result(doc["url"], {"documentos": [doc]}, [{"id": doc["id"], "outcome": "NOVO"}], data_dir=self.directory)
        self.assertEqual(path.read_text(encoding="utf-8"), "{invalid existing state")
        self.assertFalse((self.directory / "links_concluidos.txt").exists())

    def test_parallel_records_do_not_lose_sources_or_duplicate_history(self):
        def store(number):
            doc = document(f"https://example.com/{number % 12}")
            registry.record_source_result(doc["url"], {"documentos": [doc]}, [{"id": doc["id"], "outcome": "NOVO"}], data_dir=self.directory)
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(store, range(36)))
        self.assertEqual(len(registry.completed_urls(self.directory)), 12)
        self.assertEqual(len(registry.load_state(self.directory)), 12)
        self.assertEqual(len((self.directory / "links_concluidos.txt").read_text(encoding="utf-8").splitlines()), 12)

    def test_authorized_update_search_is_appended_once_without_rewriting_queue(self):
        path = self.directory / "update_sources.txt"
        original = "# Atualizações\nhttps://example.com/news"
        path.write_text(original, encoding="utf-8")
        self.assertTrue(registry.ensure_update_source(SEARCH, self.directory))
        self.assertFalse(registry.ensure_update_source(SEARCH, self.directory))
        self.assertEqual(path.read_text(encoding="utf-8"), original + "\n" + SEARCH + "\n")



    def test_irrelevant_wikipedia_article_is_not_learned(self):
        title_file = self.directory / "titulos_para_buscar.txt"
        title_file.write_text(
            "Item Drop Tech Dead by Daylight\n",
            encoding="utf-8",
        )

        irrelevant_title = (
            "História da violência contra pessoas LGBTQ nos Estados Unidos"
        )
        irrelevant_content = (
            "Este artigo descreve a história da violência contra pessoas "
            "LGBTQ nos Estados Unidos. " * 10
        )
        irrelevant_url = (
            "https://pt.wikipedia.org/wiki/"
            "Hist%C3%B3ria_da_viol%C3%AAncia"
        )

        learner = Mock(return_value="NOVO")
        lookup = Mock(
            return_value=(
                irrelevant_title,
                irrelevant_content,
                irrelevant_url,
            )
        )

        scraper.learn_from_files(
            5,
            data_dir=self.directory,
            learner=learner,
            topic_lookup=lookup,
        )

        learner.assert_not_called()
        self.assertNotIn(
            irrelevant_url,
            registry.completed_urls(self.directory),
        )


class ExistingFileLearningTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def test_manual_passage_is_learned_with_provenance_and_short_title_requires_article(self):
        passage = "O predict no Dead by Daylight significa antecipar rotas e ações do adversário. Observe como o sobrevivente corre pelo loop e use a leitura de jogo para prever a próxima mudança de direção."
        original = passage + "\n\nDead by Daylight\n"
        title_file = self.directory / "titulos_para_buscar.txt"
        title_file.write_text(original, encoding="utf-8")
        learner = Mock(return_value="NOVO")
        lookup = Mock(return_value=None)
        result = scraper.learn_from_files(5, data_dir=self.directory, learner=learner, topic_lookup=lookup)
        self.assertEqual(result["document_count"], 1)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(learner.call_count, 1)
        content = learner.call_args.kwargs
        self.assertEqual(content["conteudo"], passage)
        self.assertEqual(content["url"], "")
        self.assertEqual(content["metadata"]["arquivo"], str(title_file))
        self.assertEqual(content["metadata"]["natureza"], "conteudo_fornecido")
        self.assertFalse(content["metadata"]["verificado"])
        lookup.assert_called_once_with("Dead by Daylight")
        self.assertEqual(title_file.read_text(encoding="utf-8"), original)
        self.assertFalse((self.directory / "links_concluidos.txt").exists())

    def test_titles_save_actual_wikipedia_text_and_source(self):
        (self.directory / "titulos_para_buscar.txt").write_text("Dead by Daylight\n", encoding="utf-8")
        article = "Dead by Daylight é um jogo de terror e sobrevivência com equipes assimétricas. " * 3
        learner = Mock(return_value="NOVO")
        result = scraper.learn_from_files(2, data_dir=self.directory, learner=learner,
            topic_lookup=Mock(return_value=("Dead by Daylight", article, "https://pt.wikipedia.org/wiki/Dead_by_Daylight")))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(learner.call_args.kwargs["conteudo"], article)
        self.assertEqual(learner.call_args.kwargs["metadata"]["metodo"], "wikipedia_extract")
        self.assertEqual(learner.call_args.kwargs["metadata"]["jogo"], "DBD")
        self.assertIn("https://pt.wikipedia.org/wiki/Dead_by_Daylight", registry.completed_urls(self.directory))

    def test_batches_advance_and_revisit_search_and_failed_sources(self):
        path = self.directory / "update_sources.txt"
        queued = SEARCH + "\nhttps://example.com/blocked\nhttps://example.com/news\n"
        path.write_text(queued, encoding="utf-8")
        def extract(url, options):
            if "blocked" in url:
                return {"documentos": [], "itens": [{"url": url, "status": "ERRO", "mensagem": "Bloqueado"}]}
            doc = document("https://www.youtube.com/watch?v=abcdefghijk" if url == SEARCH else url)
            return {"documentos": [doc], "itens": []}
        extractor = Mock(side_effect=extract)
        learner = Mock(return_value="NOVO")
        first = scraper.learn_from_files(2, data_dir=self.directory, learner=learner, extractor=extractor)
        second = scraper.learn_from_files(2, data_dir=self.directory, learner=learner, extractor=extractor)
        third = scraper.learn_from_files(2, data_dir=self.directory, learner=learner, extractor=extractor)
        self.assertEqual(first["processed_sources"], 2)
        self.assertEqual(first["status"], "partial")
        self.assertEqual(second["batch_offset"], 2)
        self.assertEqual(second["results"][0]["source"], "https://example.com/news")
        self.assertEqual(third["batch_offset"], 0)
        self.assertEqual(sum(call.args[0] == SEARCH for call in extractor.call_args_list), 2)
        self.assertNotIn(SEARCH, registry.completed_urls(self.directory))
        self.assertNotIn("https://example.com/blocked", registry.completed_urls(self.directory))
        self.assertEqual(path.read_text(encoding="utf-8"), queued)

    def test_all_three_link_files_use_same_extractor_and_updates_never_bypass_it(self):
        for name, url in (("update_sources.txt", "https://example.com/news"),
                          ("links_para_mineracao.txt", "https://example.com/new"),
                          ("links_concluidos.txt", "https://example.com/old")):
            (self.directory / name).write_text(url + "\n", encoding="utf-8")
        extractor = Mock(side_effect=lambda url, opts: {"documentos": [document(url)], "itens": []})
        result = scraper.learn_from_files(3, data_dir=self.directory, learner=Mock(return_value="EXISTE"), extractor=extractor)
        self.assertEqual(result["document_count"], 3)
        self.assertEqual(extractor.call_count, 3)
        self.assertEqual(extractor.call_args_list[0].args[1]["categoria"], "update")

    def test_sources_are_bounded_and_failed_save_does_not_complete_them(self):
        urls = [f"https://example.com/{number}" for number in range(5)]
        path = self.directory / "links_para_mineracao.txt"
        path.write_text("\n".join(urls), encoding="utf-8")
        result = scraper.learn_from_files(2, data_dir=self.directory, learner=Mock(return_value="ERRO"),
                                         extractor=Mock(side_effect=lambda url, opts: {"documentos": [document(url)], "itens": []}))
        self.assertEqual(result["processed_sources"], 2)
        self.assertEqual(result["remaining_sources"], 3)
        self.assertEqual(result["document_count"], 0)
        self.assertEqual(result["status"], "failed")
        self.assertFalse((self.directory / "links_concluidos.txt").exists())
        self.assertEqual(path.read_text(encoding="utf-8"), "\n".join(urls))
        for invalid in (0, 101, True):
            with self.assertRaises(ValueError):
                scraper.learn_from_files(invalid, data_dir=self.directory)

    def test_cli_from_files_persists_supplied_knowledge_in_real_store(self):
        passage = "Bush Tech usa a vegetação para sair da visão do adversário durante uma perseguição. Quando o adversário perde a linha de visão, entre no arbusto e observe a rota que ele vai seguir antes de continuar."
        (self.directory / "titulos_para_buscar.txt").write_text(passage, encoding="utf-8")
        database = self.directory / "database"
        environment = os.environ.copy()
        environment.update(IANA_DATA_DIR=str(self.directory), IANA_DB_PATH=str(database),
                           IANA_RAG_MODE="keyword", IANA_MYSQL_MIRROR="0", PYTHONIOENCODING="utf-8")
        process = subprocess.run([sys.executable, "-m", "core.learn_source", "--from-files", "--max-sources", "1", "--game", "DBD"],
            cwd=Path(__file__).resolve().parents[1], env=environment, capture_output=True, text=True, encoding="utf-8", timeout=30)
        self.assertEqual(process.returncode, 0, process.stderr)
        report = json.loads(process.stdout)
        self.assertEqual(report["document_count"], 1)
        with closing(sqlite3.connect(database / "memoria.sqlite3")) as connection:
            row = connection.execute("SELECT conteudo, url, metadata_json FROM documents").fetchone()
        self.assertEqual(row[0], passage)
        self.assertEqual(row[1], "")
        self.assertEqual(json.loads(row[2])["natureza"], "conteudo_fornecido")
        self.assertEqual(json.loads(row[2])["jogo"], "DBD")

    def test_game_inference_uses_only_each_passage_and_explicit_option_supports_alias(self):
        neutral = "Bush Tech usa a vegetação para sair da visão do adversário durante uma perseguição. Quando o adversário perde a linha de visão, entre no arbusto e observe a rota que ele vai seguir antes de continuar."
        dbd = "DBD tem partidas assimétricas com um assassino e quatro sobreviventes. Cada equipe combina vantagens e decisões de movimentação para cumprir seus objetivos, controlar o tempo e aproveitar o cenário."
        path = self.directory / "titulos_para_buscar.txt"
        original = neutral + "\n\n" + dbd
        path.write_text(original, encoding="utf-8")
        learner = Mock(return_value="NOVO")
        scraper.learn_from_files(2, data_dir=self.directory, learner=learner)
        self.assertNotIn("jogo", learner.call_args_list[0].kwargs["metadata"])
        self.assertEqual(learner.call_args_list[1].kwargs["metadata"]["jogo"], "DBD")
        for field in ("jogo", "game"):
            learner.reset_mock()
            scraper.learn_from_files(2, {field: "Jogo informado"}, data_dir=self.directory, learner=learner)
            self.assertEqual([call.kwargs["metadata"]["jogo"] for call in learner.call_args_list], ["Jogo informado", "Jogo informado"])
        self.assertEqual(path.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
