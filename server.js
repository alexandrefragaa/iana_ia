import express from 'express';
import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
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
import dns from 'dns';
import * as cheerio from 'cheerio';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import crypto from 'crypto';

dotenv.config();

console.log('[DEBUG] ALLOWED_ORIGINS =', JSON.stringify(process.env.ALLOWED_ORIGINS));

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app        = express();
const codigos    = new Map();
const dnsLookup  = dns.promises.lookup;

if (!process.env.SESSION_SECRET) {
    console.error('❌ SESSION_SECRET não definido no .env'); process.exit(1);
}

const MySQLStore = MySQLStoreFactory(session);

/* ── MIDDLEWARES BÁSICOS ──────────────────────────────────────── */
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

/* ── MYSQL ────────────────────────────────────────────────────── */
const dbConfig = {
    host:     process.env.DB_HOST || 'mysql-7ddcebe.aivencloud.com',
    port:     process.env.DB_PORT ? Number(process.env.DB_PORT) : 12788,
    user:     process.env.DB_USER || 'avnadmin',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'defaultdb',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
};

const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10
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

/* ── SESSÃO (persistente no MySQL — sobrevive a restart/sleep do Render) ── */
const sessionStore = new MySQLStore(dbConfig);
sessionStore.onReady()
    .then(() => console.log('✅ Session store (MySQL) pronto'))
    .catch(e => console.error('❌ Session store erro:', e.message));

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    store: sessionStore,
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
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

/* ── SOCKET.IO (mensagens em tempo real — usado pela sessão de visão) ── */
const server = http.createServer(app);
const io = new SocketIOServer(server, {
    cors: { origin: origensPermitidas, credentials: true }
});

io.engine.use((req, res, next) => sessionMiddleware(req, res, next));
io.use((socket, next) => {
    passport.initialize()(socket.request, {}, () => {
        passport.session()(socket.request, {}, () => {
            if (socket.request.isAuthenticated?.()) return next();
            next(new Error('não autenticado'));
        });
    });
});

io.on('connection', (socket) => {
    const idUser = socket.request.user?.id;
    if (idUser) socket.join(`user_${idUser}`);
});

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

async function askPython(nome, conversa, mensagem, historico = []) {
    return new Promise((resolve, reject) => {
        const py = process.env.IANA_PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
        const historicoJSON = JSON.stringify(historico);
        const proc = spawn(py, [path.join(__dirname, 'iana.py'), nome, conversa, mensagem, historicoJSON]);
        let out = '', err = '';
        let finalizado = false;

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

/* Gera a resposta da IA reaproveitando a cadeia Python → Gemini → fixo.
   Usado tanto pelo /chat/stream quanto pelo /chat/visao. */
async function gerarRespostaIA({ nome, idConv, msg, historico, humor, config }) {
    let resposta = null, origem = null;

    if (process.env.ENABLE_PYTHON !== 'false') {
        try {
            resposta = await askPython(nome, idConv || 'geral', msg, historico);
            origem = 'python';
        } catch (e) { console.error('[Python] falhou, caindo pro Gemini via Node:', e.message); }
    }
    if (!resposta) {
        resposta = await askGemini(msg, historico, instrucaoHumor(humor), config);
        origem = resposta ? 'gemini-node' : origem;
    }
    if (!resposta) {
        resposta = respostaSistema(msg);
        origem = 'sistema-fixo';
        console.warn('[AVISO] Python e Gemini falharam. Usando resposta do sistema.');
    }
    console.log(`[CHAT] origem=${origem}`);
    return resposta;
}

/* ── LEITURA DE LINKS ─────────────────────────────────────────── */
function extrairLinks(texto) {
    const regex = /https?:\/\/[^\s<>"']+/gi;
    const found = texto.match(regex) || [];
    return [...new Set(found.map(u => u.replace(/[.,;:)\]}]+$/, '')))].slice(0, 3);
}

function ipEhPrivado(ip) {
    if (ip.includes(':')) {
        const ipLower = ip.toLowerCase();
        return ipLower === '::1' || ipLower.startsWith('fe80:') ||
               ipLower.startsWith('fc') || ipLower.startsWith('fd');
    }
    const partes = ip.split('.').map(Number);
    if (partes.length !== 4 || partes.some(isNaN)) return true;
    const [a, b] = partes;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    if (a >= 224) return true;
    return false;
}

async function buscarConteudoLink(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;

    try {
        const { address } = await dnsLookup(parsed.hostname);
        if (ipEhPrivado(address)) {
            console.warn(`[LINK] Bloqueado (IP privado): ${url} → ${address}`);
            return null;
        }
    } catch (e) {
        console.warn(`[LINK] DNS falhou para ${url}:`, e.message);
        return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
        const res = await fetch(parsed.toString(), {
            signal: controller.signal,
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IanaBot/1.0)' }
        });
        clearTimeout(timeout);

        const tipo = res.headers.get('content-type') || '';
        if (!res.ok || !tipo.includes('text/html')) return null;

        const reader = res.body.getReader();
        let recebido = '';
        let bytes = 0;
        const LIMITE = 1_500_000;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > LIMITE) { controller.abort(); break; }
            recebido += Buffer.from(value).toString('utf-8');
        }

        const $ = cheerio.load(recebido);
        $('script, style, nav, footer, noscript, svg, iframe').remove();
        const titulo = $('title').first().text().trim();
        const texto = $('body').text().replace(/\s+/g, ' ').trim();

        if (!texto) return null;

        return { url: parsed.toString(), titulo: titulo || parsed.hostname, texto: texto.slice(0, 4000) };
    } catch (e) {
        clearTimeout(timeout);
        console.warn(`[LINK] Falha ao ler ${url}:`, e.message);
        return null;
    }
}

async function montarContextoLinks(mensagem) {
    const links = extrairLinks(mensagem);
    if (!links.length) return '';
    const resultados = await Promise.all(links.map(buscarConteudoLink));
    const validos = resultados.filter(Boolean);
    if (!validos.length) return '';
    return validos.map(r => `[Conteúdo do link ${r.url} — "${r.titulo}"]:\n${r.texto}`).join('\n\n');
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

/* Autenticação por token — usada pelo app local de visão (iana_visao.py),
   que não tem cookie de navegador. */
function gerarToken() { return crypto.randomBytes(32).toString('hex'); }
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

const authToken = async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ erro: 'Token ausente.' });
    try {
        const [r] = await pool.query('SELECT id,nome,email FROM usuarios WHERE api_token_hash=?', [hashToken(token)]);
        if (!r.length) return res.status(401).json({ erro: 'Token inválido.' });
        req.user = r[0];
        next();
    } catch (e) { res.status(500).json({ erro: 'Erro de autenticação.' }); }
};

/* ── RATE LIMIT ───────────────────────────────────────────────── */
const chatLimiter = rateLimit({
    windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
    message: { erro: 'Muitas mensagens em pouco tempo. Aguarde um instante.' }
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
    message: { erro: 'Muitas tentativas de login. Tente novamente mais tarde.' }
});

const visionLimiter = rateLimit({
    windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
    message: { erro: 'Muitas análises de tela em pouco tempo.' }
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

// Gera (ou renova) o token pro app local de visão. Chamar autenticado
// no navegador; o token só é mostrado nessa resposta.
app.post('/auth/gerar-token', auth, async (req, res) => {
    const token = gerarToken();
    try {
        await pool.query('UPDATE usuarios SET api_token_hash=? WHERE id=?', [hashToken(token), req.user.id]);
        res.json({ token });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/auth/esqueci-senha', loginLimiter, async (req, res) => {
    const email = req.body.email?.trim().toLowerCase();
    if (!email) return res.status(400).json({ erro: 'E-mail obrigatório.' });
    try {
        const [r] = await pool.query('SELECT id FROM usuarios WHERE email=?', [email]);
        if (r.length) {
            const codigo = Math.floor(100000 + Math.random() * 900000).toString();
            codigos.set(email, { codigo, exp: Date.now() + 15 * 60 * 1000 });

            if (sendgridPronto) {
                try {
                    await sgMail.send({
                        from: process.env.EMAIL_FROM || 'iana@example.com',
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
                } catch (sgErro) {
                    const detalhe = sgErro.response?.body?.errors?.map(e => e.message).join('; ') || sgErro.message;
                    const dicaSender = /does not match a verified Sender|from address/i.test(detalhe)
                        ? ' → Causa provável: o remetente em EMAIL_FROM não foi verificado no SendGrid (Settings > Sender Authentication > Single Sender Verification).'
                        : '';
                    console.error(`[ESQUECI] SendGrid recusou o envio para ${email}:`, detalhe, dicaSender);
                }
            } else {
                console.warn(`[ESQUECI] Código gerado para ${email}, mas SENDGRID_API_KEY não está configurada.`);
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

/* ── FEEDBACK ─────────────────────────────────────────────────── */
app.post('/feedback', chatLimiter, async (req, res) => {
    const assunto = req.body.assunto?.trim();
    const texto = req.body.texto?.trim();
    const autorizou = !!req.body.autorizou;

    if (!assunto || !texto) return res.status(400).json({ erro: 'Preencha assunto e mensagem.' });
    if (!autorizou) return res.status(400).json({ erro: 'É necessário autorizar o uso do feedback.' });

    if (!sendgridPronto) {
        console.warn('[FEEDBACK] Recebido mas SENDGRID_API_KEY não configurada:', { assunto, texto });
        return res.status(503).json({ erro: 'Envio de feedback temporariamente indisponível.' });
    }

    try {
        await sgMail.send({
            from: process.env.EMAIL_FROM || 'iana@example.com',
            to: process.env.FEEDBACK_TO_EMAIL || process.env.EMAIL_FROM,
            replyTo: req.user?.email || undefined,
            subject: `[Iana Feedback] ${assunto}`,
            html: `<div style="font-family:sans-serif;padding:20px">
                <p><strong>De:</strong> ${req.user?.nome || 'Visitante'} (${req.user?.email || 'sem login'})</p>
                <p><strong>Assunto:</strong> ${assunto}</p>
                <p><strong>Mensagem:</strong></p>
                <p>${texto.replace(/\n/g, '<br>')}</p>
            </div>`
        });
        res.json({ ok: true });
    } catch (e) {
        const detalhe = e.response?.body?.errors?.map(er => er.message).join('; ') || e.message;
        console.error('[FEEDBACK] SendGrid recusou o envio:', detalhe);
        res.status(500).json({ erro: 'Erro ao enviar feedback.' });
    }
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

    const contextoLinks = await montarContextoLinks(msg);

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

    const msgParaIA = contextoLinks
        ? `${msg}\n\n[CONTEXTO — conteúdo extraído do(s) link(s) enviado(s) pelo usuário, use isso pra responder]:\n${contextoLinks}`
        : msg;

    const humor = req.body.estadoEmocional || detectarHumor(msg);
    const resposta = await gerarRespostaIA({ nome, idConv, msg: msgParaIA, historico, humor, config });

    if (idUser && idConv) {
        pool.query('INSERT INTO mensagens (conversa_id,usuario_id,remetente,mensagem) VALUES (?,?,?,?)', [idConv, idUser, 'iana', resposta]).catch(e => console.error('[DB msg iana]', e.message));
    }

    res.json({ resposta, idConversa: idConv });
});

/* ── VISÃO EM TEMPO REAL (app local → backend) ──────────────────── */
app.post('/chat/visao', visionLimiter, authToken, async (req, res) => {
    const nome    = req.user.nome;
    const idUser  = req.user.id;
    const resumo  = req.body.resumo?.trim();

    if (!resumo) return res.status(400).json({ erro: 'Resumo vazio.' });
    if (resumo.length > 3000) return res.status(400).json({ erro: 'Resumo muito longo.' });

    const idConv = await garantirConversa(idUser, req.body.idConversa, 'Sessão de visão em tempo real');

    let historico = [];
    try {
        const [r] = await pool.query(
            'SELECT mensagem, remetente FROM mensagens WHERE conversa_id=? ORDER BY id DESC LIMIT 6',
            [idConv]
        );
        historico = r.reverse();
    } catch (e) { console.error('[DB historico visao]', e.message); }

    const msg = `[LEITURA AUTOMÁTICA DE TELA em tempo real — comente de forma breve e útil, como se estivesse acompanhando o jogo ao vivo]:\n${resumo}`;

    const resposta = await gerarRespostaIA({ nome, idConv, msg, historico, humor: 'normal', config: '' });

    pool.query('INSERT INTO mensagens (conversa_id,usuario_id,remetente,mensagem) VALUES (?,?,?,?)',
        [idConv, idUser, 'iana', resposta]).catch(e => console.error('[DB msg visao]', e.message));

    io.to(`user_${idUser}`).emit('nova_mensagem', { idConversa: idConv, resposta });

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
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Iana rodando na porta ${PORT}`));