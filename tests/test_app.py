import os
import base64
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

    def test_gemini_provider_uses_extended_default_timeout(self):
        response = Mock()
        response.json.return_value = {
            "candidates": [{"content": {"parts": [{"text": "Resposta gerada."}]}}]
        }
        with patch.object(api.iana_v2, "MINHA_API_PROVIDER", "gemini"), \
             patch.object(api.iana_v2, "MINHA_API_TIMEOUT", 45), \
             patch.object(api.iana_v2, "GEMINI_API_KEY", "test-gemini-key"), \
             patch.object(api.iana_v2, "GEMINI_API_URL", "https://example.test/generateContent"), \
             patch.object(api.iana_v2.requests, "post", return_value=response) as post:
            reply = api.iana_v2.chamar_minha_api(msg_usr="Onde fica o mercador?")

        self.assertEqual(reply, "Resposta gerada.")
        self.assertEqual(post.call_args.kwargs["timeout"], 45)

    def test_gemini_provider_includes_uploaded_media(self):
        for mime_type, prompt in (
            ("image/png", "Descreva a imagem."),
            ("video/mp4", "O que acontece neste vídeo?"),
        ):
            with self.subTest(mime_type=mime_type):
                response = Mock()
                response.json.return_value = {
                    "candidates": [{"content": {"parts": [{"text": "Entendi o conteúdo."}]}}]
                }
                attachment = {"mime_type": mime_type, "data": "cG5n"}
                with patch.object(api.iana_v2, "MINHA_API_PROVIDER", "gemini"), \
                     patch.object(api.iana_v2, "GEMINI_API_KEY", "test-gemini-key"), \
                     patch.object(api.iana_v2, "GEMINI_API_URL", "https://example.test/generateContent"), \
                     patch.object(api.iana_v2.requests, "post", return_value=response) as post:
                    reply = api.iana_v2.chamar_minha_api(
                        msg_usr=prompt,
                        anexo_usr=attachment,
                    )

                self.assertEqual(reply, "Entendi o conteúdo.")
                payload = post.call_args.kwargs["json"]
                parts = payload["contents"][0]["parts"]
                self.assertEqual(parts[1]["inline_data"]["mime_type"], mime_type)
                self.assertEqual(parts[1]["inline_data"]["data"], "cG5n")
                self.assertIn("Analise diretamente", payload["systemInstruction"]["parts"][0]["text"])
                self.assertEqual(post.call_args.kwargs["timeout"], 60)

    def test_chat_passes_and_clears_uploaded_media(self):
        attachment = "data:image/png;base64," + base64.b64encode(b"png").decode("ascii")

        def pipeline_with_attachment():
            return api.iana_v2.anexo_usuario["mime_type"]

        with patch.object(api, "RUN_PIPELINE_OK", True), \
             patch.object(api.iana_v2, "run_pipeline", side_effect=pipeline_with_attachment):
            response = self.client.post(
                "/api/v1/chat",
                json={
                    "mensagem": "O que aparece?",
                    "sessao_id": "image-attachment",
                    "imagem": attachment,
                },
                headers=self.headers(),
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["resposta"], "image/png")
        self.assertIsNone(api.iana_v2.anexo_usuario)

    def test_chat_passes_uploaded_video_to_pipeline(self):
        attachment = "data:video/mp4;base64," + base64.b64encode(b"video").decode("ascii")

        def pipeline_with_video():
            return api.iana_v2.anexo_usuario["mime_type"]

        with patch.object(api, "RUN_PIPELINE_OK", True), \
             patch.object(api.iana_v2, "run_pipeline", side_effect=pipeline_with_video):
            response = self.client.post(
                "/api/v1/chat",
                json={
                    "mensagem": "O que acontece neste vídeo?",
                    "sessao_id": "video-attachment",
                    "video": attachment,
                },
                headers=self.headers(),
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["resposta"], "video/mp4")
        self.assertIsNone(api.iana_v2.anexo_usuario)

    def test_chat_rejects_invalid_uploaded_media(self):
        response = self.client.post(
            "/api/v1/chat",
            json={
                "mensagem": "O que aparece?",
                "imagem": "data:image/png;base64,not-valid!",
            },
            headers=self.headers(),
        )

        self.assertEqual(response.status_code, 400)

    def test_chat_accepts_audio_video_and_pdf_attachments(self):
        for field, mime_type in (
            ("audio", "audio/mpeg"),
            ("video", "video/mp4"),
            ("video", "video/webm"),
            ("video", "video/quicktime"),
            ("arquivo", "application/pdf"),
        ):
            with self.subTest(field=field):
                data_url = f"data:{mime_type};base64," + base64.b64encode(b"sample").decode("ascii")
                attachment = api.normalizar_anexo({field: data_url})
                self.assertEqual(attachment["mime_type"], mime_type)
                self.assertEqual(base64.b64decode(attachment["data"]), b"sample")

        with self.assertRaisesRegex(ValueError, "MP4, WebM ou MOV"):
            api.normalizar_anexo({
                "video": "data:video/x-msvideo;base64," + base64.b64encode(b"sample").decode("ascii")
            })

        recorded_audio = api.normalizar_anexo({
            "audio": "data:audio/webm;codecs=opus;base64," + base64.b64encode(b"sample").decode("ascii")
        })
        self.assertEqual(recorded_audio["mime_type"], "audio/webm")

    def test_chat_rejects_media_for_non_gemini_provider(self):
        attachment = "data:image/png;base64," + base64.b64encode(b"png").decode("ascii")
        with patch.object(api.iana_v2, "MINHA_API_PROVIDER", "custom"):
            response = self.client.post(
                "/api/v1/chat",
                json={"mensagem": "O que aparece?", "imagem": attachment},
                headers=self.headers(),
            )

        self.assertEqual(response.status_code, 503)
        self.assertIn("multimodal", response.json["mensagem"])

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

    def test_chat_passes_detected_emotion_to_pipeline(self):
        def pipeline_com_estado_emocional():
            estado = api.iana_v2.config_usuario.get("estado_emocional")
            return api.iana_v2.obter_instrucao_humor(
                api.iana_v2.msg_final,
                api.iana_v2.config_usuario,
                estado,
            )

        with patch.object(api, "RUN_PIPELINE_OK", True), \
             patch.object(api.iana_v2, "run_pipeline", side_effect=pipeline_com_estado_emocional):
            response = self.client.post(
                "/api/v1/chat",
                json={
                    "mensagem": "Me ajuda com isso.",
                    "sessao_id": "detected-emotion",
                    "estadoEmocional": "frustrado",
                },
                headers=self.headers(),
            )

        self.assertEqual(response.status_code, 200)
        self.assertIn("FRUSTRAÇÃO DETECTADA", response.json["resposta"])

    def test_chat_rejects_unknown_detected_emotion(self):
        response = self.client.post(
            "/api/v1/chat",
            json={"mensagem": "Oi", "estadoEmocional": "unknown"},
            headers=self.headers(),
        )

        self.assertEqual(response.status_code, 400)

    def test_chat_rejects_invalid_frontend_preferences(self):
        response = self.client.post(
            "/api/v1/chat",
            json={"mensagem": "Oi", "config_usuario": ["invalid"]},
            headers=self.headers(),
        )

        self.assertEqual(response.status_code, 400)

    def test_chat_passes_visual_observations_to_the_system_prompt(self):
        def pipeline_com_contexto_visual():
            system, user = api.iana_v2.construir_prompt_master("O que você está vendo?")
            return f"{system}\n{user}"

        with patch.object(api, "RUN_PIPELINE_OK", True), \
             patch.object(api.iana_v2, "run_pipeline", side_effect=pipeline_com_contexto_visual):
            response = self.client.post(
                "/api/v1/chat",
                json={
                    "mensagem": "O que você está vendo?",
                    "sessao_id": "visao-na-chamada",
                    "contexto_visual": "person (90% de confiança)",
                    "jogo_atual": "Elden Ring",
                },
                headers=self.headers(),
            )

        self.assertEqual(response.status_code, 200)
        self.assertIn("person (90% de confiança)", response.json["resposta"])
        self.assertIn("detecção YOLO genérica", response.json["resposta"])
        self.assertEqual(api.iana_v2.contexto_visual, "")
        self.assertEqual(api.iana_v2.jogo_atual, "")

    def test_visual_context_and_game_title_are_used_to_search_guides(self):
        with patch.object(api.iana_v2, "msg_final", "Onde encontro o mercador?"), \
             patch.object(api.iana_v2, "nome_usuario", "Alex"), \
             patch.object(api.iana_v2, "jogo_atual", "Elden Ring"), \
             patch.object(api.iana_v2, "contexto_visual", "person (90%, centro-meio da tela)"), \
             patch.object(api.iana_v2, "consultar_conhecimento", return_value="Guia do jogo") as knowledge, \
             patch.object(api.iana_v2, "consultar_memoria_usuario", return_value=""), \
             patch.object(api.iana_v2, "chamar_minha_api", return_value="Vou consultar o guia.") as generate, \
             patch.object(api.iana_v2, "salvar_interacao"):
            api.iana_v2.run_pipeline()

        query = knowledge.call_args.args[0]
        self.assertIn("Elden Ring", query)
        self.assertIn("Onde encontro o mercador?", query)
        self.assertIn("centro-meio da tela", query)
        self.assertEqual(generate.call_args.args[0], "Onde encontro o mercador?")

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

    def test_greeting_addressed_to_iana_is_still_casual_chat(self):
        message = "Oi Iana, está tudo funcionando?"
        self.assertTrue(api.iana_v2.mensagem_conversacional_curta(message))

        with patch.object(api.iana_v2, "msg_final", message), \
             patch.object(api.iana_v2, "nome_usuario", "Alex"), \
             patch.object(api.iana_v2, "consultar_conhecimento") as knowledge, \
             patch.object(api.iana_v2, "consultar_memoria_usuario") as memory, \
             patch.object(api.iana_v2, "chamar_minha_api", return_value=None), \
             patch.object(api.iana_v2, "salvar_interacao"):
            reply = api.iana_v2.run_pipeline()

        self.assertIn("Alex", reply)
        knowledge.assert_not_called()
        memory.assert_not_called()

    def test_context_fallback_does_not_show_raw_guide_markup(self):
        with patch.object(api.iana_v2, "contexto_conhecimento", "[ITEM: GUIA]\n{campo: valor}"), \
             patch.object(api.iana_v2, "contexto_memoria_usuario", ""):
            reply = api.iana_v2.resposta_do_contexto()

        self.assertIn("Tô com uma instabilidade", reply)
        self.assertNotIn("[ITEM:", reply)
        self.assertNotIn("{campo:", reply)
        self.assertNotIn("(", reply)

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