import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import cors from 'cors';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app        = express();
const codigosRecuperacao = new Map();
const usuariosMemoria = new Map();
const conversasMemoria = new Map();
const mensagensMemoria = new Map();
let authFallbackAtivo = false;

function normalizarEmail(email) {
    return (email || '').trim().toLowerCase();
}

function normalizarNome(nome) {
    return (nome || '').trim();
}

function normalizarSenha(senha) {
    return (senha || '').trim();
}

async function buscarUsuarioPorEmail(email) {
    const emailNormalizado = normalizarEmail(email);
    if (!emailNormalizado) return null;

    if (authFallbackAtivo) {
        for (const usuario of usuariosMemoria.values()) {
            if (usuario.email === emailNormalizado) return usuario;
        }
        return null;
    }

    try {
        const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [emailNormalizado]);
        return rows[0] || null;
    } catch (err) {
        authFallbackAtivo = true;
        console.warn('[AUTH] Banco indisponível, usando fallback em memória:', err.message);
        for (const usuario of usuariosMemoria.values()) {
            if (usuario.email === emailNormalizado) return usuario;
        }
        return null;
    }
}

async function salvarUsuarioNoBancoOuFallback(usuario) {
    if (authFallbackAtivo) {
        const id = String(usuario.id || Date.now());
        const copia = { ...usuario, id };
        usuariosMemoria.set(id, copia);
        return copia;
    }

    try {
        const [result] = await pool.query(
            'INSERT INTO usuarios (nome, email, senha) VALUES (?, ?, ?)',
            [usuario.nome, usuario.email, usuario.senha]
        );
        const [rows] = await pool.query('SELECT id, nome, email FROM usuarios WHERE id = ?', [result.insertId]);
        return rows[0];
    } catch (err) {
        authFallbackAtivo = true;
        const id = String(usuario.id || Date.now());
        const copia = { ...usuario, id };
        usuariosMemoria.set(id, copia);
        return copia;
    }
}

async function atualizarSenhaNoBancoOuFallback(email, hash) {
    const emailNormalizado = normalizarEmail(email);
    if (authFallbackAtivo) {
        for (const usuario of usuariosMemoria.values()) {
            if (usuario.email === emailNormalizado) {
                usuario.senha = hash;
                usuariosMemoria.set(String(usuario.id), usuario);
                return true;
            }
        }
        return false;
    }

    try {
        await pool.query('UPDATE usuarios SET senha = ? WHERE email = ?', [hash, emailNormalizado]);
        return true;
    } catch (err) {
        authFallbackAtivo = true;
        for (const usuario of usuariosMemoria.values()) {
            if (usuario.email === emailNormalizado) {
                usuario.senha = hash;
                usuariosMemoria.set(String(usuario.id), usuario);
                return true;
            }
        }
        return false;
    }
}

async function listarConversasUsuario(idUsuario) {
    if (!idUsuario) return [];
    try {
        const [rows] = await pool.query(
            'SELECT id, titulo, fixada FROM conversas WHERE usuario_id=? ORDER BY fixada DESC, id DESC',
            [idUsuario]
        );
        return rows.map(r => ({ id_conversa: r.id, titulo: r.titulo, fixada: !!r.fixada }));
    } catch (err) {
        authFallbackAtivo = true;
        return [...conversasMemoria.values()]
            .filter(c => String(c.id_usuario) === String(idUsuario))
            .sort((a, b) => Number(b.fixada) - Number(a.fixada))
            .map(c => ({ id_conversa: c.id_conversa, titulo: c.titulo, fixada: !!c.fixada }));
    }
}

async function salvarMensagemChat(idUsuario, idConversa, conteudo, tipoSender) {
    if (!idUsuario || !idConversa || !conteudo) return null;

    const mensagem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        id_usuario: idUsuario,
        id_conversa: idConversa,
        conteudo,
        tipo_sender: tipoSender,
        criado_em: new Date().toISOString()
    };

    if (authFallbackAtivo) {
        const lista = mensagensMemoria.get(idConversa) || [];
        lista.push(mensagem);
        mensagensMemoria.set(idConversa, lista);
        return mensagem;
    }

    try {
        await pool.query(
            'INSERT INTO mensagens (conversa_id,remetente,mensagem) VALUES (?,?,?)',
            [idConversa, tipoSender === 'iana' ? 'iana' : 'user', conteudo]
        );
        return mensagem;
    } catch (err) {
        authFallbackAtivo = true;
        const lista = mensagensMemoria.get(idConversa) || [];
        lista.push(mensagem);
        mensagensMemoria.set(idConversa, lista);
        return mensagem;
    }
}

async function carregarHistoricoChat(idUsuario, idConversa) {
    if (!idUsuario || !idConversa) return [];

    if (authFallbackAtivo) {
        return (mensagensMemoria.get(idConversa) || []).map(m => ({
            conteudo: m.conteudo,
            tipo_sender: m.tipo_sender === 'iana' ? 'iana' : 'usuario',
            criado_em: m.criado_em
        }));
    }

    try {
        const [rows] = await pool.query(
            'SELECT mensagem, remetente, criado_em FROM mensagens WHERE conversa_id=? ORDER BY id ASC',
            [idConversa]
        );
        return rows.map(r => ({
            conteudo: r.mensagem,
            tipo_sender: r.remetente === 'iana' ? 'iana' : 'usuario',
            criado_em: r.criado_em
        }));
    } catch (err) {
        authFallbackAtivo = true;
        return (mensagensMemoria.get(idConversa) || []).map(m => ({
            conteudo: m.conteudo,
            tipo_sender: m.tipo_sender === 'iana' ? 'iana' : 'usuario',
            criado_em: m.criado_em
        }));
    }
}

/* ── MIDDLEWARES ──────────────────────────────────────────────── */
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.set('trust proxy', 1);
app.use(cors({ origin: (o, cb) => cb(null, true), credentials: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET || 'segredo_iana_2026',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    name: 'iana.sid',
    cookie: {
        secure: process.env.NODE_ENV === 'production' && process.env.SESSION_SECURE !== 'false',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7*24*60*60*1000
    }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use((req, res, next) => {
    req.isAuthenticated = () => Boolean(req.session?.user);
    if (req.session?.user) req.user = req.session.user;
    next();
});

/* ── MYSQL ────────────────────────────────────────────────────── */
const pool = mysql.createPool({
    host:     process.env.DB_HOST || 'localhost',
    port:     process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user:     process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'iana_db',
    waitForConnections: true,
    connectionLimit: 10,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

/* ── GEMINI ───────────────────────────────────────────────────── */
let genAI = null;
try {
    if (process.env.GEMINI_API_KEY) {
        genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    } else {
        console.warn('⚠️ GEMINI_API_KEY ausente no .env.');
    }
} catch (e) {
    console.error('💥 Falha ao inicializar Gemini:', e.message);
}

function detectarHumor(texto) {
    if (!texto) return 'normal';
    const letras = (texto.match(/[A-Za-z]/g) || []).length;
    const caps   = (texto.match(/[A-Z]/g) || []).length;
    const pctCaps = letras > 0 ? (caps / letras) * 100 : 0;
    if (pctCaps > 70 || /\*{4,}/.test(texto)) return 'raiva';
    if (/!{2,}/.test(texto) || /\?{2,}/.test(texto)) return 'estressado';
    if (/[!?]{2,}/.test(texto)) return 'frustrado';
    return 'normal';
}

function instrucaoPorHumor(humor) {
    const mapa = {
        normal: '',
        estressado: 'A pessoa parece um pouco estressada. Responda com calma e leveza.',
        raiva: 'A pessoa está irritada ou exaltada. Responda com empatia, calma e sem ser seca.',
        frustrado: 'A pessoa está frustrada. Seja acolhedora e ofereça soluções com tranquilidade.'
    };
    return mapa[humor] || '';
}

/* ── GEMINI: chamada única com diagnóstico completo ──────────── */
async function chamarGeminiUmaVez(modeloNome, mensagem, historicoConversa, systemPrompt) {
    const model = genAI.getGenerativeModel({
        model: modeloNome,
        systemInstruction: systemPrompt
    });

    const chat = model.startChat({
        history: historicoConversa.map(msg => ({
            role: msg.remetente === 'iana' ? 'model' : 'user',
            parts: [{ text: msg.mensagem }]
        })),
        generationConfig: { maxOutputTokens: 2048 }
    });

    const result = await chat.sendMessage(mensagem);

    // Verifica se a resposta foi bloqueada (RECITATION, SAFETY, etc)
    const candidate = result.response?.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
        throw new Error(`finishReason=${candidate.finishReason}`);
    }

    const texto = result.response.text();
    if (!texto || !texto.trim()) throw new Error('resposta vazia');
    return texto;
}

const MODELOS_FALLBACK = [
    process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash'
];

async function askGemini(mensagem, historicoConversa = [], instrucaoEmocional = '') {
    if (!genAI) return null;

    const systemPrompt = (process.env.SYSTEM_PROMPT ||
        'Você é a Iana, uma assistente animada, humanizada, divertida, conversacional, criativa e solidária.')
        + (instrucaoEmocional ? `\n\n[CONTEXTO DE TOM]: ${instrucaoEmocional}` : '');

    let ultimoErro = null;

    for (const modeloNome of [...new Set(MODELOS_FALLBACK)]) {
        for (let tentativa = 0; tentativa < 2; tentativa++) {
            try {
                const texto = await chamarGeminiUmaVez(modeloNome, mensagem, historicoConversa, systemPrompt);
                return texto;
            } catch (err) {
                ultimoErro = err;
                const status = err?.status || err?.response?.status || '';
                console.error(`[GEMINI] Falhou (modelo=${modeloNome}, tentativa=${tentativa + 1}, status=${status}):`, err.message);

                if (status === 503 || status === 429 || /overloaded|unavailable/i.test(err.message)) {
                    await new Promise(r => setTimeout(r, 600));
                    continue;
                }
                if (/finishReason=/.test(err.message)) {
                    // Bloqueado por RECITATION/SAFETY — não adianta repetir o mesmo prompt no mesmo modelo
                    break;
                }
                break;
            }
        }
    }

    console.error('[GEMINI] Todos os modelos falharam. Último erro:', ultimoErro?.message);
    return null;
}

function resolvePythonExecutable() {
    if (process.env.IANA_PYTHON_PATH) return process.env.IANA_PYTHON_PATH;
    return process.platform === 'win32' ? 'python' : 'python3';
}

async function askIanaPython(nomeUsuario, idConversa, mensagem) {
    return new Promise((resolve, reject) => {
        const proc = spawn(resolvePythonExecutable(), [
            path.join(__dirname, 'iana.py'), nomeUsuario, idConversa || 'chat_geral', mensagem
        ]);
        let resposta = '', erroLog = '';
        proc.stdout.on('data', d => resposta += d.toString());
        proc.stderr.on('data', d => erroLog += d.toString());
        proc.on('close', code => {
            if (code !== 0 || !resposta.trim()) {
                console.error('[PYTHON] stderr:', erroLog || '(vazio)');
                return reject(new Error(`Python exit code ${code}`));
            }
            resolve(resposta.trim());
        });
        proc.on('error', reject);
    });
}

/* ── NODEMAILER ───────────────────────────────────────────────── */
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

async function enviarEmailCodigo(destinatario, codigo) {
    await transporter.sendMail({
        from: `"Iana Games 🎮" <${process.env.EMAIL_USER}>`,
        to: destinatario,
        subject: 'Seu código de recuperação — Iana',
        html: `<div style="font-family:sans-serif;background:#111;color:white;padding:30px;border-radius:12px;max-width:400px;margin:auto;">
            <h2 style="color:#a855f7;">🎮 Iana Games</h2>
            <p>Código de recuperação:</p>
            <div style="background:#1e1f20;border:1px solid #333;border-radius:8px;padding:20px;text-align:center;margin:20px 0;">
                <span style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#a855f7;">${codigo}</span>
            </div>
            <p style="color:#aaa;font-size:13px;">Expira em <strong style="color:white;">15 minutos</strong>.</p>
        </div>`
    });
}

/* ── PASSPORT ─────────────────────────────────────────────────── */
passport.use(new LocalStrategy(
    { usernameField: 'email', passwordField: 'senha' },
    async (email, senha, done) => {
        try {
            const emailNormalizado = normalizarEmail(email);
            const senhaNormalizada = normalizarSenha(senha);
            if (!emailNormalizado || !senhaNormalizada) return done(null, false, { message: 'Campos obrigatórios.' });

            const usuario = await buscarUsuarioPorEmail(emailNormalizado);
            if (!usuario) return done(null, false, { message: 'E-mail não cadastrado.' });
            if (!usuario.senha) return done(null, false, { message: 'Senha incorreta.' });

            const ok = await bcrypt.compare(senhaNormalizada, usuario.senha);
            if (!ok) return done(null, false, { message: 'Senha incorreta.' });

            return done(null, { id: usuario.id, nome: usuario.nome, email: usuario.email });
        } catch (err) { return done(err); }
    }
));

passport.serializeUser((user, done) => done(null, String(user.id)));
passport.deserializeUser(async (id, done) => {
    try {
        const idNormalizado = String(id);
        const usuarioMemoria = usuariosMemoria.get(idNormalizado);
        if (usuarioMemoria) return done(null, usuarioMemoria);

        const [rows] = await pool.query('SELECT id,nome,email FROM usuarios WHERE id=?', [id]);
        done(null, rows[0] || null);
    } catch (err) {
        done(null, null);
    }
});

function autenticado(req, res, next) {
    if (req.isAuthenticated()) {
        req.user = req.session.user;
        return next();
    }
    res.status(401).json({ erro: 'Login necessário.' });
}

/* ── ROOT ─────────────────────────────────────────────────────── */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/health', (req, res) => res.json({ ok: true, service: 'iana', time: new Date().toISOString() }));

/* ── AUTH ─────────────────────────────────────────────────────── */
app.post('/auth/registro', async (req, res) => {
    const nome = normalizarNome(req.body?.nome);
    const email = normalizarEmail(req.body?.email);
    const senha = normalizarSenha(req.body?.senha);

    if (!nome || !email || !senha) return res.status(400).json({ erro: 'Preencha todos os campos.' });

    try {
        const usuarioExistente = await buscarUsuarioPorEmail(email);
        if (usuarioExistente) return res.status(409).json({ erro: 'Email já cadastrado.' });

        const hash = await bcrypt.hash(senha, 12);
        const usuarioCriado = await salvarUsuarioNoBancoOuFallback({ id: Date.now(), nome, email, senha: hash });
        req.session.user = { id: usuarioCriado.id, nome: usuarioCriado.nome, email: usuarioCriado.email };
        req.session.authenticated = true;
        req.user = req.session.user;
        res.status(201).json({ usuario: req.session.user });
    } catch (err) {
        console.error('[AUTH] registro:', err.message);
        res.status(500).json({ erro: 'Erro interno.' });
    }
});

app.post('/auth/login', async (req, res) => {
    const email = normalizarEmail(req.body?.email);
    const senha = normalizarSenha(req.body?.senha);

    if (!email || !senha) return res.status(400).json({ erro: 'Campos obrigatórios.' });

    try {
        const usuario = await buscarUsuarioPorEmail(email);
        if (!usuario) return res.status(401).json({ erro: 'E-mail não cadastrado.' });

        const ok = await bcrypt.compare(senha, usuario.senha);
        if (!ok) return res.status(401).json({ erro: 'Senha incorreta.' });

        req.session.user = { id: usuario.id, nome: usuario.nome, email: usuario.email };
        req.session.authenticated = true;
        req.user = req.session.user;
        res.json({ usuario: req.session.user });
    } catch (err) {
        console.error('[AUTH] login:', err.message);
        res.status(500).json({ erro: 'Erro interno.' });
    }
});

app.post('/auth/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ erro: 'Erro ao fazer logout.' });
        res.clearCookie('iana.sid');
        res.json({ ok: true });
    });
});

app.get('/auth/me', (req, res) => {
    if (!req.isAuthenticated()) return res.json({ logado: false });
    res.json({ logado: true, usuario: req.session.user });
});

app.post('/auth/esqueci-senha', async (req, res) => {
    const email = normalizarEmail(req.body?.email);
    if (!email) return res.status(400).json({ erro: 'Email obrigatório.' });
    try {
        const usuario = await buscarUsuarioPorEmail(email);
        if (!usuario) return res.status(404).json({ erro: 'E-mail não encontrado.' });
        const codigo = Math.floor(100000 + Math.random() * 900000).toString();
        codigosRecuperacao.set(email, { codigo, expiracao: Date.now() + 15*60*1000 });
        try {
            await enviarEmailCodigo(email, codigo);
        } catch (mailErr) {
            console.warn('[AUTH] Email de recuperação não enviado:', mailErr.message);
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('[AUTH] esqueci-senha:', err.message);
        res.status(500).json({ erro: 'Erro ao enviar email.' });
    }
});

app.post('/auth/mudar-senha', async (req, res) => {
    const codigo = String(req.body?.codigo || '').trim();
    const novaSenha = normalizarSenha(req.body?.nova_senha || req.body?.novaSenha || req.body?.senha || req.body?.nova_password);
    const email = normalizarEmail(req.body?.email);

    if (!email || !codigo || !novaSenha) return res.status(400).json({ erro: 'Dados incompletos.' });
    const token = codigosRecuperacao.get(email);
    if (!token || token.codigo !== codigo || Date.now() > token.expiracao) {
        return res.status(400).json({ erro: 'Código inválido ou expirado.' });
    }

    try {
        const hash = await bcrypt.hash(novaSenha, 12);
        await atualizarSenhaNoBancoOuFallback(email, hash);
        codigosRecuperacao.delete(email);
        res.json({ ok: true });
    } catch (err) {
        console.error('[AUTH] mudar-senha:', err.message);
        res.status(500).json({ erro: 'Erro ao salvar nova senha.' });
    }
});

/* ── HELPERS DE CONVERSA ──────────────────────────────────────── */
async function garantirConversa(idUsuario, idConversa, mensagem) {
    if (!idUsuario) return idConversa || null;
    const idFinal = idConversa || `conversa_${idUsuario}_${Date.now()}`;
    const limpo   = mensagem.replace(/\[.*?\]/g, '').trim();
    const titulo  = (limpo.slice(0, 40) || 'Nova Conversa') + (limpo.length > 40 ? '...' : '');

    const conversa = { id_conversa: idFinal, id_usuario: idUsuario, titulo, fixada: false };
    conversasMemoria.set(idFinal, conversa);

    try {
        await pool.query(
            'INSERT INTO conversas (id,usuario_id,titulo) VALUES (?,?,?) ON DUPLICATE KEY UPDATE titulo=titulo',
            [idFinal, idUsuario, titulo]
        );
    } catch (e) {
        console.error('[DB] garantirConversa:', e.message);
    }
    return idFinal;
}

/* ── CHAT PRINCIPAL ───────────────────────────────────────────── */
app.post('/chat/stream', async (req, res) => {
    const nomeUsuario = req.user?.nome || 'Visitante';
    const idUsuario   = req.user?.id || null;
    const mensagem    = req.body.mensagem;

    if (!mensagem?.trim()) return res.status(400).json({ error: 'Mensagem não fornecida.' });

    const idConversa = await garantirConversa(idUsuario, req.body.idConversa, mensagem);

    if (idUsuario && idConversa) {
        try {
            await salvarMensagemChat(idUsuario, idConversa, mensagem, 'usuario');
        } catch (e) { console.error('[DB] salvar user:', e.message); }
    }

    let historicoConversa = [];
    if (idUsuario && idConversa) {
        try {
            const msgs = await carregarHistoricoChat(idUsuario, idConversa);
            historicoConversa = msgs.slice(-6).reverse();
        } catch (e) { console.error('[DB] histórico:', e.message); }
    }

    const humor = req.body.estadoEmocional || detectarHumor(mensagem);
    let respostaIana = await askGemini(mensagem, historicoConversa, instrucaoPorHumor(humor));

    if (!respostaIana && process.env.ENABLE_PYTHON_FALLBACK === 'true') {
        console.log('[FALLBACK] Gemini falhou, tentando iana.py...');
        try {
            respostaIana = await askIanaPython(nomeUsuario, idConversa || 'chat_geral', mensagem);
        } catch (e) {
            console.error('[FALLBACK] iana.py também falhou:', e.message);
        }
    }

    if (!respostaIana) {
        respostaIana = 'Tive um problema de conexão agora. Pode repetir a mensagem? 😊';
        console.warn('[AVISO] Gemini falhou em todos os modelos. Veja os logs acima para o motivo exato.');
    }

    if (idUsuario && idConversa) {
        try {
            await salvarMensagemChat(idUsuario, idConversa, respostaIana.trim(), 'iana');
        } catch (e) { console.error('[DB] salvar resposta:', e.message); }
    }

    res.json({ resposta: respostaIana.trim(), idConversa: idConversa || null });
});

/* ── /chat/conversas ──────────────────────────────────────────── */
app.get('/chat/conversas', autenticado, async (req, res) => {
    try {
        const conversas = await listarConversasUsuario(req.user.id);
        res.json({ conversas });
    } catch (err) {
        res.json({ conversas: [] });
    }
});

app.post('/chat/conversas', autenticado, async (req, res) => {
    const { titulo } = req.body;
    const idConversa = `conversa_${req.user.id}_${Date.now()}`;
    try {
        await pool.query('INSERT INTO conversas (id,usuario_id,titulo) VALUES (?,?,?)', [idConversa, req.user.id, titulo || 'Nova Conversa']);
        res.json({ idConversa });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/chat/historico/:id', autenticado, async (req, res) => {
    try {
        const mensagens = await carregarHistoricoChat(req.user.id, req.params.id);
        res.json({ mensagens });
    } catch (err) {
        res.json({ mensagens: [] });
    }
});

app.put('/chat/conversas/:id', autenticado, async (req, res) => {
    const { novoTitulo } = req.body;
    if (!novoTitulo?.trim()) return res.status(400).json({ erro: 'Título obrigatório.' });
    try {
        await pool.query('UPDATE conversas SET titulo=? WHERE id=? AND usuario_id=?', [novoTitulo.trim(), req.params.id, req.user.id]);
        res.json({ message: 'Conversa renomeada.' });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.patch('/chat/conversas/:id/fixar', autenticado, async (req, res) => {
    const { fixada } = req.body;
    try {
        await pool.query('UPDATE conversas SET fixada=? WHERE id=? AND usuario_id=?', [fixada ? 1 : 0, req.params.id, req.user.id]);
        res.json({ message: 'Conversa atualizada.' });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.delete('/chat/conversas/:id', autenticado, async (req, res) => {
    try {
        await pool.query('DELETE FROM mensagens WHERE conversa_id=?', [req.params.id]);
        await pool.query('DELETE FROM conversas WHERE id=? AND usuario_id=?', [req.params.id, req.user.id]);
        res.json({ message: 'Conversa deletada.' });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/historico', async (req, res) => {
    if (!req.isAuthenticated()) return res.json([]);
    try {
        const [rows] = await pool.query('SELECT * FROM conversas WHERE usuario_id=? ORDER BY fixada DESC, id DESC', [req.user.id]);
        res.json(rows);
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

const PORT = Number(process.env.PORT) || 3333;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Iana rodando em http://0.0.0.0:${PORT}`);
});