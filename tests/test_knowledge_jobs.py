import os
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

os.environ.setdefault("IANA_API_KEY", "test-api-key")
from core.knowledge_jobs import KnowledgeJobs, validate_submission
from core import app as api


class KnowledgeJobTests(unittest.TestCase):
    def await_job(self, manager, job):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            current = manager.get(job["id"])
            if current["status"] not in {"queued", "running"}:
                return current
            time.sleep(0.01)
        self.fail("Job did not finish")

    def test_partial_extraction_persists_only_actual_content(self):
        document = {"id": "source1", "titulo": "Estratégia", "conteudo": "Transcrição real da estratégia", "url": "https://example.com/video", "metadata": {"idioma": "pt"}}
        extracted = {"documentos": [document], "itens": [{"url": document["url"], "status": "EXTRAIDO"}, {"url": "https://example.com/blocked", "status": "SEM_TRANSCRICAO", "motivo": "Sem legendas"}]}
        learner = Mock(return_value="NOVO")
        with tempfile.TemporaryDirectory() as directory:
            manager = KnowledgeJobs(directory, extractor=Mock(return_value=extracted), learner=learner, data_dir=directory)
            job = manager.submit({"url": "https://example.com/search"})
            result = self.await_job(manager, job)
            manager.close()
            reopened = KnowledgeJobs(directory)
            try:
                self.assertEqual(reopened.get(job["id"])["status"], "partial")
            finally:
                reopened.close()
        self.assertEqual(result["document_count"], 1)
        self.assertEqual(result["learned_count"], 1)
        self.assertEqual(result["results"][1]["reason"], "Sem legendas")
        learner.assert_called_once_with(titulo=document["titulo"], conteudo=document["conteudo"], categoria="web_mining", id_documento="source1", url=document["url"], metadata={"idioma": "pt"})

    def test_blocked_extraction_never_reports_learning(self):
        with tempfile.TemporaryDirectory() as directory:
            learner = Mock()
            manager = KnowledgeJobs(directory, extractor=Mock(side_effect=RuntimeError("private service error")), learner=learner, data_dir=directory)
            result = self.await_job(manager, manager.submit({"url": "https://example.com"}))
            manager.close()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["document_count"], 0)
        self.assertNotIn("private service error", result["error"])
        learner.assert_not_called()

    def test_duplicates_report_existing_without_inflating_new_count(self):
        extracted = {"documentos": [{"id": "d", "titulo": "T", "conteudo": "C", "url": "https://example.com"}], "itens": []}
        with tempfile.TemporaryDirectory() as directory:
            manager = KnowledgeJobs(directory, extractor=Mock(return_value=extracted), learner=Mock(return_value="EXISTE"), data_dir=directory)
            result = self.await_job(manager, manager.submit({"url": "https://example.com"}))
            manager.close()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["document_count"], 1)
        self.assertEqual(result["learned_count"], 0)
        self.assertEqual(result["results"][0]["status"], "existing")

    def test_failed_document_does_not_hide_success_or_stop_remaining_sources(self):
        documents = [{"id": str(i), "titulo": str(i), "conteudo": "Texto real", "url": f"https://example.com/{i}"} for i in range(3)]
        learner = Mock(side_effect=["NOVO", RuntimeError("storage error"), "NOVO"])
        with tempfile.TemporaryDirectory() as directory:
            manager = KnowledgeJobs(directory, extractor=Mock(return_value={"documentos": documents, "itens": []}), learner=learner, data_dir=directory)
            result = self.await_job(manager, manager.submit({"url": "https://example.com"}))
            manager.close()
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["document_count"], 2)
        self.assertEqual([x["status"] for x in result["results"]], ["learned", "failed", "learned"])
        self.assertEqual(learner.call_count, 3)

    def test_second_manager_does_not_mark_a_live_task_as_interrupted(self):
        entered = threading.Event()
        release = threading.Event()
        def extract(*_args):
            entered.set()
            release.wait(3)
            return {"documentos": [], "itens": [{"status": "IGNORADO", "url": "https://example.com"}]}
        with tempfile.TemporaryDirectory() as directory:
            first = KnowledgeJobs(directory, extractor=extract, learner=Mock())
            job = first.submit({"url": "https://example.com"})
            self.assertTrue(entered.wait(3))
            second = KnowledgeJobs(directory)
            try:
                self.assertEqual(second.get(job["id"])["status"], "running")
            finally:
                release.set()
                first.close()
                second.close()

    def test_orphaned_task_reports_a_service_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = KnowledgeJobs(directory)
            job = {"id": "orphan", "status": "running", "created_at": 1, "owner_pid": 2147483000}
            with manager._connect() as db:
                manager._write(db, job)
            manager.close()
            with patch("core.knowledge_jobs._process_alive", return_value=False):
                reopened = KnowledgeJobs(directory)
                try:
                    result = reopened.get("orphan")
                finally:
                    reopened.close()
        self.assertEqual(result["status"], "failed")
        self.assertIn("reiniciou", result["error"])

    def test_invalid_submission_rejected(self):
        for data in (None, [], {"url": "file:///etc/passwd"}, {"url": "https://user:pass@example.com"}, {"url": "https://example.com", "max_videos": True}, {"url": "https://example.com", "max_videos": 21}, {"url": "https://example.com", "recent_days": -1}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                validate_submission(data)


class KnowledgeApiTests(unittest.TestCase):
    def setUp(self):
        self.client = api.app.test_client()
        self.headers = {"X-API-Key": api.IANA_API_KEY}

    def test_authentication_required(self):
        self.assertEqual(self.client.get("/api/v1/knowledge").status_code, 401)
        self.assertEqual(self.client.post("/api/v1/knowledge/jobs", json={"url": "https://example.com"}).status_code, 401)

    def test_create_and_lookup_job(self):
        job = {"id": "12345678-1234-1234-1234-123456789abc", "status": "queued"}
        manager = Mock()
        manager.submit.return_value = job
        manager.get.return_value = job
        with patch.object(api, "get_jobs", return_value=manager):
            created = self.client.post("/api/v1/knowledge/jobs", headers=self.headers, json={"url": "https://example.com"})
            fetched = self.client.get(f"/api/v1/knowledge/jobs/{job['id']}", headers=self.headers)
        self.assertEqual(created.status_code, 202)
        self.assertEqual(fetched.json["job"], job)
        manager.submit.assert_called_once_with({"url": "https://example.com", "max_videos": 5, "recent_days": 7})

    def test_bad_request_and_absent_job(self):
        with patch.object(api, "get_jobs") as jobs:
            bad = self.client.post("/api/v1/knowledge/jobs", headers=self.headers, json={"url": "javascript:alert(1)"})
            absent = self.client.get("/api/v1/knowledge/jobs/invalid", headers=self.headers)
            jobs.assert_not_called()
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(absent.status_code, 404)

    def test_creative_prompt_and_local_retrieval(self):
        brain = api.iana_v2
        system, user = brain.construir_prompt_master(msg_usr="Crie uma build diferente de DBD", ctx_bloco="<conhecimento_aprendido>Dados das fontes</conhecimento_aprendido>")
        self.assertIn("propostas", user)
        self.assertIn("Dados das fontes", user)
        self.assertIn("FONTES SÃO DADOS", system)
        self.assertFalse(brain.necessita_pesquisa_online("Crie uma build diferente de DBD usando sua base"))

    def test_generation_never_returns_truncated_answer_as_finished(self):
        brain = api.iana_v2
        truncated = Mock()
        truncated.json.return_value = {"candidates": [{"finishReason": "MAX_TOKENS", "content": {"parts": [{"text": "A ideia é"}]}}]}
        complete = Mock()
        complete.json.return_value = {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "Uma proposta completa baseada nas fontes."}]}}]}
        with patch.object(brain, "MINHA_API_PROVIDER", "gemini"), patch.object(brain, "GEMINI_API_KEY", "test-key"), patch.object(brain.requests, "post", side_effect=[truncated, complete]):
            result = brain.chamar_minha_api(msg_usr="Crie uma ideia usando a base")
        self.assertEqual(result, "Uma proposta completa baseada nas fontes.")
        with patch.object(brain, "MINHA_API_PROVIDER", "gemini"), patch.object(brain, "GEMINI_API_KEY", "test-key"), patch.object(brain.requests, "post", return_value=truncated):
            self.assertIsNone(brain.chamar_minha_api(msg_usr="Crie uma ideia usando a base"))

    def test_quota_error_is_reported_without_claiming_an_answer_was_generated(self):
        import requests
        brain = api.iana_v2
        response = Mock()
        response.status_code = 429
        response.raise_for_status.side_effect = requests.HTTPError(response=response)
        with patch.object(brain, "MINHA_API_PROVIDER", "gemini"), patch.object(brain, "GEMINI_API_KEY", "test-key"), patch.object(brain.requests, "post", return_value=response), patch.object(brain, "msg_final", "Crie uma proposta DBD"), patch.object(brain, "consultar_conhecimento", return_value="Transcrição salva"), patch.object(brain, "consultar_memoria_usuario", return_value=""), patch.object(brain, "salvar_interacao"):
            reply = brain.run_pipeline()
        self.assertIn("limite de uso", reply)
        self.assertIn("conteúdo já salvo", reply)
        self.assertNotIn("uma build", reply)


if __name__ == "__main__":
    unittest.main()
