# Iana — base de conhecimento

Aqui, a base é o conteúdo que a Iana aprende: textos extraídos de sites e vídeos, explicações fornecidas nos arquivos e informações ensinadas nas conversas. Os códigos de extração e aprendizado gravam esses conteúdos no mesmo banco que ela consulta para responder e desenvolver novas ideias. O aprendizado é recuperação de informações do banco (RAG); não modifica os pesos do modelo.

## Aprender pelos códigos e arquivos existentes

Execute no diretório do projeto:

```powershell
.venv\Scripts\python.exe -m core.learn_source --from-files --max-sources 10 --game DBD
```

`scrape_learning.py` lê `data/titulos_para_buscar.txt`, `links_para_mineracao.txt`, `links_concluidos.txt` e `update_sources.txt`. Explicações completas no arquivo de títulos são salvas como conteúdo fornecido. Títulos curtos precisam de uma extração real, e URLs passam por `knowledge_sources.py`. `learning_engine.py` guarda os textos e prepara sua recuperação.

`--game DBD` fornece o contexto do jogo para blocos que não repetem seu nome. Para outros assuntos, omita essa opção ou indique o jogo correspondente. A inferência automática usa somente o conteúdo de cada bloco.

`source_registry.py` atualiza `links_concluidos.txt` e `update_source_state.json` apenas depois de confirmar a gravação. O estado também guarda o avanço entre lotes: o comando seguinte continua de onde parou. Os arquivos originais são preservados. A busca de YouTube enviada permanece em `update_sources.txt` para ser consultada novamente; cada vídeo extraído tem seu próprio registro.

## Aprender conversando

No chat, declarações, preferências, explicações, correções e ideias do usuário passam por `conversation_learning.py` e alimentam a mesma base. A próxima conversa da mesma conta pode recuperá-las. O registro mantém a fala original, autor e conversas de origem; respostas geradas pela Iana não viram conhecimento. Perguntas, pedidos de geração, saudações e credenciais não são tratados como ensinamentos.

Esses aprendizados são privados da conta e apresentados como relatos do usuário, sem transformar uma ideia ou correção em fato verificado. Fontes públicas extraídas e textos fornecidos nos arquivos continuam disponíveis para a consulta geral. `config_usuario.aprender_conversas=false` desativa o aprendizado da conversa. A gravação não depende da cota do provedor de respostas. Na execução direta de `core/iana_v2.py`, `IANA_USER_ID` identifica o autor; sem ele, a memória fica vinculada à sessão local.

## Usar pela interface

1. Instale as dependências com `npm install` e `.venv\Scripts\python.exe -m pip install -r requirements.txt` (ou seu Python configurado).
2. Mantenha o `.env` local com `IANA_API_KEY`, `SESSION_SECRET` e as configurações existentes do MySQL para login. Configure `GEMINI_API_KEY` ou o provedor customizado existente para gerar respostas.
3. Inicie com `npm start`, acesse `http://localhost:3333`, entre na conta e abra **Base de conhecimento**.
4. Cole uma URL de site, vídeo ou busca do YouTube e escolha **Aprender com esta fonte**. A tela mostra o andamento, o resultado de cada fonte e os textos disponíveis na base.

A busca enviada pelo usuário já aparece no formulário, com a expressão exata `nuild end game dbd` e o filtro original. O padrão adicional é até 5 vídeos publicados nos últimos 7 dias. `0` dias remove apenas esse filtro adicional; os filtros da URL continuam valendo. Nenhum título de resultado é salvo como se fosse transcrição.

## Extrair somente uma fonte

Sem abrir a interface, execute no diretório do projeto:

```powershell
.venv\Scripts\python.exe -m core.learn_source --max-videos 5 --recent-days 7
```

Sem URL, esse comando usa a busca de DBD enviada. Para outra fonte, passe a URL entre aspas antes das opções. O relatório informa fontes novas, existentes e indisponíveis; repetir uma fonte não duplica seus documentos.

## O que é salvo e usado

O banco local `memoria.sqlite3`, na pasta definida por `IANA_DB_PATH`, guarda documentos, trechos, URL, título, datas, idioma e método de extração. Sem essa variável, usa a pasta de dados local da Iana. O JSON antigo é migrado sem ser apagado. ChromaDB é opcional (`IANA_RAG_MODE=semantic`); o modo padrão `keyword` funciona sem modelos de embeddings ou serviço externo. MySQL pode receber um espelho com `IANA_MYSQL_MIRROR=1`.

Documentos do banco Chroma antigo também são importados pelo modo de leitura do SQLite quando o esquema é reconhecido, sem alterar o banco original nem carregar modelos. As fontes novas aparecem primeiro na lista. Perguntas que identificam DBD priorizam esse jogo, e pedidos sobre transcrições priorizam vídeos.

As tarefas também são persistidas. Se o serviço reiniciar durante uma extração, a tarefa informa a interrupção e pode ser reenviada. Os textos já salvos permanecem disponíveis. Em hospedagem com disco efêmero, configure `IANA_DB_PATH` em armazenamento persistente.

Sites que exigem login/JavaScript e vídeos privados, bloqueados ou sem conteúdo acessível podem falhar. O sistema registra essa limitação, em vez de fabricar informação. Guias e vídeos de jogos são fontes de texto; esta etapa não joga nem treina o modelo por conta própria.

As legendas são a primeira opção. Com Gemini configurado, vídeos públicos sem legendas também podem ter suas falas transcritas pelo modelo, com timestamps, até 20 minutos por vídeo. Esse método fica identificado como transcrição inferida. O sistema exige confirmação de processamento de áudio na resposta do provedor e rejeita respostas incompletas. `IANA_VIDEO_ASR_ENABLED=false` desativa esse recurso; `IANA_VIDEO_ASR_MAX_SECONDS` pode reduzir o limite. Chamadas ao provedor usam a conta já configurada.

Se o provedor de respostas atingir sua cota, o chat informa o limite e preserva o conteúdo aprendido. A consulta ao banco e a extração de sites/legendas continuam funcionando. Novas respostas e ideias geradas dependem da liberação dessa cota ou de outro provedor configurado.

## Validação

```powershell
npm test
.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
```

Os testes cobrem extração, filtros de datas, bloqueios, persistência, concorrência, atualização de trechos, recuperação com fontes, tarefas e acesso autenticado. Chaves ficam no servidor e nunca são enviadas à interface.
