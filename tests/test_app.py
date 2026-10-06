import os
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch

os.environ.setdefault("IANA_API_KEY", "test-api-key")

from core import app as api


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = api.app.test_client()
        with api.sessoes_lock:
            api.sessoes_memoria.clear()

    def headers(self):
        return {"X-API-Key": api.IANA_API_KEY}

    def test_resolve_api_key_uses_gemini_fallback_for_local_dev(self):
        with patch.dict("os.environ", {"IANA_API_KEY": "", "GEMINI_API_KEY": "fallback-gemini-key"}, clear=False):
            resolved = api.resolve_api_key()
        self.assertEqual(resolved, "fallback-gemini-key")

    def test_vision_scene_summary_is_structured(self):
        detections = [
            {"label": "person", "confidence": 0.93, "xyxy": [100, 100, 200, 220]},
            {"label": "sword", "confidence": 0.8, "xyxy": [300, 200, 380, 260]},
            {"label": "chest", "confidence": 0.88, "xyxy": [520, 120, 600, 180]},
            {"label": "danger", "confidence": 0.91, "xyxy": [120, 300, 220, 440]},
        ]
        summary = api.vision_worker.summarize_scene(detections)
        self.assertIn("status", summary)
        self.assertIn("route", summary)
        self.assertIn("items", summary)
        self.assertIn("decision", summary)
        self.assertTrue(summary["items"])

    def test_gemini_provider_returns_generated_text(self):
        response = Mock()
        response.json.return_value = {
            "candidates": [{"content": {"parts": [{"text": "Oi, Alex! Tudo certo por aqui."}]}}]
        }
        with patch.object(api.iana_v2, "MINHA_API_PROVIDER", "gemini"), \
             patch.object(api.iana_v2, "GEMINI_API_KEY", "test-gemini-key"), \
             patch.object(api.iana_v2, "GEMINI_API_URL", "https://example.test/generateContent"), \
             patch.object(api.iana_v2.requests, "post", return_value=response) as post:
            reply = api.iana_v2.chamar_minha_api(
                msg_usr="Oi",
                usr_nome="Alex",
                cfg_usr={"personalidade": ["descontraída"]},
            )

        self.assertEqual(reply, "Oi, Alex! Tudo certo por aqui.")
        self.assertEqual(post.call_args.kwargs["params"], {"key": "test-gemini-key"})
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["contents"][0]["role"], "user")
        system_instruction = payload["systemInstruction"]["parts"][0]["text"]
        self.assertIn(api.iana_v2.system_prompt, system_instruction)
        self.assertIn(api.iana_v2.INSTRUCAO_CONVERSA_NATURAL, system_instruction)
        self.assertIn("descontraída", system_instruction)

    def test_chat_passes_frontend_preferences_to_pipeline(self):
        preferencias = {
            "personalidade": ["bem-humorada"],
            "instrucoes": "Fale de forma espontânea.",
        }

        def pipeline_com_preferencias():
            return api.iana_v2.montar_config_prompt(api.iana_v2.config_usuario)

        with patch.object(api, "RUN_PIPELINE_OK", True), \
             patch.object(api.iana_v2, "run_pipeline", side_effect=pipeline_com_preferencias):
            response = self.client.post(
                "/api/v1/chat",
                json={
                    "mensagem": "Oi",
                    "sessao_id": "preferencias",
                    "config_usuario": preferencias,
                },
                headers=self.headers(),
            )

        self.assertEqual(response.status_code, 200)
        self.assertIn("bem-humorada", response.json["resposta"])
        self.assertIn("Fale de forma espontânea.", response.json["resposta"])

    def test_chat_rejects_invalid_frontend_preferences(self):
        response = self.client.post(
            "/api/v1/chat",
            json={"mensagem": "Oi", "config_usuario": ["invalid"]},
            headers=self.headers(),
        )

        self.assertEqual(response.status_code, 400)

    def test_system_prompt_is_not_formatted_as_conversation_history(self):
        history = [
            {"role": "system", "content": "Instruções privadas da Iana"},
            {"role": "user", "content": "Oi"},
            {"role": "assistant", "content": "E aí!"},
        ]

        formatted = api.iana_v2.formatar_historico(history, "Alex")

        self.assertNotIn("Instruções privadas da Iana", formatted)
        self.assertIn("Usuário (Alex): Oi", formatted)
        self.assertIn("Iana: E aí!", formatted)

    def test_short_social_chat_skips_knowledge_search_and_keeps_personality(self):
        with patch.object(api.iana_v2, "msg_final", "Oi, tudo bem?"), \
             patch.object(api.iana_v2, "nome_usuario", "Alex"), \
             patch.object(api.iana_v2, "historico", [{"role": "user", "content": "Oi"}]), \
             patch.object(api.iana_v2, "consultar_conhecimento") as knowledge, \
             patch.object(api.iana_v2, "consultar_memoria_usuario") as memory, \
             patch.object(api.iana_v2, "chamar_minha_api", return_value="Oi, Alex! Tudo certo por aqui. E você?") as generate, \
             patch.object(api.iana_v2, "salvar_interacao"):
            reply = api.iana_v2.run_pipeline()

        self.assertIn("Tudo certo", reply)
        knowledge.assert_not_called()
        memory.assert_not_called()
        self.assertEqual(generate.call_args.args[0], "Oi, tudo bem?")

    def test_game_question_still_uses_knowledge_search(self):
        with patch.object(api.iana_v2, "msg_final", "Como consigo a platina de Elden Ring?"), \
             patch.object(api.iana_v2, "consultar_conhecimento", return_value="Guia local") as knowledge, \
             patch.object(api.iana_v2, "consultar_memoria_usuario", return_value=""), \
             patch.object(api.iana_v2, "chamar_minha_api", return_value="Vamos por partes."), \
             patch.object(api.iana_v2, "salvar_interacao"):
            api.iana_v2.run_pipeline()

        knowledge.assert_called_once()

    def test_chat_rejects_non_object_json(self):
        response = self.client.post("/api/v1/chat", json=["hello"], headers=self.headers())
        self.assertEqual(response.status_code, 400)

    def test_chat_rejects_oversized_message(self):
        response = self.client.post(
            "/api/v1/chat",
            json={"mensagem": "x" * (api.MAX_MESSAGE_LENGTH + 1)},
            headers=self.headers(),
        )
        self.assertEqual(response.status_code, 413)

    def test_oversized_request_has_json_error(self):
        body = b"x" * (api.app.config["MAX_CONTENT_LENGTH"] + 1)
        response = self.client.post(
            "/api/v1/chat",
            data=body,
            content_type="application/json",
            headers=self.headers(),
        )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json["erro"], "Payload Too Large")

    def test_history_is_bounded(self):
        with patch.object(api, "RUN_PIPELINE_OK", False):
            for index in range(api.MAX_HISTORY_MESSAGES + 2):
                response = self.client.post(
                    "/api/v1/chat",
                    json={"mensagem": str(index), "sessao_id": "bounded"},
                    headers=self.headers(),
                )
                self.assertEqual(response.status_code, 200)

        response = self.client.get("/api/v1/chat/historico/bounded", headers=self.headers())
        self.assertEqual(response.status_code, 200)
        self.assertLessEqual(response.json["total"], api.MAX_HISTORY_MESSAGES)
        self.assertNotIn("system", [item["role"] for item in api.sessoes_memoria["bounded"]])

    def test_concurrent_sessions_do_not_overwrite_pipeline_input(self):
        entered = threading.Event()
        release = threading.Event()

        def delayed_pipeline():
            entered.set()
            if not release.wait(timeout=2):
                raise TimeoutError("Test pipeline was not released")
            return api.iana_v2.msg_final

        def send(message, session_id):
            with api.app.test_client() as client:
                response = client.post(
                    "/api/v1/chat",
                    json={"mensagem": message, "sessao_id": session_id},
                    headers=self.headers(),
                )
                return response.json["resposta"]

        with patch.object(api, "RUN_PIPELINE_OK", True), patch.object(api.iana_v2, "run_pipeline", delayed_pipeline):
            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(send, "message-a", "session-a")
                self.assertTrue(entered.wait(timeout=1))
                second = executor.submit(send, "message-b", "session-b")
                deadline = time.monotonic() + 1
                while time.monotonic() < deadline:
                    with api.sessoes_lock:
                        if "session-b" in api.sessoes_memoria:
                            break
                    time.sleep(0.005)
                with api.sessoes_lock:
                    self.assertIn("session-b", api.sessoes_memoria)
                release.set()
                self.assertEqual(first.result(timeout=2), "message-a")
                self.assertEqual(second.result(timeout=2), "message-b")


if __name__ == "__main__":
    unittest.main()