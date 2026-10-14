import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from textwrap import dedent


class ConversationLearningTests(unittest.TestCase):
    """Cada execução usa um SQLite temporário, nunca a memória real da Iana."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database_path = directory.name
        self.project_root = Path(__file__).resolve().parents[1]

    def run_learning(self, script):
        environment = os.environ.copy()
        environment.update(IANA_DB_PATH=self.database_path, IANA_RAG_MODE="keyword", IANA_MYSQL_MIRROR="0")
        result = subprocess.run(
            [sys.executable, "-c", dedent(script)], cwd=self.project_root, env=environment,
            capture_output=True, text=True, timeout=30, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_user_teaching_enters_same_persistent_engine_without_generation_api(self):
        self.run_learning("""
            import sys
            from core.conversation_learning import learn_from_message
            from core import learning_engine as e
            result = learn_from_message('Eu prefiro jogar de sobrevivente em DBD.', 7, 'chat-a', 'DBD')
            assert result['status'] == 'NOVO', result
            row = e.get_document(result['document_id'], usuario_id='7')
            assert row['conteudo'] == 'Eu prefiro jogar de sobrevivente em DBD.'
            assert row['categoria'] == 'conversa_usuario'
            assert row['metadata']['usuario_id'] == '7'
            assert row['metadata']['conversa_id'] == 'chat-a'
            assert row['metadata']['conversa_ids'] == ['chat-a']
            assert row['metadata']['escopo'] == 'usuario'
            assert row['metadata']['natureza'] == 'relato_usuario'
            assert row['metadata']['tipo'] == 'conversa'
            assert row['metadata']['jogo'] == 'DBD'
            assert row['metadata']['extraido_em'].endswith('+00:00')
            assert not any(name.startswith('google.genai') for name in sys.modules)
            assert e.knowledge_status(usuario_id='7')['documentos'] == 1
        """)

    def test_repeat_content_keeps_one_document_and_all_conversation_origins(self):
        self.run_learning("""
            from core.conversation_learning import learn_from_message as save
            from core import learning_engine as e
            first = save('Prefiro português.', 'alice', 'chat-a')
            repeat = save('  PREFIRO   PORTUGUÊS.  ', 'alice', 'chat-a')
            second_chat = save('Prefiro português.', 'alice', 'chat-b')
            assert first['status'] == 'NOVO', first
            assert repeat['status'] == 'EXISTE', repeat
            assert second_chat['status'] == 'ATUALIZADO', second_chat
            assert first['document_id'] == repeat['document_id'] == second_chat['document_id']
            row = e.get_document(first['document_id'], usuario_id='alice')
            assert row['metadata']['conversa_id'] == 'chat-a'
            assert row['metadata']['conversa_ids'] == ['chat-a', 'chat-b']
            assert row['conteudo'] == 'Prefiro português.'
            assert e.knowledge_status(usuario_id='alice')['documentos'] == 1
        """)

    def test_different_authors_have_separate_documents(self):
        self.run_learning("""
            from core.conversation_learning import learn_from_message as save
            from core import learning_engine as e
            a = save('Eu gosto de builds de endgame.', 'alice', 'chat')
            b = save('Eu gosto de builds de endgame.', 'bob', 'chat')
            assert a['status'] == b['status'] == 'NOVO', (a, b)
            assert a['document_id'] != b['document_id']
            assert e.get_document(a['document_id'], usuario_id='bob') is None
            assert e.get_document(b['document_id'], usuario_id='alice') is None
            assert e.knowledge_status(usuario_id='alice')['documentos'] == 1
            assert e.knowledge_status(usuario_id='bob')['documentos'] == 1
            assert e.knowledge_status()['documentos'] == 0
        """)

    def test_restart_keeps_learning_available_alongside_extracted_sources(self):
        self.run_learning("""
            from core.conversation_learning import learn_from_message as save
            from core import learning_engine as e
            result = save('Minha ideia usa geradores móveis que mudam de corredor.', 'alice', 'chat-a')
            assert result['status'] == 'NOVO', result
            assert e.learn('Guia de geradores', 'Geradores devem ser reparados durante a partida.',
                           'site', 'guia', 'https://example.test/geradores') == 'NOVO'
        """)
        self.run_learning("""
            from core.conversation_learning import learn_from_message as save
            from core import learning_engine as e
            result = save('Minha ideia usa geradores móveis que mudam de corredor.', 'alice', 'chat-b')
            row = e.get_document(result['document_id'], usuario_id='alice')
            assert row['metadata']['conversa_ids'] == ['chat-a', 'chat-b']
            mine = e.buscar_conhecimento('geradores', usuario_id='alice')
            assert 'geradores móveis' in mine and 'relato do usuário' in mine, mine
            assert 'https://example.test/geradores' in mine, mine
            others = e.buscar_conhecimento('geradores', usuario_id='bob')
            assert 'geradores móveis' not in others and 'https://example.test/geradores' in others, others
            assert e.knowledge_status(usuario_id='alice')['documentos'] == 2
            assert e.knowledge_status(usuario_id='bob')['documentos'] == 1
        """)

    def test_correction_context_comes_only_from_user_and_remains_a_report(self):
        self.run_learning("""
            from core.conversation_learning import learn_from_message as save
            from core import learning_engine as e
            history = [
                {'role': 'user', 'content': 'A duração da minha habilidade é de cinco segundos.'},
                {'role': 'assistant', 'content': 'QUOTA_EXCEEDED e uma resposta inventada.'},
                {'role': 'user', 'content': 'Na verdade, são três segundos.'},
            ]
            result = save('Na verdade, são três segundos.', 'alice', 'chat', history=history)
            assert result['status'] == 'NOVO', result
            row = e.get_document(result['document_id'], usuario_id='alice')
            assert 'minha habilidade' in row['conteudo']
            assert 'Na verdade, são três segundos.' in row['conteudo']
            assert 'QUOTA_EXCEEDED' not in row['conteudo']
            assert 'resposta inventada' not in row['conteudo']
            assert row['metadata']['natureza'] == 'relato_usuario'
            other = save('Na verdade, são três segundos.', 'alice', 'chat-2', history=[
                {'role': 'user', 'content': 'O meu novo projeto deve ter uma animação de dois segundos.'}
            ])
            assert other['document_id'] != result['document_id'], other
        """)

    def test_greetings_questions_commands_and_provider_errors_are_not_learning(self):
        self.run_learning("""
            from core.conversation_learning import learn_from_message as save
            from core import learning_engine as e
            for message in ('Oi Iana!', 'Bom dia', 'Tudo bem?', 'Obrigado', 'continue',
                            'Qual a melhor build de DBD?', 'Como eu crio um site', 'Qual meu nome',
                            'Você acha que minha build é boa?', 'Eu posso criar um jogo?',
                            'Iana, como eu crio um site', 'Olá Iana, crie meu site',
                            'Crie um site para meu jogo.', 'Mostre builds de endgame.',
                            'ResourceExhausted: Quota exceeded for Gemini API.'):
                result = save(message, 'alice', 'chat')
                assert result['status'] == 'IGNORADO', (message, result)
            assert e.knowledge_status()['documentos'] == 0
            mixed = save('Qual build usar? Eu prefiro jogar de killer.', 'alice', 'chat')
            assert mixed['status'] == 'NOVO', mixed
        """)

    def test_secrets_are_never_persisted_even_with_learning_or_history(self):
        self.run_learning("""
            from core.conversation_learning import learn_from_message as save
            from core import learning_engine as e
            for message in ('Minha senha é segredoespecial123', 'Eu uso api_key=supersecreto',
                            'Minha chave da API: segredo123', 'Eu uso token: secreto',
                            'Eu uso GEMINI_API_KEY=segredo123', 'Eu uso Bearer segredo123456',
                            'Eu uso sk-' + 'a' * 24,
                            'Eu uso https://alice:senha@service.test'):
                result = save(message, 'alice', 'chat')
                assert result['status'] == 'IGNORADO' and result['reason'] == 'credencial', (message, result)
            result = save('Lembre que prefiro respostas curtas.', 'alice', 'chat', history=[
                {'role': 'user', 'content': 'Minha senha é segredoespecial123'},
                {'role': 'assistant', 'content': 'Minha senha é resposta_do_assistente'},
            ])
            assert result['status'] == 'NOVO', result
            row = e.get_document(result['document_id'], usuario_id='alice')
            assert 'segredoespecial123' not in str(row)
            assert 'resposta_do_assistente' not in str(row)
            assert e.knowledge_status(usuario_id='alice')['documentos'] == 1
        """)

    def test_missing_identity_and_storage_error_do_not_pretend_learning(self):
        self.run_learning("""
            from unittest.mock import patch
            from core.conversation_learning import learn_from_message as save
            assert save('Prefiro português.', None, 'chat')['status'] == 'IGNORADO'
            assert save('Prefiro português.', 'alice', None)['status'] == 'IGNORADO'
            with patch('core.conversation_learning.learning_engine.get_document', side_effect=OSError('disco')):
                result = save('Prefiro português.', 'alice', 'chat')
                assert result == {'status': 'ERRO', 'document_id': None, 'reason': 'falha_memoria'}
        """)


if __name__ == '__main__':
    unittest.main()
