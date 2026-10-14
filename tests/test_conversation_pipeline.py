"""Valida chat -> memória -> próximo chat com bancos temporários e sem rede."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from textwrap import dedent


class ConversationPipelineTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database_path = directory.name
        self.project_root = Path(__file__).resolve().parents[1]

    def run_pipeline_test(self, script):
        environment = os.environ.copy()
        environment.update(
            IANA_DB_PATH=self.database_path, IANA_RAG_MODE="keyword", IANA_MYSQL_MIRROR="0",
            IANA_LOCAL_ONLY="true", IANA_API_KEY="conversation-pipeline-test-key",
        )
        result = subprocess.run(
            [sys.executable, "-c", dedent(script)], cwd=self.project_root, env=environment,
            capture_output=True, text=True, timeout=30, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_direct_cli_learns_with_stable_identity_outside_project_directory(self):
        environment = os.environ.copy()
        environment.update(
            IANA_DB_PATH=self.database_path, IANA_RAG_MODE="keyword", IANA_MYSQL_MIRROR="0",
            IANA_LOCAL_ONLY="true", IANA_USER_ID="user:cli-test", MINHA_API_PROVIDER="custom",
            MINHA_API_KEY="", MINHA_API_URL="", GEMINI_API_KEY="", IANA_API_KEY="test-cli-key",
            # O legado deve apontar para uma conexão fictícia, nunca para o banco real do .env.
            DB_HOST="127.0.0.1", DB_PORT="1", DB_USER="test", DB_PASS="test", DB_NAME="test", DB_SSL="false",
        )
        teaching = "Eu prefiro builds de DBD focadas no portão final."
        result = subprocess.run(
            [sys.executable, str(self.project_root / "core" / "iana_v2.py"),
             "Jogador CLI", "cli-chat", teaching], cwd=self.database_path, env=environment,
            capture_output=True, text=True, timeout=30, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.run_pipeline_test("""
            from core import learning_engine as engine
            documents = engine.list_documents(usuario_id='user:cli-test')
            assert len(documents) == 1, documents
            row = engine.get_document(documents[0]['id'], usuario_id='user:cli-test')
            assert row['conteudo'] == 'Eu prefiro builds de DBD focadas no portão final.', row
            assert row['metadata']['conversa_id'] == 'cli-chat'
            assert row['metadata']['usuario_id'] == 'user:cli-test'
        """)

    def test_identified_pipeline_does_not_save_assistant_output_to_legacy_memory(self):
        self.run_pipeline_test("""
            from unittest.mock import patch
            from core import app as api
            from core import learning_engine as engine
            brain = api.iana_v2
            brain.MEMORY_OK = True
            brain.identidade_usuario = 'user:1'
            brain.id_conversa = 'legacy-check'
            brain.msg_final = 'Eu prefiro builds de endgame em DBD com portões rápidos.'
            brain.historico = []
            brain.config_usuario = {}
            brain.jogo_atual = 'DBD'
            with patch.dict('os.environ', {'IANA_USER_ID': 'legacy-test'}, clear=False), \
                 patch.object(brain, 'get_memory', return_value=[]) as get_memory, \
                 patch.object(brain, 'save_memory', side_effect=AssertionError('não salvar resposta como fato')) as save_memory, \
                 patch.object(brain, 'chamar_minha_api', return_value='UMA_RESPOSTA_INVENTADA_PELA_IANA'):
                response = brain.run_pipeline()
            assert response == 'UMA_RESPOSTA_INVENTADA_PELA_IANA', response
            assert save_memory.call_count == 0, save_memory.call_args_list
            assert get_memory.call_count > 0
            row = engine.get_document(brain.ultimo_aprendizado_conversa['document_id'], usuario_id='user:1')
            assert row['conteudo'] == brain.msg_final, row
            assert 'UMA_RESPOSTA_INVENTADA_PELA_IANA' not in str(row)
        """)

    def test_chat_learning_reaches_other_conversation_only_for_same_author(self):
        self.run_pipeline_test("""
            from unittest.mock import patch
            from core import app as api
            from core import learning_engine as engine
            brain = api.iana_v2
            brain.MEMORY_OK = False
            client = api.app.test_client()
            headers = {'X-API-Key': api.IANA_API_KEY}
            with patch.object(brain.requests, 'post', side_effect=AssertionError('sem HTTP externo')) as http, \
                 patch.object(brain, 'save_memory', side_effect=AssertionError('sem MySQL')):
                teaching = 'Eu prefiro builds de endgame em DBD com saídas rápidas.'
                first = client.post('/api/v1/chat', json={
                    'mensagem': teaching, 'usuario_id': 'user:1', 'sessao_id': 'primeiro-chat',
                    'jogo_atual': 'DBD',
                }, headers=headers)
                assert first.status_code == 200, first.json
                learning = first.json['aprendizado_conversa']
                assert learning['status'] == 'NOVO', first.json
                row = engine.get_document(learning['document_id'], usuario_id='user:1')
                assert row['conteudo'] == teaching, row
                assert row['metadata']['conversa_ids'] == ['primeiro-chat']

                question = 'Qual preferência sobre endgame em DBD eu te ensinei?'
                second = client.post('/api/v1/chat', json={
                    'mensagem': question, 'usuario_id': 'user:1', 'sessao_id': 'outro-chat',
                    'jogo_atual': 'DBD',
                }, headers=headers)
                assert second.status_code == 200, second.json
                assert second.json['aprendizado_conversa']['status'] == 'IGNORADO', second.json
                assert 'saídas rápidas' in brain.contexto_conhecimento, brain.contexto_conhecimento
                assert 'relato do usuário' in brain.contexto_conhecimento

                stranger = client.post('/api/v1/chat', json={
                    'mensagem': question, 'usuario_id': 'user:2', 'sessao_id': 'outro-chat',
                    'jogo_atual': 'DBD',
                }, headers=headers)
                assert stranger.status_code == 200, stranger.json
                assert 'saídas rápidas' not in brain.contexto_conhecimento
                assert brain.historico == [], brain.historico
                assert engine.get_document(learning['document_id'], usuario_id='user:2') is None
                assert len(engine.list_documents(usuario_id='user:1')) == 1
                assert not engine.list_documents(usuario_id='user:2')
                assert http.call_count == 0
        """)

    def test_quota_and_generation_exception_do_not_prevent_learning_or_become_knowledge(self):
        self.run_pipeline_test("""
            from unittest.mock import patch
            from core import app as api
            from core import learning_engine as engine
            brain = api.iana_v2
            brain.MEMORY_OK = False
            client = api.app.test_client()
            headers = {'X-API-Key': api.IANA_API_KEY}
            def quota(*args, **kwargs):
                brain.ultimo_erro_geracao = 'quota'
                return None
            with patch.object(brain, 'chamar_minha_api', side_effect=quota):
                message = 'Minha ideia é um desafio de DBD com geradores móveis.'
                response = client.post('/api/v1/chat', json={
                    'mensagem': message, 'usuario_id': 'user:1', 'sessao_id': 'chat-quota',
                }, headers=headers)
            assert response.status_code == 200, response.json
            assert response.json['aprendizado_conversa']['status'] == 'NOVO', response.json
            assert 'limite de uso' in response.json['resposta'], response.json
            rows = engine.list_documents(usuario_id='user:1')
            assert len(rows) == 1, rows
            row = engine.get_document(rows[0]['id'], usuario_id='user:1')
            assert row['conteudo'] == message and 'limite de uso' not in row['conteudo'], row

            with patch.object(brain, 'chamar_minha_api', side_effect=RuntimeError('geração indisponível')):
                other = 'Eu prefiro respostas curtas para minhas ideias de DBD.'
                failed_generation = client.post('/api/v1/chat', json={
                    'mensagem': other, 'usuario_id': 'user:1', 'sessao_id': 'chat-exception',
                }, headers=headers)
            assert failed_generation.status_code == 200, failed_generation.json
            assert failed_generation.json['aprendizado_conversa']['status'] == 'NOVO', failed_generation.json
            rows = engine.list_documents(usuario_id='user:1')
            assert len(rows) == 2, rows
            content = {engine.get_document(row['id'], usuario_id='user:1')['conteudo'] for row in rows}
            assert content == {message, other}, content
            assert brain.identidade_usuario is None
        """)

    def test_opt_out_and_greetings_leave_knowledge_unchanged(self):
        self.run_pipeline_test("""
            from core import app as api
            from core import learning_engine as engine
            brain = api.iana_v2
            brain.MEMORY_OK = False
            client = api.app.test_client()
            headers = {'X-API-Key': api.IANA_API_KEY}
            disabled = client.post('/api/v1/chat', json={
                'mensagem': 'Eu prefiro builds de endgame em DBD.', 'usuario_id': 'user:1',
                'sessao_id': 'private', 'config_usuario': {'aprender_conversas': False},
            }, headers=headers)
            assert disabled.status_code == 200, disabled.json
            assert disabled.json['aprendizado_conversa'] is None, disabled.json
            greeting = client.post('/api/v1/chat', json={
                'mensagem': 'Oi Iana!', 'usuario_id': 'user:1', 'sessao_id': 'greeting',
            }, headers=headers)
            assert greeting.status_code == 200, greeting.json
            assert greeting.json['aprendizado_conversa']['status'] == 'IGNORADO', greeting.json
            assert engine.knowledge_status(usuario_id='user:1')['documentos'] == 0
        """)


if __name__ == '__main__':
    unittest.main()
