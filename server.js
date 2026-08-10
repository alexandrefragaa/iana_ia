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
import { GoogleGenAI, Modality } from '@google/genai';
import sgMail from '@sendgrid/mail';
import dns from 'dns';
import * as cheerio from 'cheerio';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import crypto from 'crypto';
import { existsSync } from 'fs';

dotenv.config();

console.log(
    '[DEBUG] ALLOWED_ORIGINS =',
    JSON.stringify(process.env.ALLOWED_ORIGINS)
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const codigos = new Map();
const dnsLookup = dns.promises.lookup;

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    console.error('❌ SESSION_SECRET ausente ou curto demais (mínimo recomendado: 32 caracteres).');
    process.exit(1);
}

/* =========================================================
   MIDDLEWARES
========================================================= */

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

app.set('trust proxy', 1);

const origensPermitidas = (
    process.env.ALLOWED_ORIGINS ||
    'http://localhost:3333'
)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

app.use(
    cors({
        origin: (origin, cb) => {
            if (!origin || origensPermitidas.includes(origin)) {
                return cb(null, true);
            }

            console.warn(`[CORS] Origem bloqueada: ${origin}`);

            return cb(
                new Error('Origem não permitida por CORS')
            );
        },
        credentials: true
    })
);

app.use(
    express.static(
        path.join(__dirname, 'public')
    )
);

/* =========================================================
   MYSQL
========================================================= */

const dbConfig = {
    host: process.env.DB_HOST || '',

    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,

    user: process.env.DB_USER || '',

    password: process.env.DB_PASS || '',

    database: process.env.DB_NAME || '',

    ssl: process.env.DB_SSL === 'true'
        ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
        : undefined
};

if (!dbConfig.host || !dbConfig.user || !dbConfig.database) {
    console.error('❌ DB_HOST, DB_USER e DB_NAME são obrigatórios.');
    process.exit(1);
}

const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10
});

(async () => {
    try {
        const conn = await pool.getConnection();

        console.log(
            `✅ MySQL conectado: ${
                process.env.DB_NAME ||
                dbConfig.database
            }`
        );

        conn.release();
    } catch (e) {
        console.error(
            '❌ MySQL erro:',
            e.message
        );
    }
})();

/* =========================================================
   SESSION STORE
========================================================= */

const MySQLStore = MySQLStoreFactory(session);

const sessionStore = new MySQLStore(
    dbConfig
);

sessionStore
    .onReady()
    .then(() => {
        console.log(
            '✅ Session store (MySQL) pronto'
        );
    })
    .catch((e) => {
        console.error(
            '❌ Session store erro:',
            e.message
        );
    });

const sessionMiddleware = session({
    secret:
        process.env.SESSION_SECRET,

    store: sessionStore,

    resave: false,

    saveUninitialized: false,

    rolling: true,

    name: 'iana.sid',

    cookie: {
        secure:
            process.env.NODE_ENV ===
            'production',

        httpOnly: true,

        sameSite: process.env.COOKIE_SAMESITE || (process.env.NODE_ENV === 'production' ? 'none' : 'lax'),

        maxAge:
            7 *
            24 *
            60 *
            60 *
            1000
    }
});

app.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());

/* =========================================================
   SOCKET.IO
========================================================= */

const server =
    http.createServer(app);

const io =
    new SocketIOServer(server, {
        cors: {
            origin:
                origensPermitidas,
            credentials: true
        }
    });

io.engine.use(
    (req, res, next) => {
        sessionMiddleware(
            req,
            res,
            next
        );
    }
);

io.use(
    (socket, next) => {
        passport.initialize()(
            socket.request,
            {},
            () => {
                passport.session()(
                    socket.request,
                    {},
                    () => {
                        if (
                            socket.request
                                .isAuthenticated?.()
                        ) {
                            return next();
                        }

                        next(
                            new Error(
                                'não autenticado'
                            )
                        );
                    }
                );
            }
        );
    }
);

/* =========================================================
   VOZ EM TEMPO REAL: GEMINI LIVE + ELEVENLABS
========================================================= */
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const elevenlabsPronto = Boolean(ELEVEN_API_KEY && ELEVEN_VOICE_ID);
const liveAI = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const sessoesVoz = new Map();
const SYSTEM_PROMPT_VOZ = process.env.SYSTEM_PROMPT_VOZ || 'Você é a Iana, assistente gamer, em uma chamada de voz em tempo real. Responda sempre em português do Brasil. Seja natural, curta e conversacional.';

function sintetizarVozIana(texto, onChunk, onDone, onError) {
    const controller = new AbortController();
    (async () => {
        try {
            const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE_ID)}/stream?output_format=pcm_24000`, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'xi-api-key': ELEVEN_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: texto, model_id: process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5', voice_settings: { stability: 0.5, similarity_boost: 0.8 } })
            });
            if (!response.ok || !response.body) throw new Error(`ElevenLabs respondeu ${response.status}`);
            const reader = response.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                onChunk(Buffer.from(value).toString('base64'));
            }
            onDone();
        } catch (e) {
            if (e.name !== 'AbortError') onError(e);
        }
    })();
    return controller;
}

io.on('connection', (socket) => {
    const idUser = socket.request.user?.id;
    if (idUser) socket.join(`user_${idUser}`);
    let textoAcumulado = '';
    let sinteseEmAndamento = null;

    socket.on('voz:iniciar', async () => {
        if (!liveAI) return socket.emit('voz:erro', { mensagem: 'GEMINI_API_KEY não configurada.' });
        if (!elevenlabsPronto) return socket.emit('voz:erro', { mensagem: 'ELEVENLABS_API_KEY/ELEVENLABS_VOICE_ID ausentes.' });
        if (sessoesVoz.has(socket.id)) return;
        try {
            const liveSession = await liveAI.live.connect({
                model: LIVE_MODEL,
                config: { responseModalities: [Modality.AUDIO], systemInstruction: { parts: [{ text: SYSTEM_PROMPT_VOZ }] }, inputAudioTranscription: {}, outputAudioTranscription: {} },
                callbacks: {
                    onopen: () => socket.emit('voz:pronto'),
                    onmessage: (message) => {
                        const sc = message.serverContent;
                        if (!sc) return;
                        if (sc.inputTranscription?.text) socket.emit('voz:transcricao-usuario', { texto: sc.inputTranscription.text, final: false });
                        if (sc.outputTranscription?.text) { textoAcumulado += sc.outputTranscription.text; socket.emit('voz:transcricao-iana', { texto: textoAcumulado, final: false }); }
                        if (sc.interrupted) {
                            sinteseEmAndamento?.abort();
                            sinteseEmAndamento = null;
                            textoAcumulado = '';
                            socket.emit('voz:interrompido');
                        }
                        if (sc.turnComplete) {
                            const textoParaFalar = textoAcumulado.trim();
                            socket.emit('voz:transcricao-iana', { texto: textoParaFalar, final: true });
                            textoAcumulado = '';
                            if (textoParaFalar) {
                                sinteseEmAndamento = sintetizarVozIana(textoParaFalar,
                                    (audio) => socket.emit('voz:audio-resposta', { audio }),
                                    () => { sinteseEmAndamento = null; },
                                    (e) => { sinteseEmAndamento = null; console.error('[VOZ] ElevenLabs:', e.message); socket.emit('voz:erro', { mensagem: 'Falha ao gerar a voz.' }); }
                                );
                            }
                        }
                    },
                    onerror: (e) => { console.error('[VOZ LIVE]', e.message); socket.emit('voz:erro', { mensagem: 'Erro na conexão de voz.' }); },
                    onclose: () => sessoesVoz.delete(socket.id)
                }
            });
            sessoesVoz.set(socket.id, liveSession);
        } catch (e) {
            console.error('[VOZ LIVE] falha:', e.message);
            socket.emit('voz:erro', { mensagem: 'Não consegui conectar com a Iana agora.' });
        }
    });

    socket.on('voz:audio', (base64Audio) => {
        const liveSession = sessoesVoz.get(socket.id);
        if (!liveSession || typeof base64Audio !== 'string' || base64Audio.length > 1_000_000) return;
        try { liveSession.sendRealtimeInput({ audio: { data: base64Audio, mimeType: 'audio/pcm;rate=16000' } }); }
        catch (e) { console.error('[VOZ LIVE] envio:', e.message); }
    });

    const encerrarVoz = () => {
        sinteseEmAndamento?.abort();
        sinteseEmAndamento = null;
        const liveSession = sessoesVoz.get(socket.id);
        if (liveSession) { try { liveSession.close(); } catch {} sessoesVoz.delete(socket.id); }
    };
    socket.on('voz:encerrar', encerrarVoz);
    socket.on('disconnect', encerrarVoz);
});

/* =========================================================
   GEMINI
========================================================= */

let genAI = null;

try {
    if (process.env.GEMINI_API_KEY) {
        genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        console.log('✅ Gemini inicializado');
    } else {
        console.warn('⚠️ GEMINI_API_KEY ausente — usando fallback');
    }
} catch (e) {
    console.error('❌ Gemini erro:', e.message);
}

/* =========================================================
   SENDGRID
========================================================= */

let sendgridPronto = false;

if (
    process.env.SENDGRID_API_KEY
) {
    sgMail.setApiKey(
        process.env
            .SENDGRID_API_KEY
    );

    sendgridPronto = true;

    console.log(
        '✅ SendGrid inicializado'
    );
} else {
    console.warn(
        '⚠️ SENDGRID_API_KEY ausente — envio de e-mail desativado'
    );
}

/* =========================================================
   CONFIGURAÇÃO IA
========================================================= */

const LOCAL_ONLY =
    process.env.IANA_LOCAL_ONLY ===
    'true';

const PYTHON_CORE_PATH = path.join(__dirname, 'core', 'iana.py');
const PYTHON_AVAILABLE = existsSync(PYTHON_CORE_PATH);
if (process.env.ENABLE_PYTHON !== 'false' && !PYTHON_AVAILABLE) {
    console.warn('⚠️ Python desativado: core/iana.py não foi encontrado. O Gemini Node será usado como fallback.');
}

if (LOCAL_ONLY) {
    console.log(
        '⚠️ IANA_LOCAL_ONLY ativado — respostas sem Gemini / Google / ChatGPT'
    );
}

/* =========================================================
   DETECÇÃO DE HUMOR
========================================================= */

function detectarHumor(
    texto
) {
    if (!texto) {
        return 'normal';
    }

    const letras =
        (
            texto.match(
                /[A-Za-z]/g
            ) || []
        ).length;

    const caps =
        (
            texto.match(
                /[A-Z]/g
            ) || []
        ).length;

    const pct =
        letras > 0
            ? (caps / letras) * 100
            : 0;

    if (
        pct > 70 ||
        /\*{4,}/.test(texto)
    ) {
        return 'raiva';
    }

    if (
        /[!?][!?]/.test(texto) &&
        !/!{2,}|\?{2,}/.test(texto)
    ) {
        return 'frustrado';
    }

    if (
        /!{2,}|\?{2,}/.test(texto)
    ) {
        return 'estressado';
    }

    return 'normal';
}

function instrucaoHumor(
    humor
) {
    return (
        {
            raiva:
                'O usuário está irritado. Responda com empatia, calma, sem ser seco.',

            estressado:
                'O usuário está estressado. Responda com leveza e tranquilidade.',

            frustrado:
                'O usuário parece frustrado. Seja objetivo, acolhedor e ajude a destravar o problema.',

            normal: ''
        }[humor] || ''
    );
}

/* =========================================================
   MODELOS GEMINI
========================================================= */

const MODELOS = [
    process.env.GEMINI_MODEL ||
        'gemini-2.5-flash-lite',

    'gemini-2.5-flash-lite',

    'gemini-3.1-flash-lite'
];

/* =========================================================
   CHAMAR GEMINI
========================================================= */

async function chamarGemini(modelo, mensagem, historico, systemPrompt, anexo = null) {
    if (!genAI) throw new Error('Gemini não inicializado');

    const contents = historico.map((h) => ({
        role: h.remetente === 'iana' ? 'model' : 'user',
        parts: [{ text: String(h.mensagem || '') }]
    }));

    const parts = [{ text: mensagem }];
    if (anexo?.tipo === 'imagem' || anexo?.tipo === 'audio') {
        parts.push({ inlineData: { mimeType: anexo.mimeType, data: anexo.data } });
    }
    contents.push({ role: 'user', parts });

    const result = await genAI.models.generateContent({
        model: modelo,
        contents,
        config: { systemInstruction: systemPrompt, maxOutputTokens: 2048 }
    });

    const txt = result?.text;
    if (!txt?.trim()) throw new Error('Resposta vazia');
    return txt.trim();
}

/* =========================================================
   ASK GEMINI
========================================================= */

async function askGemini(
    mensagem,
    historico = [],
    instrucaoEmocional = '',
    configPrompt = '',
    anexo = null
) {
    if (LOCAL_ONLY) {
        return null;
    }

    if (!genAI) {
        return null;
    }

    const system =
        (
            process.env.SYSTEM_PROMPT ||
            'Você é a Iana, uma assistente gamer animada, criativa, humanizada e solidária. ' +
            'Tem personalidade forte, fala naturalmente com gírias e emojis quando cabe. ' +
            'É especialista em platinas, troféus, conquistas, builds, itens, localização de objetos, ' +
            'rotas, estratégias e chefões. Também adora falar sobre filmes, séries, cultura nerd e games. ' +
            'REGRA DE CONVERSA: Em cumprimentos, perguntas sobre como você está ou reflexões normais, ' +
            'seja breve e natural. Quando o usuário tiver uma dúvida de jogo e você tiver informações no contexto, ' +
            'crie uma resposta completa, detalhada e útil.'
        ) +
        (
            instrucaoEmocional
                ? `\n\n[TOM]: ${instrucaoEmocional}`
                : ''
        ) +
        (
            configPrompt
                ? `\n\n[PERSONALIZAÇÃO]:\n${configPrompt}`
                : ''
        );

    for (
        const modelo of [
            ...new Set(MODELOS)
        ]
    ) {
        for (
            let tentativa = 0;
            tentativa < 2;
            tentativa++
        ) {
            try {
                return await chamarGemini(
                    modelo,
                    mensagem,
                    historico,
                    system,
                    anexo
                );
            } catch (err) {
                const status =
                    err?.status || '';

                console.error(
                    `[GEMINI] modelo=${modelo} tentativa=${
                        tentativa + 1
                    }:`,
                    err.message
                );

                if (
                    [429, 503].includes(
                        status
                    ) ||
                    /overloaded|unavailable/i.test(
                        err.message
                    )
                ) {
                    await new Promise(
                        (resolve) =>
                            setTimeout(
                                resolve,
                                800
                            )
                    );

                    continue;
                }

                break;
            }
        }
    }

    return null;
}

/* =========================================================
   RESPOSTA SISTEMA
========================================================= */

function respostaSistema(
    mensagem
) {
    const msg =
        mensagem.toLowerCase();

    if (
        /oi|olá|ola|hey|bom dia|boa tarde|boa noite/.test(
            msg
        )
    ) {
        return 'Opa, e aí! 👋 Tudo tranquilo por aí?';
    }

    if (
        /como.*vai|tudo bem|tudo bom/.test(
            msg
        )
    ) {
        return 'Tudo 100% por aqui! E com você, jogando algo legal hoje?';
    }

    return 'Opa, deu uma piscada rápida na minha conexão aqui. Me manda de novo rapidinho?';
}

/* =========================================================
   PYTHON
========================================================= */

async function askPython(
    nome,
    conversa,
    mensagem,
    historico = [],
    idUser = null
) {
    return new Promise(
        (resolve, reject) => {
            const py =
                process.env
                    .IANA_PYTHON_PATH ||
                (
                    process.platform ===
                    'win32'
                        ? 'python'
                        : 'python3'
                );

            const historicoJSON =
                JSON.stringify(
                    historico
                );

            /*
             * O cérebro real da Iana fica em:
             *
             * core/iana.py
             *
             * O server apenas executa esse arquivo.
             */
            const coreScript = path.join(__dirname, 'core', 'iana.py');
            const rootScript = path.join(__dirname, 'iana.py');
            const scriptPath = existsSync(coreScript) ? coreScript : rootScript;

            const args = [
                scriptPath,
                nome,
                conversa,
                mensagem,
                historicoJSON,
                idUser
                    ? String(idUser)
                    : ''
            ];

            const proc =
                spawn(
                    py,
                    args,
                    {
                        env: {
                            ...process.env,
                            PYTHONPATH:
                                __dirname
                        }
                    }
                );

            let out = '';
            let err = '';
            let finalizado = false;

            const timeout =
                setTimeout(
                    () => {
                        if (
                            finalizado
                        ) {
                            return;
                        }

                        finalizado =
                            true;

                        proc.kill();

                        reject(
                            new Error(
                                'Timeout: processo Python demorou mais de 25s'
                            )
                        );
                    },
                    25000
                );

            proc.stdout.on(
                'data',
                (data) => {
                    out +=
                        data.toString();
                }
            );

            proc.stderr.on(
                'data',
                (data) => {
                    err +=
                        data.toString();
                }
            );

            proc.on(
                'close',
                (code) => {
                    if (
                        finalizado
                    ) {
                        return;
                    }

                    finalizado =
                        true;

                    clearTimeout(
                        timeout
                    );

                    if (
                        code !== 0
                    ) {
                        return reject(
                            new Error(
                                `Python falhou com código ${code}: ${
                                    err || 'sem detalhes'
                                }`
                            )
                        );
                    }

                    if (
                        !out.trim()
                    ) {
                        return reject(
                            new Error(
                                `Python retornou vazio: ${
                                    err || 'sem detalhes'
                                }`
                            )
                        );
                    }

                    resolve(
                        out.trim()
                    );
                }
            );

            proc.on(
                'error',
                (error) => {
                    if (
                        finalizado
                    ) {
                        return;
                    }

                    finalizado =
                        true;

                    clearTimeout(
                        timeout
                    );

                    reject(error);
                }
            );
        }
    );
}

/* =========================================================
   GERAR RESPOSTA IA
========================================================= */

async function gerarRespostaIA({
    nome,
    idConv,
    msg,
    historico,
    humor,
    config,
    anexo = null
}) {
    let resposta = null;
    let origem = null;

    if (
        !anexo &&
        PYTHON_AVAILABLE &&
        process.env.ENABLE_PYTHON !==
        'false'
    ) {
        try {
            resposta =
                await askPython(
                    nome,
                    idConv ||
                        'geral',
                    msg,
                    historico
                );

            origem = 'python';
        } catch (e) {
            console.error(
                '[Python] falhou, caindo pro Gemini via Node:',
                e.message
            );
        }
    }

    if (!resposta) {
        resposta =
            await askGemini(
                msg,
                historico,
                instrucaoHumor(
                    humor
                ),
                config,
                anexo
            );

        origem =
            resposta
                ? 'gemini-node'
                : origem;
    }

    if (!resposta) {
        resposta =
            respostaSistema(msg);

        origem =
            'sistema-fixo';

        console.warn(
            '[AVISO] Python e Gemini falharam. Usando resposta do sistema.'
        );
    }

    console.log(
        `[CHAT] origem=${origem}`
    );

    return resposta;
}

/* =========================================================
   LINKS
========================================================= */

function extrairLinks(
    texto
) {
    const regex =
        /https?:\/\/[^\s<>"']+/gi;

    const found =
        texto.match(regex) || [];

    return [
        ...new Set(
            found.map((url) =>
                url.replace(
                    /[.,;:)}\]]+$/,
                    ''
                )
            )
        )
    ].slice(0, 3);
}

function extrairDataUrl(dataUrl, prefixoMime) {
    if (typeof dataUrl !== 'string') return null;
    const match = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) return null;
    const mimeType = match[1].toLowerCase();
    if (prefixoMime && !mimeType.startsWith(prefixoMime)) return null;
    return { mimeType, data: match[2] };
}

function ipEhPrivado(ip) {
    const v = String(ip || '').toLowerCase();
    if (!v) return true;
    if (v.startsWith('::ffff:')) return ipEhPrivado(v.slice(7));
    if (v === '::1' || v === '::' || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('fc') || v.startsWith('fd')) return true;
    const partes = v.split('.').map(Number);
    if (partes.length !== 4 || partes.some(Number.isNaN)) return true;
    const [a,b] = partes;
    return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
}

async function hostnameEhSeguro(hostname) {
    try {
        const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
        if (!results.length) return false;
        return results.every(({ address }) => !ipEhPrivado(address));
    } catch (e) {
        console.warn(`[LINK] DNS falhou para ${hostname}:`, e.message);
        return false;
    }
}

async function buscarConteudoLink(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;

    // Evita SSRF por host/IP privado e não segue redirects automaticamente.
    if (!(await hostnameEhSeguro(parsed.hostname))) {
        console.warn(`[LINK] Bloqueado (DNS/IP privado): ${url}`);
        return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch(parsed.toString(), {
            signal: controller.signal,
            redirect: 'manual',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IanaBot/1.0)' }
        });

        if ([301,302,303,307,308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location) return null;
            const redirected = new URL(location, parsed);
            if (!['http:', 'https:'].includes(redirected.protocol)) return null;
            if (!(await hostnameEhSeguro(redirected.hostname))) return null;
            return buscarConteudoLink(redirected.toString());
        }

        const tipo = response.headers.get('content-type') || '';
        if (!response.ok || !tipo.toLowerCase().includes('text/html') || !response.body) return null;

        const reader = response.body.getReader();
        let recebido = '';
        let bytes = 0;
        const LIMITE = 1_500_000;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > LIMITE) {
                await reader.cancel().catch(() => {});
                return null;
            }
            recebido += Buffer.from(value).toString('utf-8');
        }

        const $ = cheerio.load(recebido);
        $('script, style, nav, footer, noscript, svg, iframe').remove();
        const titulo = $('title').first().text().trim();
        const texto = $('body').text().replace(/\s+/g, ' ').trim();
        if (!texto) return null;
        return { url: parsed.toString(), titulo: titulo || parsed.hostname, texto: texto.slice(0, 4000) };
    } catch (e) {
        console.warn(`[LINK] Falha ao ler ${url}:`, e.message);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function montarContextoLinks(
    mensagem
) {
    const links =
        extrairLinks(
            mensagem
        );

    if (!links.length) {
        return '';
    }

    const resultados =
        await Promise.all(
            links.map(
                buscarConteudoLink
            )
        );

    const validos =
        resultados.filter(
            Boolean
        );

    if (!validos.length) {
        return '';
    }

    return validos
        .map(
            (resultado) =>
                `[Conteúdo do link ${resultado.url} — "${resultado.titulo}"]:\n${resultado.texto}`
        )
        .join('\n\n');
}

/* =========================================================
   PASSPORT
========================================================= */

passport.use(
    new LocalStrategy(
        {
            usernameField:
                'email',

            passwordField:
                'senha'
        },

        async (
            email,
            senha,
            done
        ) => {
            try {
                const [rows] =
                    await pool.query(
                        'SELECT * FROM usuarios WHERE email=?',
                        [
                            email
                                .trim()
                                .toLowerCase()
                        ]
                    );

                if (
                    !rows.length
                ) {
                    return done(
                        null,
                        false,
                        {
                            message:
                                'Credenciais inválidas.'
                        }
                    );
                }

                const ok =
                    await bcrypt.compare(
                        senha.trim(),
                        rows[0]
                            .senha ||
                            ''
                    );

                if (!ok) {
                    return done(
                        null,
                        false,
                        {
                            message:
                                'Credenciais inválidas.'
                        }
                    );
                }

                return done(
                    null,
                    rows[0]
                );
            } catch (e) {
                return done(e);
            }
        }
    )
);

passport.serializeUser(
    (user, done) =>
        done(
            null,
            user.id
        )
);

passport.deserializeUser(
    async (
        id,
        done
    ) => {
        try {
            const [rows] =
                await pool.query(
                    'SELECT id,nome,email FROM usuarios WHERE id=?',
                    [id]
                );

            done(
                null,
                rows[0] || null
            );
        } catch (e) {
            done(e);
        }
    }
);

const auth = (
    req,
    res,
    next
) => {
    if (
        req.isAuthenticated()
    ) {
        return next();
    }

    return res
        .status(401)
        .json({
            erro:
                'Login necessário.'
        });
};

/* =========================================================
   TOKEN API
========================================================= */

function gerarToken() {
    return crypto
        .randomBytes(32)
        .toString('hex');
}

function hashToken(
    token
) {
    return crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');
}

const authToken =
    async (
        req,
        res,
        next
    ) => {
        const header =
            req.headers
                .authorization ||
            '';

        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

        if (token && (token.length !== 64 || !/^[a-f0-9]+$/i.test(token))) {
            return res.status(401).json({ erro: 'Token inválido.' });
        }

        if (!token) {
            return res
                .status(401)
                .json({
                    erro:
                        'Token ausente.'
                });
        }

        try {
            const [rows] =
                await pool.query(
                    'SELECT id,nome,email FROM usuarios WHERE api_token_hash=?',
                    [
                        hashToken(
                            token
                        )
                    ]
                );

            if (
                !rows.length
            ) {
                return res
                    .status(401)
                    .json({
                        erro:
                            'Token inválido.'
                    });
            }

            req.user =
                rows[0];

            next();
        } catch (e) {
            console.error(
                '[AUTH TOKEN]',
                e.message
            );

            res.status(500)
                .json({
                    erro:
                        'Erro de autenticação.'
                });
        }
    };

/* =========================================================
   RATE LIMIT
========================================================= */

const chatLimiter =
    rateLimit({
        windowMs:
            60 * 1000,

        max: 20,

        standardHeaders:
            true,

        legacyHeaders:
            false,

        message: {
            erro:
                'Muitas mensagens em pouco tempo. Aguarde um instante.'
        }
    });

const loginLimiter =
    rateLimit({
        windowMs:
            15 *
            60 *
            1000,

        max: 10,

        standardHeaders:
            true,

        legacyHeaders:
            false,

        message: {
            erro:
                'Muitas tentativas de login. Tente novamente mais tarde.'
        }
    });

const visionLimiter =
    rateLimit({
        windowMs:
            60 * 1000,

        max: 30,

        standardHeaders:
            true,

        legacyHeaders:
            false,

        message: {
            erro:
                'Muitas análises de tela em pouco tempo.'
        }
    });

/* =========================================================
   PÁGINAS
========================================================= */

app.get(
    '/health',
    (req, res) => {
        res.json({
            status: 'ok'
        });
    }
);

app.get(
    '/',
    (req, res) => {
        res.sendFile(
            path.join(
                __dirname,
                'public',
                'index.html'
            )
        );
    }
);

app.get(
    '/configuracoes',
    (req, res) => {
        res.sendFile(
            path.join(
                __dirname,
                'public',
                'configuracoes.html'
            )
        );
    }
);

/* =========================================================
   REGISTRO
========================================================= */

function loginComSessaoNova(req, usuario, callback) {
    req.session.regenerate((sessionError) => {
        if (sessionError) return callback(sessionError);
        req.login(usuario, callback);
    });
}

app.post(
    '/auth/registro',
    loginLimiter,
    async (
        req,
        res
    ) => {
        const {
            nome,
            email,
            senha
        } = req.body;

        if (
            !nome ||
            !email ||
            !senha
        ) {
            return res
                .status(400)
                .json({
                    erro:
                        'Preencha todos os campos.'
                });
        }

        if (
            senha.length < 8
        ) {
            return res
                .status(400)
                .json({
                    erro:
                        'Senha mínima: 8 caracteres.'
                });
        }

        const emailT =
            email
                .trim()
                .toLowerCase();

        try {
            const [existing] =
                await pool.query(
                    'SELECT id FROM usuarios WHERE email=?',
                    [emailT]
                );

            if (
                existing.length
            ) {
                return res
                    .status(409)
                    .json({
                        erro:
                            'E-mail já cadastrado.'
                    });
            }

            const hash =
                await bcrypt.hash(
                    senha.trim(),
                    12
                );

            const [result] =
                await pool.query(
                    'INSERT INTO usuarios (nome,email,senha) VALUES (?,?,?)',
                    [
                        nome.trim(),
                        emailT,
                        hash
                    ]
                );

            const [users] =
                await pool.query(
                    'SELECT id,nome,email FROM usuarios WHERE id=?',
                    [
                        result.insertId
                    ]
                );

            loginComSessaoNova(
                req,
                users[0],
                (err) => {
                    if (err) {
                        return res
                            .status(500)
                            .json({
                                erro:
                                    'Erro de sessão.'
                            });
                    }

                    res.status(201)
                        .json({
                            usuario:
                                users[0]
                        });
                }
            );
        } catch (e) {
            console.error(
                '[REGISTRO]',
                e.message
            );

            res.status(500)
                .json({
                    erro:
                        'Erro interno.'
                });
        }
    }
);

/* =========================================================
   LOGIN
========================================================= */

app.post(
    '/auth/login',
    loginLimiter,
    (
        req,
        res,
        next
    ) => {
        passport.authenticate(
            'local',
            (
                err,
                usuario,
                info
            ) => {
                if (err) {
                    return res
                        .status(500)
                        .json({
                            erro:
                                'Erro interno.'
                        });
                }

                if (!usuario) {
                    return res
                        .status(401)
                        .json({
                            erro:
                                info?.message ||
                                'Falha no login.'
                        });
                }

                loginComSessaoNova(
                    req,
                    usuario,
                    (loginErr) => {
                        if (
                            loginErr
                        ) {
                            return res
                                .status(
                                    500
                                )
                                .json({
                                    erro:
                                        'Erro de sessão.'
                                });
                        }

                        res.json({
                            usuario: {
                                id:
                                    usuario.id,

                                nome:
                                    usuario.nome,

                                email:
                                    usuario.email
                            }
                        });
                    }
                );
            }
        )(req, res, next);
    }
);

/* =========================================================
   LOGOUT
========================================================= */

app.post(
    '/auth/logout',
    (
        req,
        res
    ) => {
        req.logout(
            (logoutErr) => {
                if (
                    logoutErr
                ) {
                    return res
                        .status(
                            500
                        )
                        .json({
                            erro:
                                'Erro ao sair.'
                        });
                }

                req.session.destroy(
                    (sessionErr) => {
                        if (
                            sessionErr
                        ) {
                            console.error(
                                '[LOGOUT]',
                                sessionErr.message
                            );

                            return res
                                .status(
                                    500
                                )
                                .json({
                                    erro:
                                        'Erro ao destruir sessão.'
                                });
                        }

                        res.clearCookie(
                            'iana.sid'
                        );

                        res.json({
                            ok: true
                        });
                    }
                );
            }
        );
    }
);

/* =========================================================
   ME
========================================================= */

app.get(
    '/auth/me',
    (
        req,
        res
    ) => {
        if (
            !req.isAuthenticated()
        ) {
            return res.json({
                logado: false
            });
        }

        res.json({
            logado: true,

            usuario: {
                id:
                    req.user.id,

                nome:
                    req.user.nome,

                email:
                    req.user.email
            }
        });
    }
);

/* =========================================================
   GERAR TOKEN
========================================================= */

app.post(
    '/auth/gerar-token',
    auth,
    async (
        req,
        res
    ) => {
        const token =
            gerarToken();

        try {
            await pool.query(
                'UPDATE usuarios SET api_token_hash=? WHERE id=?',
                [
                    hashToken(
                        token
                    ),
                    req.user.id
                ]
            );

            res.json({
                token
            });
        } catch (e) {
            console.error(
                '[GERAR TOKEN]',
                e.message
            );

            res.status(500)
                .json({
                    erro:
                        'Erro interno.'
                });
        }
    }
);

/* =========================================================
   TROCAR SENHA
========================================================= */

app.post(
    '/auth/trocar-senha',
    auth,
    async (
        req,
        res
    ) => {
        const senhaAtual =
            req.body.senhaAtual?.trim();

        const novaSenha =
            req.body.novaSenha?.trim();

        if (
            !senhaAtual ||
            !novaSenha
        ) {
            return res
                .status(400)
                .json({
                    erro:
                        'Preencha senha atual e nova senha.'
                });
        }

        if (
            novaSenha.length < 8
        ) {
            return res
                .status(400)
                .json({
                    erro:
                        'Senha mínima: 8 caracteres.'
                });
        }

        try {
            const [rows] =
                await pool.query(
                    'SELECT senha FROM usuarios WHERE id=?',
                    [req.user.id]
                );

            if (
                !rows.length
            ) {
                return res
                    .status(404)
                    .json({
                        erro:
                            'Usuário não encontrado.'
                    });
            }

            const ok =
                await bcrypt.compare(
                    senhaAtual,
                    rows[0].senha ||
                        ''
                );

            if (!ok) {
                return res
                    .status(400)
                    .json({
                        erro:
                            'Senha atual incorreta.'
                    });
            }

            const hash =
                await bcrypt.hash(
                    novaSenha,
                    12
                );

            await pool.query(
                'UPDATE usuarios SET senha=? WHERE id=?',
                [
                    hash,
                    req.user.id
                ]
            );

            res.json({
                ok: true
            });
        } catch (e) {
            console.error(
                '[TROCAR SENHA]',
                e.message
            );

            res.status(500)
                .json({
                    erro:
                        'Erro interno.'
                });
        }
    }
);

/* =========================================================
   ESQUECI SENHA
========================================================= */

app.post(
    '/auth/esqueci-senha',
    loginLimiter,
    async (
        req,
        res
    ) => {
        const email =
            req.body.email
                ?.trim()
                .toLowerCase();

        if (!email) {
            return res
                .status(400)
                .json({
                    erro:
                        'E-mail obrigatório.'
                });
        }

        try {
            const [rows] =
                await pool.query(
                    'SELECT id FROM usuarios WHERE email=?',
                    [email]
                );

            if (
                rows.length
            ) {
                const codigo = crypto.randomInt(100000, 1000000).toString();

                codigos.set(
                    email,
                    {
                        codigo,
                        exp:
                            Date.now() +
                            15 *
                                60 *
                                1000
                    }
                );

                if (
                    sendgridPronto
                ) {
                    try {
                        await sgMail.send(
                            {
                                from:
                                    process.env
                                        .EMAIL_FROM ||
                                    'iana@example.com',

                                to: email,

                                subject:
                                    'Código de recuperação — Iana',

                                html: `
                                    <div style="font-family:sans-serif;background:#111;color:#fff;padding:30px;border-radius:12px;max-width:400px;margin:auto">
                                        <h2 style="color:#a855f7">🎮 Iana</h2>
                                        <p>Seu código:</p>

                                        <div style="background:#1e1f20;border-radius:8px;padding:20px;text-align:center;margin:20px 0">
                                            <span style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#a855f7">
                                                ${codigo}
                                            </span>
                                        </div>

                                        <p style="color:#aaa;font-size:13px">
                                            Expira em 15 minutos.
                                        </p>
                                    </div>
                                `
                            }
                        );
                    } catch (
                        sgErro
                    ) {
                        const detalhe =
                            sgErro
                                .response
                                ?.body
                                ?.errors
                                ?.map(
                                    (e) =>
                                        e.message
                                )
                                .join(
                                    '; '
                                ) ||
                            sgErro.message;

                        console.error(
                            `[ESQUECI] SendGrid recusou o envio para ${email}:`,
                            detalhe
                        );
                    }
                }
            }

            res.json({
                ok: true,

                msg:
                    'Se o e-mail existir, um código foi enviado.'
            });
        } catch (e) {
            console.error(
                '[ESQUECI]',
                e.message
            );

            res.status(500)
                .json({
                    erro:
                        'Erro ao enviar.'
                });
        }
    }
);

/* =========================================================
   MUDAR SENHA POR CÓDIGO
========================================================= */

app.post(
    '/auth/mudar-senha',
    async (
        req,
        res
    ) => {
        const {
            codigo,
            nova_senha
        } = req.body;

        const email =
            req.body.email
                ?.trim()
                .toLowerCase();

        if (
            !email ||
            !codigo ||
            !nova_senha
        ) {
            return res
                .status(400)
                .json({
                    erro:
                        'Dados incompletos.'
                });
        }

        const token =
            codigos.get(
                email
            );

        if (
            !token ||
            token.codigo !==
                codigo.trim() ||
            Date.now() >
                token.exp
        ) {
            return res
                .status(400)
                .json({
                    erro:
                        'Código inválido ou expirado.'
                });
        }

        if (
            nova_senha.trim()
                .length < 8
        ) {
            return res
                .status(400)
                .json({
                    erro:
                        'Senha mínima: 8 caracteres.'
                });
        }

        try {
            const hash =
                await bcrypt.hash(
                    nova_senha.trim(),
                    12
                );

            await pool.query(
                'UPDATE usuarios SET senha=? WHERE email=?',
                [
                    hash,
                    email
                ]
            );

            codigos.delete(
                email
            );

            res.json({
                ok: true
            });
        } catch (e) {
            console.error(
                '[MUDAR SENHA]',
                e.message
            );

            res.status(500)
                .json({
                    erro:
                        'Erro ao salvar.'
                });
        }
    }
);

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('\"', '&quot;')
        .replaceAll("'", '&#39;');
}

/* =========================================================
   FEEDBACK
========================================================= */

app.post(
    '/feedback',
    chatLimiter,
    async (
        req,
        res
    ) => {
        const assunto =
            req.body.assunto?.trim();

        const texto =
            req.body.texto?.trim();

        const autorizou =
            !!req.body.autorizou;

        if (
            !assunto ||
            !texto
        ) {
            return res
                .status(400)
                .json({
                    erro:
                        'Preencha assunto e mensagem.'
                });
        }

        if (!autorizou) {
            return res
                .status(400)
                .json({
                    erro:
                        'É necessário autorizar o uso do feedback.'
                });
        }

        if (
            !sendgridPronto
        ) {
            return res
                .status(503)
                .json({
                    erro:
                        'Envio de feedback temporariamente indisponível.'
                });
        }

        try {
            const textoHtml =
                texto
                    .replace(
                        /&/g,
                        '&amp;'
                    )
                    .replace(
                        /</g,
                        '&lt;'
                    )
                    .replace(
                        />/g,
                        '&gt;'
                    )
                    .replace(
                        /\n/g,
                        '<br>'
                    );

            const assuntoHtml =
                assunto
                    .replace(
                        /&/g,
                        '&amp;'
                    )
                    .replace(
                        /</g,
                        '&lt;'
                    )
                    .replace(
                        />/g,
                        '&gt;'
                    );

            await sgMail.send({
                from:
                    process.env
                        .EMAIL_FROM ||
                    'iana@example.com',

                to:
                    process.env
                        .FEEDBACK_TO_EMAIL ||
                    process.env
                        .EMAIL_FROM,

                replyTo:
                    req.user?.email ||
                    undefined,

                subject:
                    `[Iana Feedback] ${assunto}`,

                html: `
                    <div style="font-family:sans-serif;padding:20px">
                        <p>
                            <strong>De:</strong>
                            ${req.user?.nome || 'Visitante'}
                            (${req.user?.email || 'sem login'})
                        </p>

                        <p>
                            <strong>Assunto:</strong>
                            ${assuntoHtml}
                        </p>

                        <p>
                            <strong>Mensagem:</strong>
                        </p>

                        <p>
                            ${textoHtml}
                        </p>
                    </div>
                `
            });

            res.json({
                ok: true
            });
        } catch (e) {
            console.error(
                '[FEEDBACK]',
                e.message
            );

            res.status(500)
                .json({
                    erro:
                        'Erro ao enviar feedback.'
                });
        }
    }
);

/* =========================================================
   CONVERSAS
========================================================= */

async function garantirConversa(idUsuario, idConversa, mensagem) {
    if (!idUsuario) return idConversa || null;

    let id = idConversa || `conv_${idUsuario}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const titulo = mensagem.replace(/[.*?]/g, '').trim().slice(0, 40) || 'Nova Conversa';

    try {
        if (idConversa) {
            const [owner] = await pool.query(
                'SELECT id FROM conversas WHERE id=? AND usuario_id=? LIMIT 1',
                [idConversa, idUsuario]
            );
            if (!owner.length) id = `conv_${idUsuario}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        }

        await pool.query(
            `INSERT INTO conversas (id, usuario_id, titulo, atualizado_em)
             VALUES (?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE atualizado_em=NOW()`,
            [id, idUsuario, titulo + (titulo.length >= 40 ? '...' : '')]
        );
    } catch (e) {
        console.error('[DB garantirConversa]', e.message);
        return null;
    }
    return id;
}

app.get(
    '/chat/conversas',
    auth,
    async (
        req,
        res
    ) => {
        try {
            const [rows] =
                await pool.query(
                    `
                        SELECT
                            id,
                            titulo,
                            fixada
                        FROM conversas
                        WHERE usuario_id=?
                        ORDER BY
                            fixada DESC,
                            atualizado_em DESC,
                            id DESC
                    `,
                    [
                        req.user.id
                    ]
                );

            res.json({
                conversas:
                    rows.map(
                        (c) => ({
                            id_conversa:
                                c.id,

                            titulo:
                                c.titulo,

                            fixada:
                                !!c.fixada
                        })
                    )
            });
        } catch (e) {
            console.error(
                '[CONVERSAS]',
                e.message
            );

            res.status(500)
                .json({
                    erro:
                        'Erro interno.'
                });
        }
    }
);

/* =========================================================
   HISTÓRICO
========================================================= */

app.get(
    '/chat/historico/:id',
    auth,
    async (
        req,
        res
    ) => {
        try {
            const [rows] =
                await pool.query(
                    `
                        SELECT
                            mensagem,
                            remetente,
                            criado_em
                        FROM mensagens
                        WHERE
                            conversa_id=?
                            AND usuario_id=?
                        ORDER BY id ASC
                    `,
                    [
                        req.params.id,
                        req.user.id
                    ]
                );

            res.json({
                mensagens:
                    rows.map(
                        (m) => ({
                            conteudo:
                                m.mensagem,

                            tipo_sender:
                                m.remetente ===
                                'user'
                                    ? 'usuario'
                                    : 'iana',

                            criado_em:
                                m.criado_em
                        })
                    )
            });
        } catch (e) {
            console.error(
                '[HISTORICO]',
                e.message
            );

            res.status(500)
                .json({
                    erro:
                        'Erro interno.'
                });
        }
    }
);

/* =========================================================
   CRIAR CONVERSA
========================================================= */

app.post(
    '/chat/conversas',
    auth,
    async (
        req,
        res
    ) => {
        const {
            titulo
        } = req.body;

        const id =
            `conv_${req.user.id}_${Date.now()}`;

        try {
            await pool.query(
                `
                    INSERT INTO conversas
                        (id, usuario_id, titulo, atualizado_em)
                    VALUES
                        (?, ?, ?, NOW())
                `,
                [
                    id,
                    req.user.id,
                    titulo ||
                        'Nova Conversa'
                ]
            );

            res.json({
                id_conversa:
                    id
            });
        } catch (e) {
            console.error(
                '[CRIAR CONVERSA]',
                e.message
            );

            res.status(500)
                .json({
                    erro:
                        'Erro interno.'
                });
        }
    }
);

/* =========================================================
   RENOMEAR
========================================================= */

app.put(
    '/chat/conversas/:id',
    auth,
    async (
        req,
        res
    ) => {
        const {
            novoTitulo
        } = req.body;

        if (
            !novoTitulo?.trim()
        ) {
            return res
                .status(400)
                .json({
                    erro:
                        'Título obrigatório.'
                });
        }

        try {
            await pool.query(
                `
                    UPDATE conversas
                    SET titulo=?,
                        atualizado_em=NOW()
                    WHERE
                        id=?
                        AND usuario_id=?
                `,
                [
                    novoTitulo.trim(),
                    req.params.id,
                    req.user.id
                ]
            );

            res.json({
                ok: true
            });
        } catch (e) {
            console.error(
                '[RENOMEAR CONVERSA]',
                e.message
            );

            res.status(500)
                .json({
                    erro:
                        'Erro interno.'
                });
        }
    }
);

/* =========================================================
   FIXAR
========================================================= */

app.patch(
    '/chat/conversas/:id/fixar',
    auth,
    async (
        req,
        res
    ) => {
        try {
            await pool.query(
                `
                    UPDATE conversas
                    SET fixada=?
                    WHERE
                        id=?
                        AND usuario_id=?
                `,
                [
                    req.body.fixada
                        ? 1
                        : 0,

                    req.params.id,

                    req.user.id
                ]
            );

            res.json({
                ok: true
            });
        } catch (e) {
            console.error(
                '[FIXAR CONVERSA]',
                e.message
            );

            res.status(500)
                .json({
                    erro:
                        'Erro interno.'
                });
        }
    }
);

/* =========================================================
   EXCLUIR
========================================================= */

app.delete(
    '/chat/conversas/:id',
    auth,
    async (
        req,
        res
    ) => {
        try {
            await pool.query(
                `
                    DELETE FROM mensagens
                    WHERE
                        conversa_id=?
                        AND usuario_id=?
                `,
                [
                    req.params.id,
                    req.user.id
                ]
            );

            await pool.query(
                `
                    DELETE FROM conversas
                    WHERE
                        id=?
                        AND usuario_id=?
                `,
                [
                    req.params.id,
                    req.user.id
                ]
            );

            res.json({
                ok: true
            });
        } catch (e) {
            console.error(
                '[EXCLUIR CONVERSA]',
                e.message
            );

            res.status(500)
                .json({
                    erro:
                        'Erro interno.'
                });
        }
    }
);

/* =========================================================
   CHAT
========================================================= */

app.post(
    '/chat/stream',
    chatLimiter,
    async (
        req,
        res
    ) => {
        try {
            const nome =
                req.user?.nome ||
                'Visitante';

            const idUser =
                req.user?.id ||
                null;

            const msg =
                req.body.mensagem
                    ?.trim();

            const config = String(req.body.configPrompt || '').slice(0, 4000);

            if (!msg) {
                return res
                    .status(400)
                    .json({
                        erro:
                            'Mensagem vazia.'
                    });
            }

            if (
                msg.length >
                8000
            ) {
                return res
                    .status(400)
                    .json({
                        erro:
                            'Mensagem muito longa.'
                    });
            }

            let anexo = null;
            if (req.body.imagem) {
                const parsed = extrairDataUrl(req.body.imagem, 'image/');
                if (!parsed) return res.status(400).json({ erro: 'Imagem inválida.' });
                if (Buffer.byteLength(parsed.data, 'base64') > 7 * 1024 * 1024) return res.status(413).json({ erro: 'Imagem muito grande. Limite: 7 MB.' });
                anexo = { tipo: 'imagem', ...parsed };
            } else if (req.body.audio) {
                const parsed = extrairDataUrl(req.body.audio, 'audio/');
                if (!parsed) return res.status(400).json({ erro: 'Áudio inválido.' });
                if (Buffer.byteLength(parsed.data, 'base64') > 10 * 1024 * 1024) return res.status(413).json({ erro: 'Áudio muito grande. Limite: 10 MB.' });
                anexo = { tipo: 'audio', ...parsed };
            }

            const contextoLinks =
                await montarContextoLinks(
                    msg
                );

            const idConv =
                await garantirConversa(
                    idUser,
                    req.body
                        .idConversa,
                    msg
                );

            if (
                idUser &&
                idConv
            ) {
                await pool.query(
                    `
                        INSERT INTO mensagens
                            (conversa_id, usuario_id, remetente, mensagem)
                        VALUES
                            (?, ?, ?, ?)
                    `,
                    [
                        idConv,
                        idUser,
                        'user',
                        msg
                    ]
                );
            }

            let historico =
                [];

            if (
                idUser &&
                idConv
            ) {
                try {
                    const [rows] =
                        await pool.query(
                            `
                                SELECT
                                    mensagem,
                                    remetente
                                FROM mensagens
                                WHERE conversa_id=? AND usuario_id=?
                                ORDER BY id DESC
                                LIMIT 8
                            `,
                            [
                                idConv,
                                idUser
                            ]
                        );

                    historico =
                        rows.reverse();
                } catch (e) {
                    console.error(
                        '[DB historico]',
                        e.message
                    );
                }
            }

            const msgParaIA =
                contextoLinks
                    ? `${msg}\n\n[CONTEXTO — conteúdo extraído do(s) link(s) enviado(s) pelo usuário, use isso pra responder]:\n${contextoLinks}`
                    : msg;

            const humor =
                req.body
                    .estadoEmocional ||
                detectarHumor(
                    msg
                );

            const resposta =
                await gerarRespostaIA(
                    {
                        nome,
                        idConv,
                        msg:
                            msgParaIA,
                        historico,
                        humor,
                        config,
                        anexo
                    }
                );

            if (
                idUser &&
                idConv
            ) {
                await pool.query(
                    `
                        INSERT INTO mensagens
                            (conversa_id, usuario_id, remetente, mensagem)
                        VALUES
                            (?, ?, ?, ?)
                    `,
                    [
                        idConv,
                        idUser,
                        'iana',
                        resposta
                    ]
                );

                await pool.query(
                    `
                        UPDATE conversas
                        SET atualizado_em=NOW()
                        WHERE
                            id=?
                            AND usuario_id=?
                    `,
                    [
                        idConv,
                        idUser
                    ]
                );
            }

            res.json({
                resposta,
                idConversa:
                    idConv
            });
        } catch (e) {
            console.error(
                '[CHAT]',
                e.message
            );

            res.status(500)
                .json({
                    erro:
                        'Erro interno ao processar a mensagem.'
                });
        }
    }
);

/* =========================================================
   VISÃO EM TEMPO REAL
========================================================= */

app.post(
    '/chat/visao',
    visionLimiter,
    authToken,
    async (
        req,
        res
    ) => {
        try {
            const nome =
                req.user.nome;

            const idUser =
                req.user.id;

            const resumo =
                req.body.resumo
                    ?.trim();

            if (!resumo) {
                return res
                    .status(400)
                    .json({
                        erro:
                            'Resumo vazio.'
                    });
            }

            if (
                resumo.length >
                3000
            ) {
                return res
                    .status(400)
                    .json({
                        erro:
                            'Resumo muito longo.'
                    });
            }

            const idConv =
                await garantirConversa(
                    idUser,
                    req.body
                        .idConversa,
                    'Sessão de visão em tempo real'
                );

            let historico =
                [];

            try {
                const [rows] =
                    await pool.query(
                        `
                            SELECT
                                mensagem,
                                remetente
                            FROM mensagens
                            WHERE conversa_id=? AND usuario_id=?
                            ORDER BY id DESC
                            LIMIT 6
                        `,
                        [
                            idConv,
                            idUser
                        ]
                    );

                historico =
                    rows.reverse();
            } catch (e) {
                console.error(
                    '[DB historico visao]',
                    e.message
                );
            }

            const msg =
                `[LEITURA AUTOMÁTICA DE TELA em tempo real — comente de forma breve e útil, como se estivesse acompanhando o jogo ao vivo]:\n${resumo}`;

            const resposta =
                await gerarRespostaIA(
                    {
                        nome,
                        idConv,
                        msg,
                        historico,
                        humor:
                            'normal',
                        config: ''
                    }
                );

            await pool.query(
                `
                    INSERT INTO mensagens
                        (conversa_id, usuario_id, remetente, mensagem)
                    VALUES
                        (?, ?, ?, ?)
                `,
                [
                    idConv,
                    idUser,
                    'iana',
                    resposta
                ]
            );

            io.to(
                `user_${idUser}`
            ).emit(
                'nova_mensagem',
                {
                    idConversa:
                        idConv,
                    resposta
                }
            );

            res.json({
                resposta,
                idConversa:
                    idConv
            });
        } catch (e) {
            console.error(
                '[VISÃO]',
                e.message
            );

            res.status(500)
                .json({
                    erro:
                        'Erro interno ao processar visão.'
                });
        }
    }
);

/* =========================================================
   404
========================================================= */

app.use(
    (
        req,
        res
    ) => {
        res.status(404)
            .json({
                erro:
                    'Rota não encontrada.'
            });
    }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
    (
        err,
        req,
        res,
        next
    ) => {
        console.error(
            '[ERRO NÃO TRATADO]',
            err.message
        );

        if (
            err.message ===
            'Origem não permitida por CORS'
        ) {
            return res
                .status(403)
                .json({
                    erro:
                        'Origem não permitida.'
                });
        }

        res.status(500)
            .json({
                erro:
                    'Erro interno no servidor.'
            });
    }
);

/* =========================================================
   START
========================================================= */

const PORT =
    process.env.PORT ||
    3333;

server.listen(
    PORT,
    '0.0.0.0',
    () => {
        console.log(
            `🚀 Iana rodando na porta ${PORT}`
        );
    }
);