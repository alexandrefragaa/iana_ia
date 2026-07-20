import express from 'express';
import session from 'express-session';
import MySQLStore from 'express-mysql-session';
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
import sgMail from '@sendgrid/mail';

dotenv.config();

console.log('[DEBUG] ALLOWED_ORIGINS =', JSON.stringify(process.env.ALLOWED_ORIGINS));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const codigos = new Map();

if (!process.env.SESSION_SECRET) {
    console.error('❌ SESSION_SECRET não definido no .env'); process.exit(1);
}

/* ── MYSQL (Criado ANTES para o store da sessão usar) ────────────────── */
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'mysql-7ddcebe.aivencloud.com',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 12788,
    user: process.env.DB_USER || 'avnadmin',
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

// Configuração do Session Store no MySQL do Aiven (agora com o pool disponível)
const MySQLStoreSession = MySQLStore(session);
const sessionStore = new MySQLStoreSession({}, pool);

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
    store: sessionStore, // Salva as sessões com segurança no Aiven
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

app.use(passport.initialize());
app.use(passport.session());

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

/* ── SENDGRID ─────────────────────────────────────────────────── */
let sendgridPronto = false;
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    sendgridPronto = true;
    console.log('✅ SendGrid inicializado');
} else {
    console.warn('⚠️ SENDGRID_API_KEY ausente — envio de e-mail desativado');
}

function detectarHumor(texto) {
    if (!texto) return 'normal';
    const letras = (texto.match(/[A-Za-z]/g) || []).length;
    const caps = (texto.match(/[A-Z]/g) || []).length;
    const pct = letras > 0 ? (caps / letras) * 100 : 0;
    if (pct > 70 || /\*{4,}/.test(texto)) return 'raiva';
    if (/!{2,}|\?{2,}/.test(texto)) return 'estressado';
    return 'normal';
}

function instrucaoHumor(humor) {
    return {
        raiva: 'O usuário está irritado. Responda com empatia, calma, sem ser seco.',
        estressado: 'O usuário está estressado. Responda com leveza e tranquilidade.',
        normal: ''
    }[humor] || '';
}

const MODELOS = [
    process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-3.1-flash-lite',
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
        'Você é a Iana, assistente gamer animada, criativa, humanizada e solidária. Fala naturalmente, com personalidade, usa emojis quando cabe.')
        + (instrucaoEmocional ? `\n\n[TOM]: ${instrucaoEmocional}` : '')
        + (configPrompt ? `\n\n[PERSONALIZAÇÃO]:\n${configPrompt}` : '');

    for (const modelo of [...new Set(MODELOS)]) {
        for (let t = 0; t < 2; t++) {
            try {
                return await chamarGemini(modelo, mensagem, historico, system);
            } catch (err) {
                const status = err?.status || '';
                console.error(`[GEMINI] modelo=${modelo} tentativa=${t + 1}:`, err.message);
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
        return `Oi! 👋 Que bom te ver aqui!`;
    if (/como.*vai|tudo bem|tudo bom/.test(msg))
        return `Tudo ótimo por aqui! 😊`;
    return `Ei! 😊 Estou tendo uma instabilidade de conexão agora, mas já volto ao normal. Você pode repetir ou tentar em instantes?`;
}

async function askPython(nome, conversa, mensagem, historico = [], idUser = null) {
    return new Promise((resolve, reject) => {
        const py = process.env.IANA_PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
        const historicoJSON = JSON.stringify(historico);
        const scriptPath = path.join(__dirname, 'core', 'iana.py');

        const args = [
            scriptPath,
            nome,
            conversa,
            mensagem,
            historicoJSON,
            idUser ? idUser.toString() : ''
        ];

        const proc = spawn(py, args, {
            env: { ...process.env, PYTHONPATH: __dirname }
        });

        let out = '', err = '';
        let finalizado = false;

        const timeout = setTimeout(() => {
            if (finalizado) return;
            finalizado = true;
            proc.kill();
            reject(new Error('Timeout: processo Python demorou mais de 25s'));
        }, 25000);

        proc.stdout.on('data', d => out += d.toString());
        proc.stderr.on('data', d => err += d.toString());

        proc.on('close', code => {
            if (finalizado) return;
            finalizado = true;
            clearTimeout(timeout);

            if (code !== 0) {
                reject(new Error(`Python falhou com código ${code}: ${err}`));
            } else if (!out.trim()) {
                reject(new Error('Python retornou vazio: ' + err));
            } else {
                resolve(out.trim());
            }
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

/* ── RATE LIMIT ───────────────────────────────────────────────── */
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

/* ── PÁGINAS & ROTAS ──────────────────────────────────────────── */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/configuracoes', (req, res) => res.sendFile(path.join(__dirname, 'public', 'configuracoes.html')));

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

/* ── CONVERSAS & STREAM ───────────────────────────────────────── */
async function garantirConversa(idUsuario, idConversa, mensagem) {
    if (!idUsuario) return idConversa || null;
    const id = idConversa || `conv_${idUsuario}_${Date.now()}`;
    const titulo = mensagem.replace(/\[.*?\]/g, '').trim().slice(0, 40) || 'Nova Conversa';
    try {
        await pool.query(
            'INSERT INTO conversas (id,usuario_id,titulo) VALUES (?,?,?) ON DUPLICATE KEY UPDATE titulo=titulo',
            [id, idUsuario, titulo + (titulo.length >= 40 ? '...' : '')]
        );
    } catch (e) { console.error('[DB garantirConversa]', e.message); }
    return id;
}

app.post('/chat/stream', chatLimiter, async (req, res) => {
    const nome = req.user?.nome || 'Visitante';
    const idUser = req.user?.id || null;
    const msg = req.body.mensagem?.trim();
    const config = req.body.configPrompt || '';

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

    if (process.env.ENABLE_PYTHON !== 'false') {
        try {
            resposta = await askPython(nome, idConv || 'geral', msg, historico, idUser);
            origem = 'python';
        } catch (e) {
            console.error('[Python] falhou, caindo pro Gemini via Node:', e.message);
        }
    }

    if (!resposta) {
        resposta = await askGemini(msg, historico, instrucaoHumor(humor), config);
        origem = resposta ? 'gemini-node' : origem;
    }

    if (!resposta) {
        resposta = respostaSistema(msg);
        origem = 'sistema-fixo';
    }

    if (idUser && idConv) {
        pool.query('INSERT INTO mensagens (conversa_id,usuario_id,remetente,mensagem) VALUES (?,?,?,?)', [idConv, idUser, 'iana', resposta]).catch(e => console.error('[DB msg iana]', e.message));
    }

    res.json({ resposta, idConversa: idConv });
});

app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

app.use((err, req, res, next) => {
    console.error('[ERRO NÃO TRATADO]', err.message);
    if (err.message === 'Origem não permitida por CORS') {
        return res.status(403).json({ erro: 'Origem não permitida.' });
    }
    res.status(500).json({ erro: 'Erro interno no servidor.' });
});

const PORT = process.env.PORT || 3333;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Iana rodando na porta ${PORT}`));