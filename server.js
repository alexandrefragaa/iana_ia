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
import WebSocket from 'ws'; // npm install ws — cliente WS pra falar com a ElevenLabs

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

async function garantirColunaAtualizacaoConversas() {
    try {
        const [colunas] = await pool.query(
            'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?',
            [dbConfig.database, 'conversas', 'atualizado_em']
        );
        if (!colunas.length) {
            await pool.query(
                'ALTER TABLE conversas ADD COLUMN atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
            );
        }
    } catch (e) {
        console.error('❌ Migração da tabela conversas:', e.message);
    }
}

garantirColunaAtualizacaoConversas();

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

/* ── SOCKET.IO (voz em tempo real + sessão de visão) ─────────────── */
const server = http.createServer(app);
const io = new SocketIOServer(server, {
    cors: { origin: origensPermitidas, credentials: true }
});

io.engine.use((req, res, next) => sessionMiddleware(req, res, next));
io.use((socket, next) => {
    passport.initialize()(socket.request, {}, () => {
        passport.session()(socket.request, {}, () => {
            // Voz também funciona para visitantes; apenas o histórico
            // persistente continua restrito a usuários autenticados.
            next();
        });
    });
});

/* ── GEMINI (texto) ───────────────────────────────────────────── */
let genAI = null;
try {
    if (process.env.GEMINI_API_KEY) {
        genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        console.log('✅ Gemini inicializado');
    } else {
        console.warn('⚠️ GEMINI_API_KEY ausente — usando fallback');
    }
} catch (e) { console.error('❌ Gemini erro:', e.message); }

/* ── ELEVENLABS (voz da chamada) ──────────────────────────────────
   A voz de verdade da Iana (a que você modelou) só existe aqui, no
   backend. O Gemini só gera o TEXTO da resposta (rápido, modo
   normal); esse texto é mandado pra ElevenLabs, que devolve áudio
   PCM 16-bit 24kHz em pedacinhos via WebSocket — cada pedaço já sai
   pro navegador assim que chega, sem esperar a fala inteira ficar
   pronta. */
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '42swcOVaxVM4TNSGUmkc';
const ELEVEN_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';

function falarComElevenLabs(texto, { onAudioChunk, onFim, onErro }) {
    if (!process.env.ELEVENLABS_API_KEY) {
        onErro(new Error('ELEVENLABS_API_KEY não configurada no servidor.'));
        return;
    }
    if (!texto?.trim()) { onFim(); return; }

    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream-input`
        + `?model_id=${encodeURIComponent(ELEVEN_MODEL_ID)}&output_format=pcm_24000`;

    let finalizado = false;
    const ws = new WebSocket(url, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });

    const timeout = setTimeout(() => {
        if (finalizado) return;
        finalizado = true;
        try { ws.close(); } catch (e) { }
        onErro(new Error('Timeout esperando áudio da ElevenLabs.'));
    }, 20000);

    ws.on('open', () => {
        // 1ª mensagem: configura a voz. 2ª: o texto de verdade.
        // 3ª (texto vazio): sinaliza pro servidor deles que acabou —
        // sem isso a conexão fica esperando mais texto pra sempre.
        ws.send(JSON.stringify({
            text: ' ',
            voice_settings: { stability: 0.5, similarity_boost: 0.8, use_speaker_boost: true },
            generation_config: { chunk_length_schedule: [120, 160, 250, 290] }
        }));
        // Frases curtas precisam de flush para vencer o limite inicial do buffer.
        ws.send(JSON.stringify({ text: `${texto.trim()} `, flush: true }));
        ws.send(JSON.stringify({ text: '' }));
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.audio) onAudioChunk(msg.audio); // já vem em base64, PCM cru
            if (msg.error) {
                if (finalizado) return;
                finalizado = true;
                clearTimeout(timeout);
                onErro(new Error(msg.message || 'A ElevenLabs recusou a geração de áudio.'));
                try { ws.close(); } catch (e) { }
                return;
            }
            if (msg.isFinal) {
                if (finalizado) return;
                finalizado = true;
                clearTimeout(timeout);
                onFim();
                try { ws.close(); } catch (e) { }
            }
        } catch (e) {
            if (finalizado) return;
            finalizado = true;
            clearTimeout(timeout);
            onErro(e);
        }
    });

    ws.on('error', (e) => {
        if (finalizado) return;
        finalizado = true;
        clearTimeout(timeout);
        onErro(e);
    });
}

/* ── SOCKET.IO: eventos de voz e visão ────────────────────────── */
const historicoVozPorSocket = new Map(); // socket.id -> estado e últimas falas da chamada

const SYSTEM_PROMPT_VOZ =
    'Você está numa CHAMADA DE VOZ em tempo real (não é chat de texto). ' +
    'Fale de forma curta, natural e conversacional — como numa ligação de ' +
    'verdade — porque isso vai ser narrado em voz alta. Evite listas e ' +
    'textos longos. RESPONDA SEMPRE EM PORTUGUÊS DO BRASIL.';

io.on('connection', (socket) => {
    const idUser = socket.request.user?.id;
    if (idUser) socket.join(`user_${idUser}`);

    /* ── CHAMADA DE VOZ ──────────────────────────────────────────
       Fluxo: o navegador transcreve sua fala (SpeechRecognition) e
       manda só o TEXTO final aqui via 'voz:texto'. O servidor gera a
       resposta em texto (Gemini) e já manda pra ElevenLabs virar
       áudio com a voz modelada, streamando os pedaços de volta. */
    socket.on('voz:iniciar', async (dados = {}) => {
        const idConversa = dados.idConversa || null;
        let historico = [];

        if (socket.request.user?.id && idConversa) {
            try {
                const [r] = await pool.query(
                    'SELECT mensagem, remetente FROM mensagens WHERE conversa_id=? AND usuario_id=? ORDER BY id DESC LIMIT 8',
                    [idConversa, socket.request.user.id]
                );
                historico = r.reverse();
            } catch (e) {
                console.error('[DB histórico voz]', e.message);
            }
        }

        historicoVozPorSocket.set(socket.id, { idConversa, historico });
        socket.emit('voz:pronto');
    });

    socket.on('voz:texto', async (textoRecebido) => {
        const msg = String(textoRecebido || '').trim();
        if (!msg) return;
        if (msg.length > 2000) {
            socket.emit('voz:erro', { mensagem: 'Fala muito longa.' });
            return;
        }

        const nome = socket.request.user?.nome || 'Visitante';
        const estado = historicoVozPorSocket.get(socket.id) || { idConversa: null, historico: [] };
        const historico = estado.historico || [];
        const idConversa = await garantirConversa(
            socket.request.user?.id || null,
            estado.idConversa,
            msg
        );
        estado.idConversa = idConversa;

        try {
            const resposta = await gerarRespostaIA({
                nome,
                idConv: idConversa,
                msg,
                historico,
                humor: detectarHumor(msg),
                config: SYSTEM_PROMPT_VOZ
            });

            historico.push({ remetente: 'user', mensagem: msg });
            historico.push({ remetente: 'iana', mensagem: resposta });
            estado.historico = historico.slice(-10);
            historicoVozPorSocket.set(socket.id, estado);

            if (socket.request.user?.id && idConversa) {
                await pool.query(
                    'INSERT INTO mensagens (conversa_id,usuario_id,remetente,mensagem) VALUES (?,?,?,?)',
                    [idConversa, socket.request.user.id, 'user', msg]
                );
                await pool.query(
                    'INSERT INTO mensagens (conversa_id,usuario_id,remetente,mensagem) VALUES (?,?,?,?)',
                    [idConversa, socket.request.user.id, 'iana', resposta]
                );
            }

            socket.emit('voz:transcricao-iana', { texto: resposta, conversa_id: idConversa });

            falarComElevenLabs(resposta, {
                onAudioChunk: (base64) => socket.emit('voz:audio-resposta', { audio: base64 }),
                onFim: () => socket.emit('voz:fala-finalizada'),
                onErro: (e) => {
                    console.error('[ELEVENLABS]', e.message);
                    socket.emit('voz:erro', { mensagem: 'Erro ao gerar a voz da Iana.' });
                }
            });
        } catch (e) {
            console.error('[VOZ TEXTO]', e.message);
            socket.emit('voz:erro', { mensagem: 'Erro ao processar sua fala.' });
        }
    });

    // Você começou a falar em cima da fala dela — o navegador já
    // detecta e para de tocar sozinho; esse evento só existe pra
    // avisar o servidor caso ele precise abortar algo em andamento.
    socket.on('voz:interromper', () => {
        socket.emit('voz:interrompido');
    });

    socket.on('voz:encerrar', () => {
        historicoVozPorSocket.delete(socket.id);
    });

    socket.on('disconnect', () => {
        historicoVozPorSocket.delete(socket.id);
    });
});

/* ── SENDGRID ─────────────────────────────────────────────────── */
let sendgridPronto = false;
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    sendgridPronto = true;
    console.log('✅ SendGrid inicializado');
} else {
    console.warn('⚠️ SENDGRID_API_KEY ausente — envio de e-mail desativado');
}

const LOCAL_ONLY = process.env.IANA_LOCAL_ONLY === 'true';
if (LOCAL_ONLY) {
    console.log('⚠️ IANA_LOCAL_ONLY ativado — respostas sem Gemini / Google / ChatGPT');
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
        // FIX: 'frustrado' vem do detectarEstadoEmocional() do
        // features.js (agora enviado pelo chat.js em estadoEmocional),
        // mas essa função não reconhecia esse valor — caía no ||''
        // e a instrução era ignorada silenciosamente.
        frustrado:  'O usuário parece frustrado. Responda com paciência, sem soar impaciente ou repetitivo.',
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
    if (LOCAL_ONLY) return null;
    if (!genAI) return null;

    const system = (process.env.SYSTEM_PROMPT ||
        'Você é a Iana, uma assistente gamer animada, criativa, humanizada e solidária. ' +
        'Tem personalidade forte, fala naturalmente com gírias e emojis quando cabe. ' +
        'É especialista em platinas, troféus, conquistas, builds, itens, localização de ' +
        'objetos, rotas, itens, estratégias e chefões. Também adora falar sobre filmes, séries ' +
        'e cultura nerd, games. ' +
        'REGRA DE CONVERSA: Em cumprimentos, perguntas sobre como você está ou reflexões normais, seja super breve, natural, sem "textão" e apenas siga o fluxo da conversa. ' +
        'Por outro lado, quando o usuário tiver uma dúvida de jogo e você tiver informações no contexto, usa TUDO para criar uma resposta completa, detalhada e útil, e mostra serviço. Nesse caso específico, sempre faz uma pergunta no final para continuar ajudando o usuário.')
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
        return `Opa, e aí! 👋 Tudo tranquilo por aí?`;
    if (/como.*vai|tudo bem|tudo bom/.test(msg))
        return `Tudo 100% por aqui! E com você, jogando algo legal hoje?`;
    return `Opa, deu uma piscada rápida na minha conexão aqui. Me manda de novo rapidinho?`;
}

async function askPython(nome, conversa, mensagem, historico = [], configRaw = {}) {
    return new Promise((resolve, reject) => {
        const py = process.env.IANA_PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
        const historicoJSON = JSON.stringify(historico);
        // FIX: iana.py lê argv[5] como o objeto de configuração
        // (personalidade/foco/plataforma/voz/tamanho/emojis/instrucoes/
        // sobreVoce/perguntas/humor/criatividade/contexto) via
        // montar_config_prompt() — antes esse argumento nunca era
        // mandado, então as configurações do usuário eram ignoradas
        // sempre que o Python respondia com sucesso (o caminho
        // principal, já que ele roda antes do fallback Gemini-node).
        const configJSON = JSON.stringify(configRaw || {});
        const proc = spawn(py, [path.join(__dirname, 'iana.py'), nome, conversa, mensagem, historicoJSON, configJSON]);
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
   Usado por /chat (texto) e pela chamada de voz (voz:texto). */
async function gerarRespostaIA({ nome, idConv, msg, historico, humor, config, configRaw }) {
    let resposta = null, origem = null;

    if (process.env.ENABLE_PYTHON !== 'false') {
        try {
            resposta = await askPython(nome, idConv || 'geral', msg, historico, configRaw);
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
        if (LOCAL_ONLY) {
            console.warn('[AVISO] Modo local ativo: usando resposta interna sem Gemini.');
        } else {
            console.warn('[AVISO] Python e Gemini falharam. Usando resposta do sistema.');
        }
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
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/configuracoes', (req, res) => res.sendFile(path.join(__dirname, 'public', 'configuraçoes.html')));

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

app.post('/auth/trocar-senha', auth, async (req, res) => {
    const senhaAtual = req.body.senhaAtual?.trim();
    const novaSenha = req.body.novaSenha?.trim();
    if (!senhaAtual || !novaSenha) return res.status(400).json({ erro: 'Preencha senha atual e nova senha.' });
    if (novaSenha.length < 8) return res.status(400).json({ erro: 'Senha mínima: 8 caracteres.' });
    try {
        const [rows] = await pool.query('SELECT senha FROM usuarios WHERE id=?', [req.user.id]);
        if (!rows.length) return res.status(404).json({ erro: 'Usuário não encontrado.' });
        const ok = await bcrypt.compare(senhaAtual, rows[0].senha || '');
        if (!ok) return res.status(400).json({ erro: 'Senha atual incorreta.' });
        const hash = await bcrypt.hash(novaSenha, 12);
        await pool.query('UPDATE usuarios SET senha=? WHERE id=?', [hash, req.user.id]);
        res.json({ ok: true });
    } catch (e) {
        console.error('[TROCAR SENHA]', e.message);
        res.status(500).json({ erro: 'Erro interno.' });
    }
});

app.get('/auth/me', (req, res) => {
    if (!req.isAuthenticated()) return res.json({ logado: false });
    res.json({ logado: true, usuario: { id: req.user.id, nome: req.user.nome, email: req.user.email } });
});

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
                    console.error(`[ESQUECI] SendGrid recusou o envio para ${email}:`, detalhe);
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
    const texto = req.body.feedback?.trim();
    if (!texto) return res.status(400).json({ erro: 'Descreva seu feedback.' });

    if (!sendgridPronto) {
        console.warn('[FEEDBACK] Recebido mas SENDGRID_API_KEY não configurada:', texto);
        return res.status(503).json({ erro: 'Envio de feedback temporariamente indisponível.' });
    }

    try {
        await sgMail.send({
            from: process.env.EMAIL_FROM || 'iana@example.com',
            to: process.env.FEEDBACK_TO_EMAIL || process.env.EMAIL_FROM,
            replyTo: req.user?.email || undefined,
            subject: '[Iana Feedback]',
            html: `<div style="font-family:sans-serif;padding:20px">
                <p><strong>De:</strong> ${req.user?.nome || 'Visitante'} (${req.user?.email || 'sem login'})</p>
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
    const titulo = mensagem.replace(/\[.*?\]/g, '').trim().slice(0, 40) || 'Nova Conversa';
    try {
        await pool.query(
            'INSERT INTO conversas (id,usuario_id,titulo,atualizado_em) VALUES (?,?,?,NOW()) ON DUPLICATE KEY UPDATE atualizado_em=NOW()',
            [id, idUsuario, titulo + (titulo.length >= 40 ? '...' : '')]
        );
    } catch (e) { console.error('[DB garantirConversa]', e.message); }
    return id;
}

app.get('/conversas', auth, async (req, res) => {
    try {
        const [r] = await pool.query(
            'SELECT id, titulo, fixada, atualizado_em FROM conversas WHERE usuario_id=? ORDER BY fixada DESC, atualizado_em DESC, id DESC',
            [req.user.id]
        );
        res.json(r.map(c => ({ id: c.id, titulo: c.titulo, fixada: !!c.fixada, updatedAt: c.atualizado_em })));
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/conversas/:id', auth, async (req, res) => {
    try {
        const [r] = await pool.query(
            'SELECT mensagem, remetente, criado_em FROM mensagens WHERE conversa_id=? AND usuario_id=? ORDER BY id ASC',
            [req.params.id, req.user.id]
        );
        res.json({
            id: req.params.id,
            mensagens: r.map(m => ({ role: m.remetente === 'user' ? 'user' : 'assistant', content: m.mensagem, criado_em: m.criado_em }))
        });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.patch('/conversas/:id', auth, async (req, res) => {
    const titulo = req.body.titulo?.trim();
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório.' });
    try {
        await pool.query('UPDATE conversas SET titulo=? WHERE id=? AND usuario_id=?', [titulo, req.params.id, req.user.id]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/conversas/:id/fixar', auth, async (req, res) => {
    try {
        const [r] = await pool.query('SELECT fixada FROM conversas WHERE id=? AND usuario_id=?', [req.params.id, req.user.id]);
        if (!r.length) return res.status(404).json({ erro: 'Conversa não encontrada.' });
        const novoValor = r[0].fixada ? 0 : 1;
        await pool.query('UPDATE conversas SET fixada=? WHERE id=? AND usuario_id=?', [novoValor, req.params.id, req.user.id]);
        res.json({ ok: true, fixada: !!novoValor });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/conversas/:id', auth, async (req, res) => {
    try {
        await pool.query('DELETE FROM mensagens WHERE conversa_id=? AND usuario_id=?', [req.params.id, req.user.id]);
        await pool.query('DELETE FROM conversas WHERE id=? AND usuario_id=?', [req.params.id, req.user.id]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

/* ── CHAT (texto) ─────────────────────────────────────────────── */
app.post('/chat', chatLimiter, async (req, res) => {
    const nome   = req.user?.nome || 'Visitante';
    const idUser = req.user?.id || null;
    const msg    = (req.body.mensagem || req.body.message || '').trim();
    const config = req.body.config || req.body.configuracao || '';
    // FIX: objeto de configuração cru (o que chat.js vai passar a
    // mandar em configRaw), usado só pelo iana.py — o texto acima
    // (config/configuracao) continua sendo o que o Gemini via Node usa.
    const configRaw = (req.body.configRaw && typeof req.body.configRaw === 'object') ? req.body.configRaw : {};
    const idConvBody = req.body.conversa_id || req.body.id_conversa || null;

    if (!msg) return res.status(400).json({ erro: 'Mensagem vazia.' });
    if (msg.length > 8000) return res.status(400).json({ erro: 'Mensagem muito longa.' });

    // NOTA: anexos (imagem/áudio/arquivo) vêm no payload mas ainda não
    // são analisados pelo Gemini aqui — só o texto placeholder que o
    // chat.js já manda junto (ex: "[Usuário enviou uma imagem: x.png]")
    // é usado. Analisar o conteúdo de verdade (visão) é um passo à parte.

    const contextoLinks = await montarContextoLinks(msg);
    const idConv = await garantirConversa(idUser, idConvBody, msg);

    if (idUser && idConv) {
        await pool.query('INSERT INTO mensagens (conversa_id,usuario_id,remetente,mensagem) VALUES (?,?,?,?)', [idConv, idUser, 'user', msg]);
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
    const resposta = await gerarRespostaIA({ nome, idConv, msg: msgParaIA, historico, humor, config, configRaw });

    if (idUser && idConv) {
        await pool.query('INSERT INTO mensagens (conversa_id,usuario_id,remetente,mensagem) VALUES (?,?,?,?)', [idConv, idUser, 'iana', resposta]);
    }

    res.json({ resposta, conversa_id: idConv, id_conversa: idConv });
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