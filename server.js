import express from 'express';
import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import sgMail from '@sendgrid/mail';
import dotenv from 'dotenv';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'node:child_process';
import { Server as SocketIOServer } from 'socket.io';
import crypto from 'crypto';
import WebSocket from 'ws';
import { ensureConversation, escapeHTML, pythonExecutable, conversationIdentity } from './core/runtime.js';
import { createKnowledgeRouter } from './core/knowledge-proxy.js';
import { createSessionStore } from './core/session-store.js';
import { voiceSessionRoom, voiceRequestPayload, socketSessionCurrent, voiceTurnActive, cancelVoiceTurn, clearVoiceState } from './core/voice-session.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

/* ================================================================
   1. CONFIGURAÇÃO DE SEGURANÇA E AMBIENTE
   ================================================================ */
const PORT = process.env.PORT || 3333;
const PYTHON_API_PORT = process.env.PYTHON_API_PORT || '5000';
const START_PYTHON_API = process.env.START_PYTHON_API === 'true' ||
  (process.env.START_PYTHON_API !== 'false' && !process.env.PYTHON_API_URL);
const PYTHON_API_URL = START_PYTHON_API
  ? `http://127.0.0.1:${PYTHON_API_PORT}/api/v1/chat`
  : process.env.PYTHON_API_URL || `http://127.0.0.1:${PYTHON_API_PORT}/api/v1/chat`;
const IANA_API_KEY = (process.env.IANA_API_KEY || '').trim();
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SENDGRID_API_KEY = (process.env.SENDGRID_API_KEY || '').trim();
const EMAIL_FROM = (process.env.EMAIL_FROM || process.env.EMAIL_USER || '').trim();
const FEEDBACK_TO_EMAIL = (process.env.FEEDBACK_TO_EMAIL || EMAIL_FROM).trim();
const passwordResetCodes = new Map();

setInterval(() => {
  const agora = Date.now();
  for (const [email, dados] of passwordResetCodes.entries()) {
    if (agora > dados.expiraEm) passwordResetCodes.delete(email);
  }
}, 5 * 60 * 1000).unref();

if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

if (!IANA_API_KEY) throw new Error('IANA_API_KEY precisa estar configurada.');
if (!SESSION_SECRET) throw new Error('SESSION_SECRET precisa estar configurada.');

/* ================================================================
   2. MIDDLEWARES BÁSICOS E CORS
   ================================================================ */
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.set('trust proxy', 1);

const origensPermitidas = (process.env.ALLOWED_ORIGINS || 'http://localhost:3333,http://localhost:3000')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origensPermitidas.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origem não permitida por CORS'));
  },
  credentials: true
}));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/configuracoes', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configuracoes.html'));
});

/* ================================================================
   3. BANCO DE DADOS MYSQL & SESSÃO RESILIENTE (COM FALLBACK)
   ================================================================ */
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'iana_db',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
};

const pool = mysql.createPool({
  ...dbConfig,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

let sessionStore;
try {
  const MySQLStore = MySQLStoreFactory(session);
  sessionStore = createSessionStore(MySQLStore, pool, (operation, error) => {
    console.error(`[SESSÃO MYSQL] Falha na ${operation} (${error.code || error.name || 'erro'}).`);
  });
} catch (err) {
  console.warn('[SESSÃO] Usando armazenamento em memória por falha crítica no MySQL Store.');
  sessionStore = undefined;
}

const sessionMiddleware = session({
  secret: SESSION_SECRET,
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

/* ================================================================
   4. AUTENTICAÇÃO (PASSPORT LOCAL STRATEGY)
   ================================================================ */
passport.use(new LocalStrategy({ usernameField: 'email', passwordField: 'senha' }, async (email, senha, done) => {
  try {
    const emailT = email.trim().toLowerCase();
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [emailT]);
    if (!rows.length) return done(null, false, { message: 'E-mail ou senha incorretos.' });

    const usuario = rows[0];
    const senhaValida = await bcrypt.compare(senha.trim(), usuario.senha);
    if (!senhaValida) return done(null, false, { message: 'E-mail ou senha incorretos.' });

    return done(null, { id: usuario.id, nome: usuario.nome, email: usuario.email });
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const [rows] = await pool.query('SELECT id, nome, email FROM usuarios WHERE id = ?', [id]);
    done(null, rows[0] || null);
  } catch (err) {
    done(err);
  }
});

const authRequired = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ status: 'erro', mensagem: 'Login necessário para acessar este recurso.' });
};

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { status: 'erro', mensagem: 'Muitas tentativas. Tente novamente em 15 minutos.' }
});

const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { status: 'erro', mensagem: 'Limite de mensagens atingido. Aguarde um momento.' }
});

app.use('/api/v1/knowledge', createKnowledgeRouter({
  pythonApiUrl: PYTHON_API_URL,
  apiKey: IANA_API_KEY,
  authRequired,
  createLimiter: rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { status: 'erro', mensagem: 'Aguarde um minuto antes de importar mais fontes.' }
  })
}));

/* ================================================================
   5. ROTAS DE AUTENTICAÇÃO E CONTA
   ================================================================ */
app.get('/health', (req, res) => res.json({ status: 'online', servico: 'Iana Node Server', timestamp: Date.now() }));

app.post('/auth/registro', loginLimiter, async (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ status: 'erro', mensagem: 'Preencha todos os campos.' });
  if (senha.length < 8) return res.status(400).json({ status: 'erro', mensagem: 'A senha deve ter no mínimo 8 caracteres.' });

  const emailT = email.trim().toLowerCase();
  try {
    const [existentes] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [emailT]);
    if (existentes.length) return res.status(409).json({ status: 'erro', mensagem: 'E-mail já cadastrado.' });

    const hash = await bcrypt.hash(senha.trim(), 12);
    const [resultado] = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES (?, ?, ?)', [nome.trim(), emailT, hash]);
    
    const novoUsuario = { id: resultado.insertId, nome: nome.trim(), email: emailT };
    req.login(novoUsuario, (err) => {
      if (err) return res.status(500).json({ status: 'erro', mensagem: 'Erro de sessão.' });
      return res.status(201).json({ status: 'sucesso', usuario: novoUsuario });
    });
  } catch (err) {
    return res.status(500).json({ status: 'erro', mensagem: 'Erro interno ao registrar usuário.' });
  }
});

app.post('/auth/login', loginLimiter, (req, res, next) => {
  passport.authenticate('local', (err, usuario, info) => {
    if (err) return res.status(500).json({ status: 'erro', mensagem: 'Erro interno.' });
    if (!usuario) return res.status(401).json({ status: 'erro', mensagem: info?.message || 'Falha no login.' });

    req.login(usuario, (err) => {
      if (err) return res.status(500).json({ status: 'erro', mensagem: 'Erro de sessão.' });
      return res.json({ status: 'sucesso', usuario });
    });
  })(req, res, next);
});

app.post('/auth/logout', (req, res) => {
  req.logout(err => {
    if (err) return res.status(500).json({ status: 'erro', mensagem: 'Não foi possível encerrar a sessão.' });
    req.session.destroy(() => {
      res.clearCookie('iana.sid');
      return res.json({ status: 'sucesso', mensagem: 'Sessão encerrada.' });
    });
  });
});

app.get('/auth/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ logado: false });
  return res.json({ logado: true, usuario: req.user });
});

/* ================================================================
   6. ROTAS DE CHAT E STREAMING (SSE)
   ================================================================ */
app.post('/chat', chatLimiter, async (req, res) => {
  const nomeUsuario = req.user?.nome || req.body.nome_usuario || 'Jogador';
  const mensagem = (req.body.mensagem || req.body.message || '').trim();
  const conversaId = req.body.conversa_id || req.body.sessao_id || `sessao_${Date.now()}`;

  if (!mensagem) {
    return res.status(400).json({ status: 'erro', mensagem: 'O campo mensagem é obrigatório.' });
  }

  try {
    const pythonResp = await fetch(PYTHON_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': IANA_API_KEY
      },
      body: JSON.stringify({
        mensagem: mensagem,
        sessao_id: conversaId,
        nome_usuario: nomeUsuario,
        config_usuario: req.body.configRaw
      })
    });

    if (!pythonResp.ok) throw new Error(`API Python respondeu HTTP ${pythonResp.status}`);

    const data = await pythonResp.json();
    return res.json({
      status: 'sucesso',
      conversa_id: conversaId,
      resposta: data.resposta || 'GG! Recebi sua mensagem!',
      timestamp: Date.now()
    });
  } catch (err) {
    return res.status(503).json({
      status: 'erro',
      mensagem: 'Não foi possível processar a resposta localmente.'
    });
  }
});

app.get('/chat/stream', authRequired, async (req, res) => {
  const mensagem = (req.query.mensagem || '').trim();
  const conversaId = req.query.conversa_id || `sessao_${Date.now()}`;

  if (!mensagem) {
    return res.status(400).json({ status: 'erro', mensagem: 'Mensagem obrigatória.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');

  try {
    const pythonResp = await fetch(PYTHON_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': IANA_API_KEY
      },
      body: JSON.stringify({
        mensagem: mensagem,
        sessao_id: conversaId,
        nome_usuario: req.user?.nome || 'Jogador',
        usuario_id: req.user?.id || null
      })
    });

    if (!pythonResp.ok) {
      res.write(`data: ${JSON.stringify({ erro: 'Erro ao gerar resposta.' })}\n\n`);
      res.end();
      return;
    }

    const data = await pythonResp.json();
    const textoCompleto = data.resposta || 'GG!';
    const pedacos = textoCompleto.match(/.{1,15}/g) || [textoCompleto];
    
    for (const pedaco of pedacos) {
      res.write(`data: ${JSON.stringify({ chunk: pedaco, conversa_id: conversaId })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ erro: 'Falha na conexão com o cérebro da Iana.' })}\n\n`);
    res.end();
  }
});

/* ================================================================
   7. SOCKET.IO & INICIALIZAÇÃO DOS SERVIÇOS
   ================================================================ */
const io = new SocketIOServer(server, {
  cors: { origin: origensPermitidas, credentials: true }
});

io.engine.use((req, res, next) => sessionMiddleware(req, res, next));

const pythonApi = START_PYTHON_API ? spawn(
  pythonExecutable(__dirname),
  [path.join(__dirname, 'core', 'app.py')],
  {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PYTHON_API_PORT), FLASK_DEBUG: 'false' },
    stdio: 'inherit',
    windowsHide: true
  }
) : null;

app.use((req, res) => res.status(404).json({ status: 'erro', mensagem: 'Rota não encontrada.' }));

server.listen(PORT, () => {
  console.log(`🚀 Servidor Node.js rodando na porta ${PORT}`);
});