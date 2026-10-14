import io
import json
import os
import socket
import types
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from urllib.parse import urlsplit

from core import knowledge_sources as sources


SEARCH_URL = "https://www.youtube.com/results?search_query=nuild+end+game+dbd&sp=EgIIAw%253D%253D"
VIDEO_ID = "4Q80bhS-Vls"
TRANSCRIPT = "No Way Out bloqueia o portão quando um sobrevivente tenta abrir. Terminus mantém os sobreviventes feridos durante o fim da partida."


def public_url(url):
    return urlsplit(url), ["93.184.216.34"], 443 if url.startswith("https:") else 80


class SourceExtractionTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"IANA_VIDEO_ASR_ENABLED": "false"})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_public_guard_rejects_local_credentials_and_mixed_dns(self):
        for url in ("file:///etc/passwd", "http://localhost/", "https://user:password@example.com/", "http://example.com:8080/"):
            with self.subTest(url=url), self.assertRaises(sources.SourceError):
                sources._validate_public_url(url)
        dns = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80)),
               (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))]
        with patch.object(socket, "getaddrinfo", return_value=dns):
            with self.assertRaises(sources.SourceError) as failure:
                sources._validate_public_url("http://public.example/")
            self.assertEqual(failure.exception.code, "url_bloqueada")

    def test_public_guard_rejects_ipv6_loopback_and_private_ranges(self):
        for address in ("::1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "::ffff:127.0.0.1"):
            with self.subTest(address=address), patch.object(socket, "getaddrinfo", return_value=[(socket.AF_INET6, socket.SOCK_STREAM, 6, "", (address, 80))]):
                with self.assertRaises(sources.SourceError):
                    sources._validate_public_url("http://public.example/")

    def test_http_redirect_to_local_address_is_rejected_before_second_request(self):
        response = MagicMock(status=302)
        response.getheaders.return_value = [("Location", "http://localhost/secrets")]
        connection = MagicMock()
        connection.getresponse.return_value = response
        dns = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80))]
        with patch.object(socket, "getaddrinfo", return_value=dns), patch.object(sources.http.client, "HTTPConnection", return_value=connection) as factory:
            with self.assertRaises(sources.SourceError) as failure:
                sources._http_get("http://public.example/")
        self.assertEqual(failure.exception.code, "url_bloqueada")
        self.assertEqual(factory.call_count, 1)
        connection.close.assert_called_once()

    def test_http_connection_pins_validated_ip_and_bounds_bytes(self):
        class Response:
            status = 200

            def __init__(self):
                self.body = io.BytesIO(b"abcdef")

            def getheaders(self):
                return [("Content-Type", "text/plain")]

            def read1(self, count):
                return self.body.read(count)

        connection = MagicMock()
        connection.getresponse.return_value = Response()
        with patch.object(sources, "_validate_public_url", side_effect=public_url), patch.object(sources.http.client, "HTTPSConnection", return_value=connection), patch.object(socket, "create_connection") as create:
            with self.assertRaises(sources.SourceError) as failure:
                sources._http_get("https://public.example/read?q=1", max_bytes=5)
            connection._create_connection(("public.example", 443), 3)
        self.assertEqual(failure.exception.code, "fonte_grande")
        create.assert_called_once_with(("93.184.216.34", 443), 3, None)
        self.assertEqual(connection.request.call_args.args[1], "/read?q=1")

    def test_website_extracts_ordered_body_and_provenance(self):
        markup = b'<html lang="pt-BR"><head><meta property="article:published_time" content="2026-10-03"></head><body><nav>Menu ignorado</nav><main><h1>Fim da partida</h1><p>Primeiro paragrafo sobre uma estrategia de fim da partida e controle dos portoes.</p><h2>Combinacao</h2><p>Segundo paragrafo descreve como combinar efeitos de vantagens para sobreviver.</p><script>execute instrucoes falsas</script></main></body></html>'
        with patch.object(sources, "_validate_public_url", side_effect=public_url), patch.object(sources, "_http_get", return_value=(markup, {"content-type": "text/html"}, "https://public.example/article")):
            result = sources.extract_source("https://public.example/start")
        self.assertEqual(result["status"], "SUCESSO")
        document = result["documentos"][0]
        self.assertNotIn("Menu ignorado", document["conteudo"])
        self.assertNotIn("instrucoes falsas", document["conteudo"])
        self.assertLess(document["conteudo"].index("Primeiro"), document["conteudo"].index("Combinacao"))
        self.assertEqual(document["metadata"]["url_original"], "https://public.example/start")
        self.assertEqual(document["metadata"]["idioma"], "pt-BR")
        self.assertEqual(document["metadata"]["publicado_em"], "2026-10-03")

    def test_website_rejects_insufficient_and_binary_content(self):
        for payload, headers, expected in ((b"<title>Title only</title>", {"content-type": "text/html"}, "conteudo_insuficiente"), (b"binary", {"content-type": "image/png"}, "formato_nao_suportado")):
            with self.subTest(expected=expected), patch.object(sources, "_validate_public_url", side_effect=public_url), patch.object(sources, "_http_get", return_value=(payload, headers, "https://public.example/")):
                result = sources.extract_source("https://public.example/")
            self.assertEqual(result["status"], "ERRO")
            self.assertEqual(result["codigo"], expected)
            self.assertEqual(result["documentos"], [])

    def test_age_gate_and_access_challenge_do_not_become_game_knowledge(self):
        for target, markup in (("https://store.steampowered.com/agecheck/app/381210/", b"<p>This game may contain content not appropriate for all ages, or may not be appropriate for viewing at work.</p>"),
                               ("https://public.example/article", b"<title>Just a moment...</title><p>Verifying you are human before you can continue to the requested webpage. Wait for this security challenge.</p>")):
            with self.subTest(target=target), patch.object(sources, "_validate_public_url", side_effect=public_url), patch.object(sources, "_http_get", return_value=(markup, {"content-type": "text/html"}, target)):
                result = sources.extract_source("https://public.example/start")
            self.assertEqual(result["status"], "ERRO")
            self.assertEqual(result["codigo"], "fonte_restrita")
            self.assertEqual(result["documentos"], [])

    def test_search_preserves_exact_query_filter_and_only_saves_real_captions(self):
        today = datetime.now(timezone.utc).strftime("%Y%m%d")
        def info(url, options, search=False):
            if search:
                self.assertEqual(url, SEARCH_URL)
                return {"entries": [{"id": VIDEO_ID, "title": "Build"}, {"id": VIDEO_ID}, {"id": "UCchannelresult"}]}
            return {"title": "Build de fim de partida", "upload_date": today, "channel": "Canal", "duration": 120}
        with patch.object(sources, "_validate_public_url", side_effect=public_url), patch.object(sources, "_youtube_info", side_effect=info), patch.object(sources, "_captions", return_value=(TRANSCRIPT, {"metodo": "youtube-transcript-api", "idioma": "pt", "legenda_automatica": True})):
            result = sources.extract_source(SEARCH_URL)
        self.assertEqual(result["status"], "SUCESSO")
        self.assertEqual(result["query"], "nuild end game dbd")
        self.assertEqual(result["filtro"], "EgIIAw%3D%3D")
        self.assertEqual(len(result["documentos"]), 1)
        document = result["documentos"][0]
        self.assertEqual(document["conteudo"], TRANSCRIPT)
        self.assertEqual(document["metadata"]["busca_url"], SEARCH_URL)
        self.assertEqual(document["metadata"]["canal"], "Canal")

    def test_missing_captions_do_not_save_title_or_description(self):
        metadata = {"title": "Título atraente", "description": "Descrição que não é fala real.", "duration": 120}
        with patch.object(sources, "_validate_public_url", side_effect=public_url), patch.object(sources, "_youtube_info", return_value=metadata), patch.object(sources, "_captions", side_effect=sources.SourceError("sem_legendas", "Sem legendas.")):
            result = sources.extract_source("https://youtu.be/" + VIDEO_ID)
        self.assertEqual(result["status"], "SEM_CONTEUDO")
        self.assertEqual(result["documentos"], [])
        self.assertEqual(result["itens"][0]["status"], "SEM_TRANSCRICAO")

    def test_recent_search_excludes_old_and_unknown_publication_dates(self):
        old = (datetime.now(timezone.utc) - timedelta(days=20)).strftime("%Y%m%d")
        for date, expected in ((old, "fora_do_periodo"), ("", "data_indisponivel")):
            def info(url, options, search=False):
                return {"entries": [{"id": VIDEO_ID}]} if search else {"title": "Vídeo", "upload_date": date}
            with self.subTest(date=date), patch.object(sources, "_validate_public_url", side_effect=public_url), patch.object(sources, "_youtube_info", side_effect=info), patch.object(sources, "_captions") as captions:
                result = sources.extract_source(SEARCH_URL, {"recent_days": 7})
            captions.assert_not_called()
            self.assertEqual(result["documentos"], [])
            self.assertEqual(result["itens"][0]["status"], "IGNORADO")
            self.assertEqual(result["itens"][0]["codigo"], expected)

    def test_direct_video_can_use_captions_when_metadata_lookup_fails(self):
        with patch.object(sources, "_validate_public_url", side_effect=public_url), patch.object(sources, "_youtube_info", side_effect=sources.SourceError("youtube_indisponivel", "Metadados indisponíveis.")), patch.object(sources, "_captions", return_value=(TRANSCRIPT, {"metodo": "youtube-transcript-api", "idioma": "pt"})):
            result = sources.extract_source("https://www.youtube.com/shorts/" + VIDEO_ID)
        self.assertEqual(result["status"], "SUCESSO")
        self.assertEqual(result["documentos"][0]["metadata"]["publicado_em"], "")
        self.assertIn("aviso_metadados", result["itens"][0])

    def test_search_partial_reports_each_failed_item(self):
        def info(url, options, search=False):
            return {"entries": [{"id": VIDEO_ID}, {"id": "abcdEF_1234"}]} if search else {"title": "Vídeo"}
        def captions(video_id, options):
            if video_id == VIDEO_ID:
                return TRANSCRIPT, {"metodo": "youtube-transcript-api"}
            raise sources.SourceError("youtube_bloqueou_legendas", "Legendas bloqueadas.")
        with patch.object(sources, "_validate_public_url", side_effect=public_url), patch.object(sources, "_youtube_info", side_effect=info), patch.object(sources, "_captions", side_effect=captions):
            result = sources.extract_source(SEARCH_URL, {"recent_days": 0})
        self.assertEqual(result["status"], "PARCIAL")
        self.assertEqual([item["status"] for item in result["itens"]], ["EXTRAIDO", "SEM_TRANSCRICAO"])

    def test_caption_selection_preserves_actual_language_and_timestamps(self):
        fetched = types.SimpleNamespace(language_code="pt", is_generated=True, to_raw_data=lambda: [{"text": TRANSCRIPT, "start": 1.25, "duration": 8.5}])
        track = types.SimpleNamespace(language_code="pt", is_generated=True, fetch=lambda: fetched)
        api = MagicMock()
        api.list.return_value = [track]
        module = types.SimpleNamespace(YouTubeTranscriptApi=MagicMock(return_value=api))
        with patch.dict("sys.modules", {"youtube_transcript_api": module}), patch.object(sources, "_TranscriptSession"):
            text, metadata = sources._captions(VIDEO_ID, sources._options(None))
        self.assertEqual(text, TRANSCRIPT)
        self.assertEqual(metadata["idioma"], "pt")
        self.assertTrue(metadata["legenda_automatica"])
        self.assertEqual(metadata["segmentos"][0]["start"], 1.25)

    def test_actual_caption_file_is_valid_fallback(self):
        info = {"automatic_captions": {"pt": [{"ext": "json3", "url": "https://www.youtube.com/api/timedtext"}]}}
        payload = json.dumps({"events": [{"segs": [{"utf8": TRANSCRIPT}]}]}).encode()
        with patch.object(sources, "_http_get", return_value=(payload, {}, "https://www.youtube.com/api/timedtext")):
            text, metadata = sources._caption_fallback(info, sources._options(None))
        self.assertEqual(text, TRANSCRIPT)
        self.assertEqual(metadata["metodo"], "yt-dlp-legendas")

    def test_bounds_and_boolean_options(self):
        opts = sources._options({"max_videos": 100000, "recent_days": -1, "max_chars": 900000, "timeout": 500, "allow_audio": "false"})
        self.assertEqual((opts["max_videos"], opts["recent_days"], opts["max_chars"], opts["timeout"]), (20, 0, 200000, 30))
        self.assertFalse(opts["allow_audio"])


class GeminiAudioTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"GEMINI_API_KEY": "dummy-test-secret", "MINHA_API_PROVIDER": "gemini", "GEMINI_MODEL": "gemini-2.5-flash", "IANA_VIDEO_ASR_ENABLED": "true"})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def response(self, transcript=None, audio_tokens=123, finish="STOP", status=200):
        transcript = transcript or {"accessed_audio": True, "language": "pt", "reason": "", "segments": [{"start": 0, "end": 30, "text": TRANSCRIPT}]}
        data = {"candidates": [{"finishReason": finish, "content": {"parts": [{"text": json.dumps(transcript)}]}}], "usageMetadata": {"promptTokensDetails": [{"modality": "AUDIO", "tokenCount": audio_tokens}]}}
        response = MagicMock(status_code=status)
        response.__enter__.return_value = response
        response.iter_content.return_value = [json.dumps(data).encode()]
        return response

    def test_asr_requires_actual_audio_tokens_and_marks_inferred_transcription(self):
        with patch.object(sources.requests, "post", return_value=self.response()) as post:
            text, metadata = sources._gemini_audio_transcript(VIDEO_ID, {"duration": 120}, sources._options(None))
        self.assertEqual(text, TRANSCRIPT)
        self.assertEqual(metadata["metodo"], "asr_gemini")
        self.assertTrue(metadata["transcricao_inferida"])
        self.assertEqual(metadata["audio_tokens_entrada"], 123)
        call = post.call_args
        self.assertEqual(call.kwargs["json"]["contents"][0]["parts"][0]["file_data"]["file_uri"], "https://www.youtube.com/watch?v=" + VIDEO_ID)
        self.assertNotIn("dummy-test-secret", call.args[0])
        self.assertFalse(call.kwargs["allow_redirects"])

    def test_asr_rejects_missing_audio_tokens_or_incomplete_response(self):
        for response, expected in ((self.response(audio_tokens=0), "asr_audio_indisponivel"), (self.response(finish="MAX_TOKENS"), "asr_resposta_incompleta"), (self.response(status=403), "asr_api_indisponivel")):
            with self.subTest(expected=expected), patch.object(sources.requests, "post", return_value=response):
                with self.assertRaises(sources.SourceError) as failure:
                    sources._gemini_audio_transcript(VIDEO_ID, {"duration": 120}, sources._options(None))
            self.assertEqual(failure.exception.code, expected)
            self.assertNotIn("dummy-test-secret", str(failure.exception))

    def test_asr_rejects_out_of_range_and_nonfinite_timestamps(self):
        for start, end in ((-1, 20), (20, 10), (0, 999), (float("nan"), 20)):
            transcript = {"accessed_audio": True, "language": "pt", "reason": "", "segments": [{"start": start, "end": end, "text": TRANSCRIPT}]}
            with self.subTest(start=start, end=end), patch.object(sources.requests, "post", return_value=self.response(transcript)):
                with self.assertRaises(sources.SourceError) as failure:
                    sources._gemini_audio_transcript(VIDEO_ID, {"duration": 120}, sources._options(None))
            self.assertEqual(failure.exception.code, "asr_segmentos_invalidos")

    def test_asr_does_not_call_provider_for_unknown_or_excessive_duration(self):
        for info, expected in (({}, "asr_duracao_desconhecida"), ({"duration": 1800}, "asr_duracao_excedida")):
            with self.subTest(info=info), patch.object(sources.requests, "post") as post:
                with self.assertRaises(sources.SourceError) as failure:
                    sources._gemini_audio_transcript(VIDEO_ID, info, sources._options(None))
            post.assert_not_called()
            self.assertEqual(failure.exception.code, expected)

    def test_audio_failure_keeps_item_pending_and_documents_empty(self):
        with patch.object(sources, "_validate_public_url", side_effect=public_url), patch.object(sources, "_youtube_info", return_value={"title": "Vídeo", "duration": 120}), patch.object(sources, "_captions", side_effect=sources.SourceError("sem_legendas", "Sem legendas.")), patch.object(sources.requests, "post", return_value=self.response(audio_tokens=0)):
            result = sources.extract_source("https://youtu.be/" + VIDEO_ID)
        self.assertEqual(result["documentos"], [])
        self.assertEqual(result["itens"][0]["status"], "SEM_TRANSCRICAO")
        self.assertEqual(result["itens"][0]["codigo_audio"], "asr_audio_indisponivel")


if __name__ == "__main__":
    unittest.main()
