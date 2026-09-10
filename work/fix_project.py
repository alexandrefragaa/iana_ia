from pathlib import Path
import shutil, json
root=Path(r'C:\ia_platina')
backup=root/'work'/'backup'
def edit(rel, fn):
 p=root/rel; s=p.read_text(encoding='utf-8-sig'); target=backup/rel; target.parent.mkdir(parents=True,exist_ok=True)
 if not target.exists(): shutil.copy2(p,target)
 p.write_text(fn(s),encoding='utf-8')
def server(s):
 s=s.replace("dotenv.config();", "import { pythonExecutable, ensureConversation, attachmentPart, escapeHTML } from './core/runtime.js';\n\ndotenv.config({ path: new URL('.env', import.meta.url) });")
 s=s.replace("const py = process.env.IANA_PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');", "const py = pythonExecutable(__dirname);")
 s=s.replace("path.join(__dirname, 'iana.py')", "path.join(__dirname, 'core', 'iana.py')")
 s=s.replace("configJSON]);", "configJSON], { cwd: __dirname, env: { ...process.env, PYTHONIOENCODING: 'utf-8', IANA_USER_ID: String(configRaw?._userId || ''), IANA_DB_PATH: process.env.IANA_DB_PATH || path.join(__dirname, 'database', 'chromadb') } });")
 s=s.replace("let out = '', err = '';", "let out = '', err = '';\n        proc.stdout.setEncoding('utf8');\n        proc.stderr.setEncoding('utf8');")
 s=s.replace("if (/oi|olá|ola|hey|bom dia|boa tarde|boa noite/.test(msg))", "if (/^(oi|olá|ola|hey|bom dia|boa tarde|boa noite)[!?.\\s]*$/.test(msg.trim()))")
 start=s.index('async function garantirConversa('); end=s.index("app.get('/conversas',",start)
 s=s[:start]+"async function garantirConversa(idUsuario, idConversa, mensagem) {\n    return ensureConversation(pool, idUsuario, idConversa, mensagem);\n}\n\n"+s[end:]
 s=s.replace("WHERE conversa_id=? ORDER BY id DESC LIMIT 8',\n                [idConv]", "WHERE conversa_id=? AND usuario_id=? ORDER BY id DESC LIMIT 8',\n                [idConv, idUser]")
 s=s.replace("WHERE conversa_id=? ORDER BY id DESC LIMIT 6',\n            [idConv]", "WHERE conversa_id=? AND usuario_id=? ORDER BY id DESC LIMIT 6',\n            [idConv, idUser]")
 s=s.replace("app.post('/auth/mudar-senha', async", "app.post('/auth/mudar-senha', loginLimiter, async")
 s=s.replace('Math.floor(100000 + Math.random() * 900000)', 'crypto.randomInt(100000, 1000000)')
 s=s.replace("{ codigo, exp: Date.now() + 15 * 60 * 1000 }", "{ codigo, exp: Date.now() + 15 * 60 * 1000, tentativas: 0 }")
 s=s.replace("if (!token || token.codigo !== codigo.trim() || Date.now() > token.exp)\n        return res.status(400).json({ erro: 'Código inválido ou expirado.' });", "if (!token || Date.now() > token.exp || token.tentativas >= 5) {\n        codigos.delete(email);\n        return res.status(400).json({ erro: 'Código inválido ou expirado.' });\n    }\n    token.tentativas++;\n    if (typeof codigo !== 'string' || token.codigo !== codigo.trim())\n        return res.status(400).json({ erro: 'Código inválido ou expirado.' });")
 s=s.replace("${req.user?.nome || 'Visitante'} (${req.user?.email || 'sem login'})", "${escapeHTML(req.user?.nome || 'Visitante')} (${escapeHTML(req.user?.email || 'sem login')})")
 s=s.replace("${texto.replace(/\\n/g, '<br>')}", "${escapeHTML(texto).replace(/\\n/g, '<br>')}")
 s=s.replace("const msg    = (req.body.mensagem || req.body.message || '').trim();", "const input = req.body.mensagem ?? req.body.message ?? '';\n    if (typeof input !== 'string') return res.status(400).json({ erro: 'Mensagem deve ser texto.' });\n    const msg = input.trim();")
 s=s.replace("? req.body.configRaw : {};", "? { ...req.body.configRaw, _userId: idUser } : { _userId: idUser };")
 s=s.replace("if (msg.length > 8000)", "if (msg.length > 16000)")
 start=s.index('    // NOTA: anexos'); end=s.index('    const contextoLinks',start)
 s=s[:start]+"    const anexo = attachmentPart(req.body);\n    if (['imagem', 'audio'].includes(req.body.tipo) && !anexo) return res.status(400).json({ erro: 'Conteúdo do anexo ausente.' });\n\n"+s[end:]
 block="    if (idUser && idConv) {\n        await pool.query('INSERT INTO mensagens (conversa_id,usuario_id,remetente,mensagem) VALUES (?,?,?,?)', [idConv, idUser, 'user', msg]);\n    }\n\n"
 s=s.replace(block,'')
 s=s.replace("    const msgParaIA = contextoLinks", block+"    if (!idUser && Array.isArray(req.session.chatHistory)) historico = req.session.chatHistory;\n\n    const msgParaIA = contextoLinks")
 s=s.replace("historico, humor, config, configRaw });", "historico, humor, config, configRaw, anexo });")
 s=s.replace("    res.json({ resposta, conversa_id:", "    if (!idUser) req.session.chatHistory = [...historico, { remetente: 'user', mensagem: msg }, { remetente: 'iana', mensagem: resposta }].slice(-8);\n    res.json({ resposta, conversa_id:")
 s=s.replace("modoVoz = false }) {\n    let resposta", "modoVoz = false, anexo = null }) {\n    if (anexo) {\n        if (LOCAL_ONLY || !genAI) throw Object.assign(new Error('Análise de anexos indisponível: configure Gemini e desative o modo somente local.'), { status: 503 });\n        const model = genAI.getGenerativeModel({ model: MODELOS[0] });\n        const result = await model.generateContent([{ text: `${config || ''}\\n${msg}` }, anexo]);\n        return result.response.text();\n    }\n    let resposta")
 s=s.replace("if (process.env.ENABLE_PYTHON !== 'false')", "if (!modoVoz && process.env.ENABLE_PYTHON !== 'false')")
 s=s.replace("res.status(500).json({ erro: 'Erro interno no servidor.' });", "const status = err.status >= 400 && err.status < 500 ? err.status : (err.status === 503 ? 503 : 500);\n    res.status(status).json({ erro: status === 500 ? 'Erro interno no servidor.' : err.message });")
 pos=s.index('/* ── AUTH ─')
 guard="app.use((req, res, next) => {\n    if (!req.body) req.body = {};\n    const fields = ['nome','email','senha','senhaAtual','novaSenha','nova_senha','codigo','feedback','titulo','resumo','conversa_id','id_conversa','idConversa'];\n    if (fields.some(key => req.body[key] != null && typeof req.body[key] !== 'string')) return res.status(400).json({ erro: 'Campos de texto inválidos.' });\n    next();\n});\n\n"
 s=s[:pos]+guard+s[pos:]
 s=s.replace("        const nome = socket.request.user?.nome || 'Visitante';", "        const previous = historicoVozPorSocket.get(socket.id);\n        if (previous?.busy) return socket.emit('voz:erro', { mensagem: 'Aguarde a resposta atual.' });\n        const nome = socket.request.user?.nome || 'Visitante';")
 s=s.replace("        const idConversa = await garantirConversa(", "        estado.busy = true;\n        historicoVozPorSocket.set(socket.id, estado);\n        try {\n        const idConversa = await garantirConversa(")
 s=s.replace("        try {\n            const resposta = await gerarRespostaIA({", "            const resposta = await gerarRespostaIA({")
 s=s.replace("            historico.push({ remetente: 'user'", "            if (!socket.connected || historicoVozPorSocket.get(socket.id) !== estado || estado.turno !== turnoAtual) return;\n            historico.push({ remetente: 'user'")
 s=s.replace("socket.emit('voz:erro', { mensagem: 'Erro ao processar sua fala.' });\n        }", "socket.emit('voz:erro', { mensagem: 'Erro ao processar sua fala.' });\n        } finally { estado.busy = false; }")
 s=s.replace("server.listen(PORT, '0.0.0.0'", "server.listen(PORT, process.env.HOST || '0.0.0.0'")
 return s
edit('server.js',server)
def brain(s):
 s=s.replace('BASE_DIR = Path(__file__).resolve().parent','BASE_DIR = Path(__file__).resolve().parent.parent')
 start=s.index('    from memory import ('); end=s.index('\n\n# learning_engine.py',start)
 s=s[:start]+'''    from memory import save_memory, get_memory
    MEMORY_OK = True
except Exception as e:
    MEMORY_OK = False
    save_memory = get_memory = None
    sys.stderr.write(f"[Memory] módulo indisponível: {e}\\n")
'''+s[end:]
 start=s.index('def consultar_memoria_usuario('); end=s.index('def consultar_conhecimento(',start)
 s=s[:start]+'''def consultar_memoria_usuario(pergunta, usuario_id, limite=6):
    if not MEMORY_OK:
        return ""
    resultados = get_memory(pergunta, id_usuario_numerico=os.getenv("IANA_USER_ID") or None, limit=limite)
    return "\\n\\n".join(resultados)


'''+s[end:]
 start=s.index('def salvar_interacao('); end=s.index('def resposta_do_contexto(',start)
 s=s[:start]+'''def salvar_interacao(pergunta, resposta):
    user_id = os.getenv("IANA_USER_ID", "").strip()
    if not MEMORY_OK or not user_id or not pergunta or not resposta:
        return
    save_memory(f"Usuário: {pergunta}\\nIana: {resposta}", categoria="conversa", user_id=user_id)


'''+s[end:]
 return s.replace('timeout=45','timeout=18')
edit('core/iana.py',brain)
edit('core/scrape_learning.py',lambda s:s.replace('str(Path(__file__).resolve().parent)','str(Path(__file__).resolve().parent.parent)'))
edit('run.pipeline.js',lambda s:s.replace('"./scraper.js"','"./crawler/scraper.js"').replace('"./savetoTxT.js"','"./crawler/savetoTxT.js"').replace('fs.readFileSync(filepath,','fs.readFileSync(new URL(filepath, import.meta.url),').replace('            saveLink(url);\n            saveDiscovery(data.title, url);\n            learned++;', '            if (await saveDiscovery(data.title, url)) learned++;').replace('    for (const url of urls.slice(0, 20)) {','    for (const url of urls.slice(0, 20)) {\n        processed++;').replace('        processed++;\n    }','    }'))
edit('crawler/savetoTxT.js',lambda s:s[:s.index('// Mantive')]+'''const ARQUIVO_DESTINO = new URL('./discovered_links.txt', import.meta.url);
export async function saveDiscovery(title, link) {
    try {
        await fs.appendFile(ARQUIVO_DESTINO, `${String(title).replace(/[\\r\\n]+/g, ' ')} | ${link}\\n`);
        return true;
    } catch (err) { console.error('Erro ao salvar descoberta:', err.message); return false; }
}
''')
edit('dedup.js',lambda s:'''import fs from 'node:fs';
const file = new URL('./crawler/discovered_links.txt', import.meta.url);
export function isDuplicate(link) {
    if (!fs.existsSync(file)) return false;
    return fs.readFileSync(file, 'utf8').split(/\\r?\\n/).some(line => line.trim().split(' | ').at(-1) === link);
}
export function saveLink(link) { fs.appendFileSync(file, link + '\\n'); }
''')
edit('crawler/savetoDb.js',lambda s:s.replace('import { db } from "../backend-node/src/db/mysql.js";', '''import mysql from 'mysql2/promise';
import { env } from '../env.js';
const db = mysql.createPool({ host: env.db.host || 'localhost', port: env.db.port || 3306, user: env.db.user, password: env.db.password, database: env.db.name, ssl: env.db.ssl ? {} : undefined });'''))
edit('requirements.txt',lambda s:s+'\npymysql\n')
edit('env.js',lambda s:s.replace('dotenv.config();',"dotenv.config({ path: new URL('.env', import.meta.url) });"))
edit('prisma/schema.prisma',lambda s:s.replace('generator client {\n  provider = "mysql"','generator client {\n  provider = "prisma-client-js"'))
def frontend(s):
 s=s.replace("            try {\n                if (\n                    file.type.startsWith(", "            try {\n                if (file.size > 10 * 1024 * 1024) throw new Error('Limite de 10 MB por arquivo.');\n                if (\n                    file.type.startsWith(")
 s=s.replace("                            tipo: 'audio',\n                            nome: file.name,", "                            tipo: 'audio',\n                            audio: await arquivoParaDataURL(file),\n                            nome: file.name,")
 s=s.replace("                await processarEnvioIA(\n                    `[Usuário enviou um arquivo: ${file.name}]`,", "                if (file.type !== 'application/pdf') throw new Error('Use imagem PNG/JPEG/WebP, áudio, PDF ou TXT.');\n                await processarEnvioIA(\n                    `[Usuário enviou um arquivo: ${file.name}]`,")
 s=s.replace("                        tipo: 'arquivo',\n                        nome: file.name,", "                        tipo: 'arquivo',\n                        arquivo: await arquivoParaDataURL(file),\n                        nome: file.name,")
 s=s.replace("'Não foi possível processar o arquivo.'", "erro.message || 'Não foi possível processar o arquivo.'")
 start=s.index('        /*\n           Atualmente enviamos somente'); end=s.index('\n    } catch (erro)',start)
 s=s[:start]+'''        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        await processarEnvioIA('Descreva esta captura de tela e ajude com o que aparece nela.', {
            tipo: 'imagem', imagem: canvas.toDataURL('image/jpeg', 0.8), nome: 'captura-tela.jpg'
        });
        video.srcObject = null;
'''+s[end:]
 return s
edit('public/js/chat.js',frontend)
edit('package.json',lambda s:json.dumps({**json.loads(s),'scripts':{**json.loads(s)['scripts'],'test':'node --test tests/*.test.js','pipeline':'node run.pipeline.js'}},ensure_ascii=False,indent=2)+'\n')
print('Correções aplicadas; cópias originais em',backup)
