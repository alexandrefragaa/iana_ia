import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from textwrap import dedent


class LightweightRagTests(unittest.TestCase):
    def setUp(self):
        self.project_root = Path(__file__).resolve().parents[1]
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.database_path = Path(self.directory.name)

    def run_engine(self, script, mode="keyword"):
        environment = os.environ.copy()
        environment.update(IANA_RAG_MODE=mode, IANA_DB_PATH=str(self.database_path), IANA_MYSQL_MIRROR="0")
        result = subprocess.run(
            [sys.executable, "-c", dedent(script)], cwd=self.project_root, env=environment,
            capture_output=True, text=True, timeout=30, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        return result

    def test_keyword_mode_skips_ml_imports_and_preserves_sources(self):
        self.run_engine("""
            import sys
            from core import learning_engine as engine
            assert engine.RAG_MODE == "keyword"
            assert engine.chromadb is None
            assert engine.SentenceTransformer is None
            assert engine.learn("Lago", "O lago fica ao norte do castelo.", "local", "lago",
                                "https://example.test/mapa", {"published_at": "2026-10-05"}) == "NOVO"
            assert engine.learn("Mercador", "O mercador fica perto do mercado.", "personagem", "mercador") == "NOVO"
            resultados = engine.buscar_resultados("Onde fica o lago?", 5)
            assert resultados[0]["metadata"]["titulo"] == "Lago"
            assert resultados[0]["metadata"]["doc_id"] == "lago"
            assert resultados[0]["metadata"]["url"] == "https://example.test/mapa"
            contexto = engine.buscar_conhecimento("lago")
            assert "Fonte: https://example.test/mapa" in contexto
            assert "Publicado em: 2026-10-05" in contexto
            assert engine.status_memoria()["fallback"] is True
            assert engine.knowledge_status()["sqlite"] is True
            for module in ("torch", "chromadb", "sentence_transformers", "pymysql"):
                assert module not in sys.modules, module
        """)

    def test_persistence_restart_and_repeat_source_deduplication(self):
        self.run_engine("""
            from core import learning_engine as e
            assert e.learn("Build", "Adrenalina ajuda no fim de partida.", "video", "v1",
                           "https://example.test/video", {"channel": "Canal", "languages": ["pt", "en"]}) == "NOVO"
        """)
        self.run_engine("""
            from core import learning_engine as e
            assert e.documento_existe("v1")
            assert e.learn("Build", "Adrenalina ajuda no fim de partida.", "video", "outro-id",
                           "https://example.test/video") == "EXISTE"
            assert e.documento_existe("outro-id")
            assert e.knowledge_status()["documentos"] == 1
            row = e.list_documents()[0]
            assert row["metadata"]["channel"] == "Canal"
            assert row["metadata"]["languages"] == ["pt", "en"]
            assert e.buscar_resultados("Adrenalina")[0]["metadata"]["doc_id"] == "v1"
        """)

    def test_same_content_different_sources_keeps_both_provenances(self):
        self.run_engine("""
            from core import learning_engine as e
            assert e.learn("Fonte A", "Portão aberto ao final da partida.", "site", "a", "https://a.test") == "NOVO"
            assert e.learn("Fonte B", "Portão aberto ao final da partida.", "site", "b", "https://b.test") == "NOVO"
            assert {r["metadata"]["url"] for r in e.buscar_resultados("portão")} == {"https://a.test", "https://b.test"}
        """)

    def test_collection_timestamp_refresh_does_not_recreate_chunks(self):
        self.run_engine("""
            from unittest.mock import patch
            from core import learning_engine as e
            with patch.object(e.time, "time", return_value=100):
                assert e.learn("Vídeo", "Mesmo conteúdo documentado.", "video", "v", "https://video.test",
                               {"extraido_em": "2026-10-06", "published_at": "2026-10-05"}) == "NOVO"
            with patch.object(e.time, "time", return_value=200), patch.object(e, "_substituir_chunks", side_effect=AssertionError("não recriar")):
                assert e.learn("Vídeo", "Mesmo conteúdo documentado.", "video", "v", "https://video.test",
                               {"extraido_em": "2026-10-07", "published_at": "2026-10-05"}) == "EXISTE"
            row = e.list_documents()[0]
            assert row["metadata"]["extraido_em"] == "2026-10-07"
            assert row["atualizado_em"] == 100
            assert e.knowledge_status()["documentos"] == 1
            assert e.knowledge_status()["chunks"] == 1
        """)

    def test_updates_remove_all_old_chunks_and_failed_update_rolls_back(self):
        self.run_engine("""
            from unittest.mock import patch
            from core import learning_engine as e
            assert e.learn("Antigo", "estratégia antigaexclusive " * 1000, "video", "v") == "NOVO"
            assert e.knowledge_status()["chunks"] > 1
            assert e.learn("Novo", "Novaconclusao atualizado.", "video", "v") == "ATUALIZADO"
            assert e.knowledge_status()["chunks"] == 1
            assert not e.buscar_resultados("antigaexclusive")
            assert "Novaconclusao" in e.buscar_resultados("Novaconclusao")[0]["documento"]
            with patch.object(e, "_substituir_chunks", side_effect=RuntimeError("disco falhou")):
                assert e.learn("Ruim", "Nunca deve ficar salvo.", "video", "v") == "ERRO"
            assert e.list_documents()[0]["titulo"] == "Novo"
            assert "Novaconclusao" in e.buscar_resultados("Novaconclusao")[0]["documento"]
            assert not e.buscar_resultados("Nunca")
        """)

    def test_concurrent_ingestion_never_loses_sources(self):
        self.run_engine("""
            from concurrent.futures import ThreadPoolExecutor
            from core import learning_engine as e
            def save(index):
                return e.learn(f"Fonte {index}", f"conteudo persistente valor{index}", "site", f"d{index}")
            with ThreadPoolExecutor(max_workers=8) as pool:
                statuses = list(pool.map(save, list(range(30)) * 2))
            assert all(status in {"NOVO", "EXISTE"} for status in statuses), statuses
            assert e.knowledge_status()["documentos"] == 30
            assert e.knowledge_status()["chunks"] == 30
            assert len(e.list_documents(limit=500)) == 30
            assert len(e.list_documents(limit=10, offset=20)) == 10
        """)

    def test_imports_legacy_json_once_without_overwriting_updates(self):
        legacy = [{"id": "legacy", "titulo": "Fonte antiga", "categoria": "video",
                   "conteudo": "TÍTULO: Fonte antiga\n\nCATEGORIA: video\n\nFONTE: Local\n\nCONTEÚDO:\nConclusão original.",
                   "url": "https://example.test/legacy", "atualizado_em": 123}]
        (self.database_path / "memoria_fallback.json").write_text(json.dumps(legacy), encoding="utf-8")
        self.run_engine("""
            from core import learning_engine as e
            assert e.knowledge_status()["documentos"] == 1
            assert e.buscar_resultados("original")[0]["documento"] == "Conclusão original."
            assert e.list_documents()[0]["metadata"]["imported_from"] == "memoria_fallback.json"
            assert e.learn("Fonte antiga", "Conclusão revisada.", "video", "legacy", "https://example.test/legacy") == "ATUALIZADO"
        """)
        self.run_engine("""
            from core import learning_engine as e
            assert e.knowledge_status()["documentos"] == 1
            assert not e.buscar_resultados("original")
            assert e.buscar_resultados("revisada")
            assert e.remover_documento("legacy")
            assert e.knowledge_status()["chunks"] == 0
        """)
        self.run_engine("""
            from core import learning_engine as e
            assert e.knowledge_status()["documentos"] == 0
        """)

    def test_portuguese_english_accent_and_domain_ranking(self):
        self.run_engine("""
            from core import learning_engine as e
            e.learn("End Game Survivor Build", "Adrenaline opens the gates during endgame. Survivor strategy.", "video", "a")
            e.learn("Geradores", "Os geradores precisam de reparos e ferramentas.", "site", "b")
            assert e.buscar_resultados("estratégia de sobrevivente no fim de partida")[0]["metadata"]["doc_id"] == "a"
            assert e.buscar_resultados("generator repair")[0]["metadata"]["doc_id"] == "b"
            assert e.buscar_resultados("GERADORES")[0]["metadata"]["doc_id"] == "b"
            assert not e.buscar_resultados("qual é onde")
            assert not e.buscar_resultados("astronautaabsolutamentedesconhecido")
        """)

    def test_dbd_transcript_query_ranks_endgame_sources_above_unrelated_instructions(self):
        self.run_engine("""
            from unittest.mock import Mock
            from core import learning_engine as e
            transcript_meta = {"query": "nuild end game dbd", "metodo": "youtube-transcript-api"}
            e.learn("I Found DBD's Most HATED Endgame Build", "Endgame build with No Way Out and Terminus. Gate strategy.",
                    "youtube", "endgame-a", "https://www.youtube.com/watch?v=4Q80bhS-Vls", transcript_meta)
            e.learn("This INSANE Solo Queue Endgame Build Got BUFFED?!", "Endgame survivor build: Wake Up Adrenaline Babysitter.",
                    "youtube", "endgame-b", "https://www.youtube.com/watch?v=Phd5WFbd5T4", transcript_meta)
            e.learn("Melhores Builds de Sobreviventes em DBD", "Dead by Daylight survivor builds for generators.", "site", "general")
            distracting = "Usando vídeos, transcrições aprendidas, desenvolva uma ideia diferente. Explique fatos, proposta e testar. Cite vídeos usados. " * 100
            e.learn("Guia Resident Evil 4", distracting + "Resident Evil 4 Leon.", "site", "re4")
            e.learn("Robôs de Fastcompany", distracting + "Humanoid robot build ideas.", "site", "robot")
            query = "Usando as transcrições de vídeos aprendidas sobre endgame em DBD, desenvolva uma ideia de build diferente. Explique quais fatos vêm das transcrições, qual é sua proposta e como testar. Cite os vídeos usados. Não busque online."
            assert e._tokens(query) == ["endgame", "dbd", "build"], e._tokens(query)
            results = e.buscar_resultados(query, 6)
            assert {row["metadata"]["doc_id"] for row in results[:2]} == {"endgame-a", "endgame-b"}, results
            assert not {"re4", "robot"} & {row["metadata"]["doc_id"] for row in results}
            assert {row["metadata"]["doc_id"] for row in e.buscar_resultados("Dead by Daylight end game build", 6)[:2]} == {"endgame-a", "endgame-b"}
            e.RAG_MODE = "semantic"
            e.memoria_inicializada = True
            e.modo_fallback = False
            e.modelo = Mock()
            e.modelo.encode.return_value = [0.1, 0.2]
            e.colecao = Mock()
            e.colecao.count.return_value = 1
            e.colecao.query.return_value = {"distances": [[0.01]], "metadatas": [[{
                "doc_id": "robot", "content_hash": e.hash_texto(distracting + "Humanoid robot build ideas."), "chunk_index": 0}]]}
            assert not e._buscar_semantica("DBD endgame build", 6)
            assert not {"re4", "robot"} & {row["metadata"]["doc_id"] for row in e.buscar_resultados(query, 6)}
        """)

    def test_document_list_places_new_collections_before_imported_unknown_dates(self):
        self.run_engine("""
            from unittest.mock import patch
            from core import learning_engine as e
            with patch.object(e.time, "time", return_value=100):
                e.learn("Vídeo novo", "Transcrição aprendida agora.", "youtube", "new",
                        metadata={"extraido_em": "2026-10-07"})
            with patch.object(e.time, "time", return_value=200):
                e.learn("Importado antigo", "Texto histórico sem data conhecida.", "site", "legacy",
                        metadata={"imported_from": "chromadb"})
            assert [doc["id"] for doc in e.list_documents()] == ["new", "legacy"]
        """)

    def test_imports_chroma_legacy_chunks_without_overwriting_local_sources(self):
        self.run_engine("""
            from unittest.mock import Mock
            from core import learning_engine as e
            e.learn("Fonte local", "Conclusão mais recente.", "site", "local")
            e.colecao = Mock()
            e.colecao.get.return_value = {
                "ids": ["legacy_0", "legacy_1", "local_0"],
                "documents": ["TÍTULO: Antiga\\n\\nCONTEÚDO:\\nPortão abre quando todos os ",
                              "todos os geradores terminam.", "Texto local obsoleto."],
                "metadatas": [
                    {"doc_id": "legacy", "titulo": "Antiga", "tipo": "video", "url": "https://legacy.test", "chunk_index": 0},
                    {"doc_id": "legacy", "titulo": "Antiga", "chunk_index": 1},
                    {"doc_id": "local", "titulo": "Antiga local", "chunk_index": 0}]}
            assert e._importar_chroma_legado() == ["legacy"]
            assert e._importar_chroma_legado() == []
            assert e.buscar_resultados("geradores")[0]["documento"] == "Portão abre quando todos os geradores terminam."
            assert e.buscar_resultados("recente")[0]["metadata"]["titulo"] == "Fonte local"
            assert e.knowledge_status()["documentos"] == 2
        """)

    def test_chroma_sqlite_import_is_automatic_read_only_without_ml(self):
        self.run_engine("""
            import hashlib
            import sqlite3
            import sys
            from core import learning_engine as e
            e.path_banco.mkdir(parents=True, exist_ok=True)
            source = e.path_banco / "chroma.sqlite3"
            c = sqlite3.connect(source)
            c.executescript('''
                CREATE TABLE collections(id TEXT, name TEXT);
                CREATE TABLE segments(id TEXT, collection TEXT, scope TEXT);
                CREATE TABLE embeddings(id INTEGER, segment_id TEXT, embedding_id TEXT);
                CREATE TABLE embedding_metadata(id INTEGER, key TEXT, string_value TEXT, int_value INTEGER, float_value REAL, bool_value INTEGER);
                INSERT INTO collections VALUES ('collection', 'memoria_iana');
                INSERT INTO segments VALUES ('segment', 'collection', 'METADATA');
                INSERT INTO embeddings VALUES (1, 'segment', 'legacy-source');
            ''')
            c.executemany("INSERT INTO embedding_metadata(id, key, string_value) VALUES (1, ?, ?)",
                          [("chroma:document", "Conhecimento histórico preservado."), ("titulo", "Histórico"),
                           ("tipo", "site"), ("url", "https://legacy.test")])
            c.commit()
            c.close()
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            assert e.knowledge_status()["documentos"] == 1
            assert not e.knowledge_status()["legacy_chroma_pending"]
            assert e.buscar_resultados("historico")[0]["metadata"]["url"] == "https://legacy.test"
            assert before == hashlib.sha256(source.read_bytes()).hexdigest()
            assert not {"torch", "chromadb", "sentence_transformers"} & set(sys.modules)
        """)

    def test_semantic_dependency_failure_preserves_searchable_source(self):
        self.run_engine("""
            import builtins
            from unittest.mock import patch
            from core import learning_engine as e
            original_import = builtins.__import__
            def no_ml(name, *args, **kwargs):
                if name.split(".")[0] in {"chromadb", "sentence_transformers"}:
                    raise ImportError("indisponível no teste")
                return original_import(name, *args, **kwargs)
            with patch.object(builtins, "__import__", side_effect=no_ml):
                assert e.learn("Vídeo", "Adrenalina ativa no final da partida.", "video", "vid") == "NOVO"
                assert e.buscar_resultados("adrenalina")
                status = e.knowledge_status()
                assert status["documentos"] == 1
                assert status["active_mode"] == "keyword"
                assert status["semantic_error"]
        """, mode="semantic")

    def test_semantic_index_cannot_return_stale_or_deleted_text(self):
        self.run_engine("""
            from unittest.mock import Mock
            from core import learning_engine as e
            e.learn("Fonte", "Conclusão atualizada e verificável.", "site", "src")
            e.RAG_MODE = "semantic"
            e.memoria_inicializada = True
            e.modo_fallback = False
            e.modelo = Mock()
            e.modelo.encode.return_value = [0.1, 0.2]
            e.colecao = Mock()
            e.colecao.count.return_value = 1
            e.colecao.query.return_value = {
                "documents": [["Conclusão obsoleta"]], "distances": [[0.01]],
                "metadatas": [[{"doc_id": "src", "content_hash": "versao-antiga", "chunk_index": 0}]]}
            assert not e._buscar_semantica("obsoleta", 5)
            assert not e.buscar_resultados("obsoleta")
            assert e.buscar_resultados("verificável")
        """)

    def test_conversation_scope_isolated_before_ranking_listing_and_counting(self):
        self.run_engine("""
            from core import learning_engine as e
            e.learn("Fonte pública", "Build com estratégia pública.", "site", "public")
            e.learn("Preferência Alice", "Prefiro build com resgate.", "conversa_usuario", "alice",
                    metadata={"tipo": "conversa", "usuario_id": "user:1", "escopo": "usuario",
                              "natureza": "relato_usuario", "jogo": "Dead by Daylight"})
            before = {r["metadata"]["doc_id"]: r["score"] for r in e.buscar_resultados("build", usuario_id="user:1")}
            for number in range(10):
                e.learn("Segredo Bob", "Build privada com senha secreta. " * 20,
                        "conversa_usuario", "bob" + str(number),
                        metadata={"tipo": "conversa", "usuario_id": "user:2", "escopo": "usuario"})
            assert {r["metadata"]["doc_id"] for r in e.buscar_resultados("build")} == {"public"}
            after = {r["metadata"]["doc_id"]: r["score"] for r in e.buscar_resultados("build", usuario_id="user:1")}
            assert before == after, (before, after)
            assert set(after) == {"public", "alice"}
            assert e.knowledge_status()["documents"] == 1
            assert e.knowledge_status("user:1")["documents"] == 2
            assert e.status_memoria("user:2")["documents"] == 11
            assert {d["id"] for d in e.list_documents(usuario_id="user:1")} == {"public", "alice"}
            assert len(e.list_documents(limit=1, offset=1, usuario_id="user:1")) == 1
            assert not e.list_documents(limit=1, offset=2, usuario_id="user:1")
            assert e.get_document("alice") is None
            assert e.get_document("alice", usuario_id="user:2") is None
            assert e.get_document("alice", usuario_id="user:1")["conteudo"] == "Prefiro build com resgate."
            assert e.get_document("alice", usuario_id="user:1")["metadata"] == {
                "tipo": "conversa", "usuario_id": "user:1", "escopo": "usuario",
                "natureza": "relato_usuario", "jogo": "Dead by Daylight"}
            assert e.get_document("public", usuario_id="user:1")
            assert not e.buscar_conhecimento("senha", usuario_id="user:1")
            with e._conn() as conn:
                assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 12
        """)
        self.run_engine("""
            from core import learning_engine as e
            assert e.knowledge_status()["documents"] == 1
            assert e.knowledge_status("user:1")["documents"] == 2
            assert not e.buscar_resultados("senha", usuario_id="user:1")
            assert e.buscar_resultados("senha", usuario_id="user:2")
            results = e.buscar_resultados("DBD build resgate", usuario_id="user:1")
            assert {r["metadata"]["doc_id"] for r in results} == {"alice"}, results
            context = e.buscar_na_memoria_iana("DBD resgate", usuario_id="user:1")
            assert "relato do usuário" in context
            assert "sem verificação externa" in context
            assert "conteúdo extraído de uma fonte" not in context
            assert e.buscar_resultados("resgate", usuario_id="user:1")[0]["metadata"]["natureza"] == "relato_usuario"
        """)

    def test_incomplete_or_invalid_personal_metadata_never_becomes_public(self):
        self.run_engine("""
            from core import learning_engine as e
            e.learn("Pública", "Texto público documentado.", "site", "public")
            records = [
                ("sem_metadata", "conversa_usuario", {}),
                ("sem_dono", "conversa_usuario", {"escopo": "usuario"}),
                ("sem_escopo", "conversa_usuario", {"usuario_id": "user:1"}),
                ("escopo_publico", "conversa_usuario", {"usuario_id": "user:1", "escopo": "publico"}),
                ("owner_outra_categoria", "geral", {"usuario_id": "user:1"}),
                ("tipo_conversa", "geral", {"tipo": "conversa"}),
                ("escopo_desconhecido", "geral", {"escopo": "desconhecido"}),
            ]
            for key, category, metadata in records:
                assert e.learn("Privada", "Segredo confidencial da conversa.", category, key,
                               metadata=metadata) == "NOVO"
            for user in (None, "", "user:1", "user:2"):
                assert not e.buscar_resultados("segredo", usuario_id=user)
                assert e.knowledge_status(user)["documents"] == 1
                assert {row["id"] for row in e.list_documents(usuario_id=user)} == {"public"}
                assert all(e.get_document(key, usuario_id=user) is None for key, _, _ in records)
            with e._conn() as conn:
                assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 8
        """)

    def test_semantic_scope_uses_sqlite_even_if_index_claims_public(self):
        self.run_engine("""
            from unittest.mock import Mock
            from core import learning_engine as e
            e.learn("Pública", "Conteúdo documentado.", "site", "public")
            for key, owner in (("alice", "user:1"), ("bob", "user:2")):
                e.learn("Conversa", "Preferência pessoal " + key, "conversa_usuario", key,
                        metadata={"usuario_id": owner, "escopo": "usuario", "tipo": "conversa"})
            e.RAG_MODE = "semantic"
            e.memoria_inicializada = True
            e.modo_fallback = False
            e.modelo = Mock()
            e.modelo.encode.return_value = [0.1, 0.2]
            e.colecao = Mock()
            e.colecao.count.return_value = 3
            e.colecao.query.return_value = {
                "distances": [[0.01, 0.02, 0.03]], "metadatas": [[
                    {"doc_id": key, "content_hash": e.hash_texto(text), "chunk_index": 0,
                     "escopo": "publico", "usuario_id": "user:1"}
                    for key, text in (("bob", "Preferência pessoal bob"),
                                      ("alice", "Preferência pessoal alice"), ("public", "Conteúdo documentado."))]]}
            assert {r["metadata"]["doc_id"] for r in e._buscar_semantica("qualquer", 5)} == {"public"}
            assert e.colecao.query.call_args.kwargs["where"] == {"doc_id": {"$in": ["public"]}}
            assert {r["metadata"]["doc_id"] for r in e._buscar_semantica("qualquer", 5, "user:1")} == {"public", "alice"}
            allowed = set(e.colecao.query.call_args.kwargs["where"]["doc_id"]["$in"])
            assert allowed == {"public", "alice"}
            assert not e.buscar_conhecimento("bob", usuario_id="user:1").count("Preferência pessoal bob")
        """)

    def test_private_learning_never_reaches_unscoped_mysql_mirror(self):
        self.run_engine("""
            from unittest.mock import patch
            from core import learning_engine as e
            with patch.object(e, "_registrar_mysql") as mirror:
                assert e.learn("Pessoal", "Prefiro resgatar no endgame.", "conversa_usuario", "private",
                               metadata={"usuario_id": "user:1", "escopo": "usuario"}) == "NOVO"
                mirror.assert_not_called()
                assert e.learn("Site", "Estratégia extraída do site.", "site", "public") == "NOVO"
                mirror.assert_called_once()
        """)

    def test_local_supplied_text_keeps_file_origin_and_unverified_nature_with_game_scope(self):
        self.run_engine("""
            from core import learning_engine as e
            metadata = {"tipo": "texto_local", "arquivo": "data/titulos_para_buscar.txt",
                        "natureza": "conteudo_fornecido", "verificado": False, "jogo": "DBD", "bloco": 3}
            assert e.learn("Proposta fornecida", "Build no endgame com resgate alternativo.",
                           "texto_local", "local", metadata=metadata) == "NOVO"
            e.learn("Outro jogo", "Build no endgame com itens extras.", "texto_local", "other",
                    metadata={"tipo": "texto_local", "arquivo": "data/links_para_mineracao.txt",
                              "jogo": "Resident Evil 4", "verificado": False})
            results = e.buscar_resultados("DBD endgame build")
            assert {row["metadata"]["doc_id"] for row in results} == {"local"}, results
            origin = results[0]["metadata"]
            assert origin["origem_conhecimento"] == "arquivo_local"
            assert origin["natureza"] == "conteudo_fornecido"
            assert origin["verificado"] is False
            assert origin["arquivo"] == "data/titulos_para_buscar.txt"
            context = e.buscar_conhecimento("DBD endgame build")
            assert "Origem: conteúdo fornecido em arquivo local" in context
            assert "Arquivo: data/titulos_para_buscar.txt" in context
            assert "sem verificação externa" in context
            assert "Origem: conteúdo extraído de uma fonte" not in context
            assert "Outro jogo" not in context
        """)


if __name__ == "__main__":
    unittest.main()
