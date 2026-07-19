import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Resend } from 'resend';

dotenv.config();

console.log('[DEBUG] ALLOWED_ORIGINS =', JSON.stringify(process.env.ALLOWED_ORIGINS));

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app        = express();
const codigos    = new Map();

if (!process.env.SESSION_SECRET) {
    console.error('❌ SESSION_SECRET não definido no .env'); process.exit(1);
}

/* ── MIDDLEWARES ──────────────────────────────────────────────── */
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.set('trust proxy', 1);

const origensPermitidas = (process.env.ALLOWED_ORIGINS || 'http://localhost:3333').split(',').map(o => o.trim());
app.use(cors({
    origin: (origin, cb) => {
        if (!origin || origensPermitidas.includes(origin)) return cb(null, true);
        console.warn(`[CORS] Origem bloqueada: ${origin}`);
        return cb(new Error('Origem não permitida por CORS'));
    },
    credentials: true
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    name: 'iana.sid',
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
    // ATENÇÃO: sem "store" configurado, isto usa MemoryStore.
    // Funciona para teste, mas em produção real no Render:
    // - todo mundo é deslogado a cada deploy/restart
    // - quebra se você escalar para mais de 1 instância
    // Recomendo trocar por connect-mysql2/express-mysql-session usando o pool abaixo.
}));
app.use(passport.initialize());
app.use(passport.session());

/* ── MYSQL ────────────────────────────────────────────────────── */
const pool = mysql.createPool({
    host:     process.env.DB_HOST || 'mysql-7ddcebe.aivencloud.com',
    port:     process.env.DB_PORT ? Number(process.env.DB_PORT) : 12788,
    user:     process.env.DB_USER || 'avnadmin',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'defaultdb',
    waitForConnections: true,
    connectionLimit: 10,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

(async () => {
    try {
        const conn = await pool.getConnection();
        console.log(`✅ MySQL conectado: ${process.env.DB_NAME}`);
        conn.release();
    } catch (e) {
        console.error('❌ MySQL erro:', e.message);
    }
})();

/* ── GEMINI ───────────────────────────────────────────────────── */
let genAI = null;
try {
    if (process.env.GEMINI_API_KEY) {
        genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        console.log('✅ Gemini inicializado');
    } else {
        console.warn('⚠️ GEMINI_API_KEY ausente — usando fallback');
    }
} catch (e) { console.error('❌ Gemini erro:', e.message); }

/* ── RESEND ───────────────────────────────────────────────────── */
let resend = null;
if (process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
    console.log('✅ Resend inicializado');
} else {
    console.warn('⚠️ RESEND_API_KEY ausente — envio de e-mail desativado');
}

function detectarHumor(texto) {
    if (!texto) return 'normal';
    const letras = (texto.match(/[A-Za-z]/g) || []).length;
    const caps   = (texto.match(/[A-Z]/g) || []).length;
    const pct    = letras > 0 ? (caps / letras) * 100 : 0;
    if (pct > 70 || /\*{4,}/.test(texto)) return 'raiva';
    if (/!{2,}|\?{2,}/.test(texto)) return 'estressado';
    return 'normal';
}

function instrucaoHumor(humor) {
    return {
        raiva:      'O usuário está irritado. Responda com empatia, calma, sem ser seco.',
        estressado: 'O usuário está estressado. Responda com leveza e tranquilidade.',
        normal:     ''
    }[humor] || '';
}

const MODELOS = [
    process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-3.1-flash-lite', // substitui os 1.5 mortos
];

async function chamarGemini(modelo, mensagem, historico, systemPrompt) {
    const m = genAI.getGenerativeModel({ model: modelo, systemInstruction: systemPrompt });
    const chat = m.startChat({
        history: historico.map(h => ({
            role: h.remetente === 'iana' ? 'model' : 'user',
            parts: [{ text: h.mensagem }]
        })),
        generationConfig: { maxOutputTokens: 2048 }
    });
    const result = await chat.sendMessage(mensagem);
    const txt = result.response.text();
    if (!txt?.trim()) throw new Error('Resposta vazia');
    return txt;
}

async function askGemini(mensagem, historico = [], instrucaoEmocional = '', configPrompt = '') {
    if (!genAI) return null;

    const system = (process.env.SYSTEM_PROMPT ||
        'Você é a Iana, assistente gamer animada, criativa, humanizada e solidária. Fala naturalmente, com personalidade, usa emojis quando cabe. Especialista em jogos, platinas, conquistas, builds, itens, chefões e estratégias. Também fala sobre filmes, séries e cultura nerd.')
        + (instrucaoEmocional ? `\n\n[TOM]: ${instrucaoEmocional}` : '')
        + (configPrompt ? `\n\n[PERSONALIZAÇÃO]:\n${configPrompt}` : '');

    for (const modelo of [...new Set(MODELOS)]) {
        for (let t = 0; t < 2; t++) {
            try {
                return await chamarGemini(modelo, mensagem, historico, system);
            } catch (err) {
                const status = err?.status || '';
                console.error(`[GEMINI] modelo=${modelo} tentativa=${t+1}:`, err.message);
                if ([429, 503].includes(status) || /overloaded|unavailable/i.test(err.message)) {
                    await new Promise(r => setTimeout(r, 800));
                    continue;
                }
                break;
            }
        }
    }
    return null;
}

function respostaSistema(mensagem) {
    const msg = mensagem.toLowerCase();
    if (/oi|olá|ola|hey|bom dia|boa tarde|boa noite/.test(msg))
        return `Oi! 👋 Que bom te ver aqui! Sou a Iana, sua parceira gamer. Como posso te ajudar hoje? 🎮`;
    if (/como.*vai|tudo bem|tudo bom/.test(msg))
        return `Tudo ótimo por aqui! 😊 Pronta pra te ajudar com qualquer conquista ou questão. O que você precisa?`;
    return `Ei! 😊 Estou tendo uma instabilidade de conexão agora, mas já volto ao normal. Você pode repetir ou tentar em instantes?`;
}

async function askPython(nome, conversa, mensagem) {
    return new Promise((resolve, reject) => {
        const py = process.env.IANA_PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
        const proc = spawn(py, [path.join(__dirname, 'iana.py'), nome, conversa, mensagem]);
        let out = '', err = '';
        let finalizado = false;

        // FIX: sem timeout, se o processo Python travar (ex: ChromaDB
        // preso, modelo de embeddings demorando pra carregar, rede lenta
        // na chamada do Gemini de dentro do Python), a requisição HTTP
        // fica pendurada pra sempre — o usuário nunca recebe resposta
        // nem erro. 25s dá folga pro cold start do modelo + chamada da API.
        const timeout = setTimeout(() => {
            if (finalizado) return;
            finalizado = true;
            proc.kill();
            reject(new Error('Timeout: processo Python demorou demais (25s)'));
        }, 25000);

        proc.stdout.on('data', d => out += d.toString());
        proc.stderr.on('data', d => err += d.toString());
        proc.on('close', code => {
            if (finalizado) return;
            finalizado = true;
            clearTimeout(timeout);
            if (code !== 0 || !out.trim()) return reject(new Error(err || `exit ${code}`));
            resolve(out.trim());
        });
        proc.on('error', e => {
            if (finalizado) return;
            finalizado = true;
            clearTimeout(timeout);
            reject(e);
        });
    });
}

/* ── PASSPORT ─────────────────────────────────────────────────── */
passport.use(new LocalStrategy(
    { usernameField: 'email', passwordField: 'senha' },
    async (email, senha, done) => {
        try {
            const [rows] = await pool.query('SELECT * FROM usuarios WHERE email=?', [email.trim().toLowerCase()]);
            if (!rows.length) return done(null, false, { message: 'Credenciais inválidas.' });
            const ok = await bcrypt.compare(senha.trim(), rows[0].senha || '');
            if (!ok) return done(null, false, { message: 'Credenciais inválidas.' });
            return done(null, rows[0]);
        } catch (e) { return done(e); }
    }
));

passport.serializeUser((u, done) => done(null, u.id));
passport.deserializeUser(async (id, done) => {
    try {
        const [r] = await pool.query('SELECT id,nome,email FROM usuarios WHERE id=?', [id]);
        done(null, r[0] || null);
    } catch (e) { done(e); }
});

const auth = (req, res, next) => req.isAuthenticated() ? next() : res.status(401).json({ erro: 'Login necessário.' });

/* ── RATE LIMIT (protege sua chave do Gemini e login de brute-force) ── */
const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Muitas mensagens em pouco tempo. Aguarde um instante.' }
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Muitas tentativas de login. Tente novamente mais tarde.' }
});

/* ── PÁGINAS ──────────────────────────────────────────────────── */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/configuracoes', (req, res) => res.sendFile(path.join(__dirname, 'public', 'configuracoes.html')));

/* ── AUTH ─────────────────────────────────────────────────────── */
app.post('/auth/registro', loginLimiter, async (req, res) => {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: 'Preencha todos os campos.' });
    if (senha.length < 8) return res.status(400).json({ erro: 'Senha mínima: 8 caracteres.' });
    const emailT = email.trim().toLowerCase();
    try {
        const [ex] = await pool.query('SELECT id FROM usuarios WHERE email=?', [emailT]);
        if (ex.length) return res.status(409).json({ erro: 'E-mail já cadastrado.' });
        const hash = await bcrypt.hash(senha.trim(), 12);
        const [r] = await pool.query('INSERT INTO usuarios (nome,email,senha) VALUES (?,?,?)', [nome.trim(), emailT, hash]);
        const [u] = await pool.query('SELECT id,nome,email FROM usuarios WHERE id=?', [r.insertId]);
        req.login(u[0], err => {
            if (err) return res.status(500).json({ erro: 'Erro de sessão.' });
            res.status(201).json({ usuario: u[0] });
        });
    } catch (e) { console.error('[REGISTRO]', e.message); res.status(500).json({ erro: 'Erro interno.' }); }
});

app.post('/auth/login', loginLimiter, (req, res, next) => {
    passport.authenticate('local', (err, usuario, info) => {
        if (err) return res.status(500).json({ erro: 'Erro interno.' });
        if (!usuario) return res.status(401).json({ erro: info?.message || 'Falha no login.' });
        req.login(usuario, err => {
            if (err) return res.status(500).json({ erro: 'Erro de sessão.' });
            res.json({ usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email } });
        });
    })(req, res, next);
});

app.post('/auth/logout', (req, res) => {
    req.logout(() => req.session.destroy(() => { res.clearCookie('iana.sid'); res.json({ ok: true }); }));
});

app.get('/auth/me', (req, res) => {
    if (!req.isAuthenticated()) return res.json({ logado: false });
    res.json({ logado: true, usuario: { id: req.user.id, nome: req.user.nome, email: req.user.email } });
});

app.post('/auth/esqueci-senha', loginLimiter, async (req, res) => {
    const email = req.body.email?.trim().toLowerCase();
    if (!email) return res.status(400).json({ erro: 'E-mail obrigatório.' });
    try {
        const [r] = await pool.query('SELECT id FROM usuarios WHERE email=?', [email]);
        if (r.length) {
            const codigo = Math.floor(100000 + Math.random() * 900000).toString();
            codigos.set(email, { codigo, exp: Date.now() + 15 * 60 * 1000 });

            if (resend) {
                const { error } = await resend.emails.send({
                    // FIX: precisa ser um remetente de domínio verificado no Resend.
                    // Enquanto não verificar seu domínio, use 'onboarding@resend.dev'
                    // (funciona, mas só entrega pro seu próprio e-mail de teste).
                    from: process.env.EMAIL_FROM || 'Iana <onboarding@resend.dev>',
                    to: email,
                    subject: 'Código de recuperação — Iana',
                    html: `<div style="font-family:sans-serif;background:#111;color:#fff;padding:30px;border-radius:12px;max-width:400px;margin:auto">
                        <h2 style="color:#a855f7">🎮 Iana</h2>
                        <p>Seu código:</p>
                        <div style="background:#1e1f20;border-radius:8px;padding:20px;text-align:center;margin:20px 0">
                            <span style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#a855f7">${codigo}</span>
                        </div>
                        <p style="color:#aaa;font-size:13px">Expira em 15 minutos.</p>
                    </div>`
                });
                if (error) {
                    // FIX: SDK do Resend não lança exceção em erro de API — retorna
                    // { error } no objeto de resposta. Se não checar isso aqui, o
                    // catch abaixo nunca pega e você acha que o e-mail foi enviado
                    // quando na verdade falhou silenciosamente.
                    console.error('[ESQUECI] Resend recusou o envio:', error);
                }
            } else {
                console.warn(`[ESQUECI] Código gerado para ${email}, mas RESEND_API_KEY não está configurada.`);
            }
        }
        res.json({ ok: true, msg: 'Se o e-mail existir, um código foi enviado.' });
    } catch (e) {
        console.error('[ESQUECI] Falha ao enviar e-mail:', e.message);
        res.status(500).json({ erro: 'Erro ao enviar.' });
    }
});

app.post('/auth/mudar-senha', async (req, res) => {
    const { codigo, nova_senha } = req.body;
    const email = req.body.email?.trim().toLowerCase();
    if (!email || !codigo || !nova_senha) return res.status(400).json({ erro: 'Dados incompletos.' });
    const token = codigos.get(email);
    if (!token || token.codigo !== codigo.trim() || Date.now() > token.exp)
        return res.status(400).json({ erro: 'Código inválido ou expirado.' });
    if (nova_senha.trim().length < 8) return res.status(400).json({ erro: 'Senha mínima: 8 caracteres.' });
    try {
        const hash = await bcrypt.hash(nova_senha.trim(), 12);
        await pool.query('UPDATE usuarios SET senha=? WHERE email=?', [hash, email]);
        codigos.delete(email);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ erro: 'Erro ao salvar.' }); }
});

/* ── CONVERSAS ────────────────────────────────────────────────── */
async function garantirConversa(idUsuario, idConversa, mensagem) {
    if (!idUsuario) return idConversa || null;
    const id = idConversa || `conv_${idUsuario}_${Date.now()}`;
    const titulo = mensagem.replace(/\[.*?\]/g,'').trim().slice(0,40) || 'Nova Conversa';
    try {
        await pool.query(
            'INSERT INTO conversas (id,usuario_id,titulo) VALUES (?,?,?) ON DUPLICATE KEY UPDATE titulo=titulo',
            [id, idUsuario, titulo + (titulo.length >= 40 ? '...' : '')]
        );
    } catch (e) { console.error('[DB garantirConversa]', e.message); }
    return id;
}

app.get('/chat/conversas', auth, async (req, res) => {
    try {
        const [r] = await pool.query(
            'SELECT id, titulo, fixada FROM conversas WHERE usuario_id=? ORDER BY fixada DESC, id DESC',
            [req.user.id]
        );
        res.json({ conversas: r.map(c => ({ id_conversa: c.id, titulo: c.titulo, fixada: !!c.fixada })) });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/chat/historico/:id', auth, async (req, res) => {
    try {
        const [r] = await pool.query(
            'SELECT mensagem, remetente, criado_em FROM mensagens WHERE conversa_id=? AND usuario_id=? ORDER BY id ASC',
            [req.params.id, req.user.id]
        );
        res.json({ mensagens: r.map(m => ({ conteudo: m.mensagem, tipo_sender: m.remetente === 'user' ? 'usuario' : 'iana', criado_em: m.criado_em })) });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/chat/conversas', auth, async (req, res) => {
    const { titulo } = req.body;
    const id = `conv_${req.user.id}_${Date.now()}`;
    try {
        await pool.query('INSERT INTO conversas (id,usuario_id,titulo) VALUES (?,?,?)', [id, req.user.id, titulo || 'Nova Conversa']);
        res.json({ id_conversa: id });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put('/chat/conversas/:id', auth, async (req, res) => {
    const { novoTitulo } = req.body;
    if (!novoTitulo?.trim()) return res.status(400).json({ erro: 'Título obrigatório.' });
    try {
        await pool.query('UPDATE conversas SET titulo=? WHERE id=? AND usuario_id=?', [novoTitulo.trim(), req.params.id, req.user.id]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.patch('/chat/conversas/:id/fixar', auth, async (req, res) => {
    try {
        await pool.query('UPDATE conversas SET fixada=? WHERE id=? AND usuario_id=?', [req.body.fixada ? 1 : 0, req.params.id, req.user.id]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/chat/conversas/:id', auth, async (req, res) => {
    try {
        await pool.query('DELETE FROM mensagens WHERE conversa_id=? AND usuario_id=?', [req.params.id, req.user.id]);
        await pool.query('DELETE FROM conversas WHERE id=? AND usuario_id=?', [req.params.id, req.user.id]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

/* ── CHAT STREAM ──────────────────────────────────────────────── */
app.post('/chat/stream', chatLimiter, async (req, res) => {
    const nome    = req.user?.nome || 'Visitante';
    const idUser  = req.user?.id || null;
    const msg     = req.body.mensagem?.trim();
    const config  = req.body.configPrompt || '';

    if (!msg) return res.status(400).json({ erro: 'Mensagem vazia.' });
    if (msg.length > 8000) return res.status(400).json({ erro: 'Mensagem muito longa.' });

    const idConv = await garantirConversa(idUser, req.body.idConversa, msg);

    if (idUser && idConv) {
        pool.query('INSERT INTO mensagens (conversa_id,usuario_id,remetente,mensagem) VALUES (?,?,?,?)', [idConv, idUser, 'user', msg]).catch(e => console.error('[DB msg user]', e.message));
    }

    let historico = [];
    if (idUser && idConv) {
        try {
            const [r] = await pool.query(
                'SELECT mensagem, remetente FROM mensagens WHERE conversa_id=? ORDER BY id DESC LIMIT 8',
                [idConv]
            );
            historico = r.reverse();
        } catch (e) { console.error('[DB historico]', e.message); }
    }

    const humor = req.body.estadoEmocional || detectarHumor(msg);
    let resposta = null;
    let origem = null;

    // 1) CAMINHO PRINCIPAL: Python — tem memória (ChromaDB) e a
    //    personalidade completa (REGRA 1-6). ENABLE_PYTHON=false só
    //    deve ser usado se você quiser desligar isso de propósito.
    if (process.env.ENABLE_PYTHON !== 'false') {
        try {
            resposta = await askPython(nome, idConv || 'geral', msg);
            origem = 'python';
        } catch (e) {
            console.error('[Python] falhou, caindo pro Gemini via Node:', e.message);
        }
    }

    // 2) FALLBACK: Gemini via SDK do Node (sem memória, prompt simples)
    if (!resposta) {
        resposta = await askGemini(msg, historico, instrucaoHumor(humor), config);
        origem = resposta ? 'gemini-node' : origem;
    }

    // 3) ÚLTIMO RECURSO: resposta fixa do sistema
    if (!resposta) {
        resposta = respostaSistema(msg);
        origem = 'sistema-fixo';
        console.warn('[AVISO] Python e Gemini falharam. Usando resposta do sistema.');
    }

    console.log(`[CHAT] origem=${origem}`);

    if (idUser && idConv) {
        pool.query('INSERT INTO mensagens (conversa_id,usuario_id,remetente,mensagem) VALUES (?,?,?,?)', [idConv, idUser, 'iana', resposta]).catch(e => console.error('[DB msg iana]', e.message));
    }

    res.json({ resposta, idConversa: idConv });
});

/* ── 404 ──────────────────────────────────────────────────────── */
app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

/* ── ERROR HANDLER GLOBAL ──────────────────────────────────────── */
app.use((err, req, res, next) => {
    console.error('[ERRO NÃO TRATADO]', err.message);
    if (err.message === 'Origem não permitida por CORS') {
        return res.status(403).json({ erro: 'Origem não permitida.' });
    }
    res.status(500).json({ erro: 'Erro interno no servidor.' });
});

/* ── START ────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3333;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Iana rodando na porta ${PORT}`));