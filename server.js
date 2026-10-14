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

// Fallback em memória caso o MySQL esteja inacessível (evita erros 500)
let mysqlDisponivel = false;
const usuariosMemoria = new Map(); // id -> { id, nome, email, senha }
const conversasMemoria = new Map(); // conversaId -> { id, usuario_id, titulo, fixada, atualizado_em }
const mensagensMemoria = new Map(); // conversaId -> Array<{ id, conversa_id, usuario_id, remetente, mensagem, criado_em }>
let proximoUsuarioId = 1;
let proximoMensagemId = 1;

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

const origensPermitidas = (process.env.ALLOWED_ORIGINS || 'http://localhost:3333,http://localhost:3000,https://iana-ia.onrender.com')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origensPermitidas.includes(origin) || origin.endsWith('.onrender.com')) {
      return callback(null, true);
    }
    console.warn(`[CORS] Origem bloqueada: ${origin}`);
    return callback(new Error('Origem não permitida por CORS'));
  },
  credentials: true
}));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/configuracoes', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configuracoes.html'));
});

/* ================================================================
   3. BANCO DE DADOS MYSQL & SESSÃO COM FALLBACK AUTOMÁTICO
   ================================================================ */
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'iana_db',
  connectTimeout: 5000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
};

const pool = mysql.createPool({
  ...dbConfig,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Evita que erros assíncronos de perda de conexão derrubem o processo Node.js
pool.on?.('error', (err) => {
  mysqlDisponivel = false;
  console.warn(`[MYSQL POOL] Aviso de conexão (${err.code || err.message}). Usando fallback em memória.`);
});

// MemoryStore nativo como fallback imediato e seguro
const memorySessionStore = new session.MemoryStore();
let activeSessionStore = memorySessionStore;

async function configurarBancoESessao() {
  if (!process.env.DB_HOST) {
    console.log('ℹ️ DB_HOST não definido. Operando 100% com Sessão e Dados em Memória/SQLite.');
    mysqlDisponivel = false;
    return;
  }
  try {
    const conn = await pool.getConnection();
    conn.release();
    mysqlDisponivel = true;
    console.log(`✅ MySQL conectado com sucesso: ${dbConfig.database}`);

    const MySQLStore = MySQLStoreFactory(session);
    activeSessionStore = createSessionStore(MySQLStore, pool, (operation, error) => {
      mysqlDisponivel = false;
      console.error(`[SESSÃO MYSQL] Falha na ${operation} (${error.code || error.name || 'erro'}).`);
    });
  } catch (err) {
    mysqlDisponivel = false;
    activeSessionStore = memorySessionStore;
    console.warn(`⚠️ Alerta MySQL: Não foi possível conectar ao banco (${err.code || err.message}). Operando com fallback em memória.`);
  }
}

// Proxy de Store que redireciona para MemoryStore se o MySQL cair
const resilientStore = new session.Store();
['get', 'set', 'destroy', 'touch', 'all', 'length', 'clear'].forEach(method => {
  resilientStore[method] = (...args) => {
    const target = mysqlDisponivel && typeof activeSessionStore?.[method] === 'function'
      ? activeSessionStore
      : memorySessionStore;
    if (typeof target[method] === 'function') {
      return target[method](...args);
    }
    const cb = args[args.length - 1];
    if (typeof cb === 'function') cb(null);
  };
});

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  store: resilientStore,
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
   4. AUTENTICAÇÃO (PASSPORT LOCAL COM FALLBACK EM MEMÓRIA)
   ================================================================ */
passport.use(new LocalStrategy({ usernameField: 'email', passwordField: 'senha' }, async (email, senha, done) => {
  try {
    const emailT = email.trim().toLowerCase();
    if (mysqlDisponivel) {
      const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [emailT]);
      if (!rows.length) return done(null, false, { message: 'E-mail ou senha incorretos.' });
      const usuario = rows[0];
      const senhaValida = await bcrypt.compare(senha.trim(), usuario.senha);
      if (!senhaValida) return done(null, false, { message: 'E-mail ou senha incorretos.' });
      return done(null, { id: usuario.id, nome: usuario.nome, email: usuario.email });
    } else {
      const usuario = Array.from(usuariosMemoria.values()).find(u => u.email === emailT);
      if (!usuario) return done(null, false, { message: 'E-mail ou senha incorretos.' });
      const senhaValida = await bcrypt.compare(senha.trim(), usuario.senha);
      if (!senhaValida) return done(null, false, { message: 'E-mail ou senha incorretos.' });
      return done(null, { id: usuario.id, nome: usuario.nome, email: usuario.email });
    }
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    if (mysqlDisponivel) {
      const [rows] = await pool.query('SELECT id, nome, email FROM usuarios WHERE id = ?', [id]);
      return done(null, rows[0] || null);
    }
    const user = usuariosMemoria.get(Number(id)) || usuariosMemoria.get(String(id)) || null;
    if (!user) return done(null, false);
    return done(null, { id: user.id, nome: user.nome, email: user.email });
  } catch (err) {
    // Em caso de queda abrupta do MySQL, não retorna erro 500 ao deserializar sessão
    mysqlDisponivel = false;
    return done(null, false);
  }
});

const authRequired = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ status: 'erro', mensagem: 'Login necessário para acessar este recurso.' });
};

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { status: 'erro', mensagem: 'Muitas tentativas. Tente novamente em 15 minutos.' }
});

const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 40,
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
app.get('/health', (req, res) => res.json({
  status: 'online',
  servico: 'Iana Node Server',
  mysql: mysqlDisponivel,
  timestamp: Date.now()
}));

app.post('/auth/registro', loginLimiter, async (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ status: 'erro', mensagem: 'Preencha todos os campos.' });
  if (senha.length < 8) return res.status(400).json({ status: 'erro', mensagem: 'A senha deve ter no mínimo 8 caracteres.' });

  const emailT = email.trim().toLowerCase();
  try {
    const hash = await bcrypt.hash(senha.trim(), 12);
    let novoUsuario;

    if (mysqlDisponivel) {
      const [existentes] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [emailT]);
      if (existentes.length) return res.status(409).json({ status: 'erro', mensagem: 'E-mail já cadastrado.' });
      const [resultado] = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES (?, ?, ?)', [nome.trim(), emailT, hash]);
      novoUsuario = { id: resultado.insertId, nome: nome.trim(), email: emailT };
    } else {
      const jaExiste = Array.from(usuariosMemoria.values()).some(u => u.email === emailT);
      if (jaExiste) return res.status(409).json({ status: 'erro', mensagem: 'E-mail já cadastrado.' });
      const id = proximoUsuarioId++;
      usuariosMemoria.set(id, { id, nome: nome.trim(), email: emailT, senha: hash });
      novoUsuario = { id, nome: nome.trim(), email: emailT };
    }

    disconnectVoiceSession(req.sessionID);
    req.login(novoUsuario, (err) => {
      if (err) return res.status(500).json({ status: 'erro', mensagem: 'Erro de sessão.' });
      return res.status(201).json({ status: 'sucesso', usuario: novoUsuario });
    });
  } catch (err) {
    console.error('[AUTH REGISTRO]', err.message);
    return res.status(500).json({ status: 'erro', mensagem: 'Erro interno ao registrar usuário.' });
  }
});

app.post('/auth/login', loginLimiter, (req, res, next) => {
  passport.authenticate('local', (err, usuario, info) => {
    if (err) {
      console.error('[AUTH LOGIN]', err.message);
      return res.status(500).json({ status: 'erro', mensagem: 'Erro interno ao validar credenciais.' });
    }
    if (!usuario) return res.status(401).json({ status: 'erro', mensagem: info?.message || 'E-mail ou senha incorretos.' });

    disconnectVoiceSession(req.sessionID);
    req.login(usuario, (loginErr) => {
      if (loginErr) return res.status(500).json({ status: 'erro', mensagem: 'Erro de sessão.' });
      return res.json({ status: 'sucesso', usuario });
    });
  })(req, res, next);
});

app.post('/auth/logout', (req, res) => {
  const previousSessionId = req.sessionID;
  disconnectVoiceSession(previousSessionId);
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
   6. ROTAS DE GERENCIAMENTO DE CONVERSAS (MYSQL + FALLBACK MEMÓRIA)
   ================================================================ */
async function salvarMensagemHistorico(usuarioId, conversaId, remetente, texto, tituloSugerido = 'Nova conversa') {
  if (!usuarioId || !conversaId || !texto) return;
  if (mysqlDisponivel) {
    try {
      await ensureConversation(pool, usuarioId, conversaId, tituloSugerido);
      await pool.query(
        'INSERT INTO mensagens (conversa_id, usuario_id, remetente, mensagem) VALUES (?, ?, ?, ?)',
        [conversaId, usuarioId, remetente, texto]
      );
      await pool.query('UPDATE conversas SET atualizado_em = NOW() WHERE id = ?', [conversaId]);
      return;
    } catch (err) {
      console.warn('[HISTÓRICO MYSQL] Fallback para memória:', err.message);
    }
  }
  if (!conversasMemoria.has(conversaId)) {
    conversasMemoria.set(conversaId, {
      id: conversaId,
      usuario_id: usuarioId,
      titulo: String(tituloSugerido || 'Nova conversa').slice(0, 80),
      fixada: false,
      atualizado_em: new Date().toISOString()
    });
  } else {
    conversasMemoria.get(conversaId).atualizado_em = new Date().toISOString();
  }
  if (!mensagensMemoria.has(conversaId)) mensagensMemoria.set(conversaId, []);
  mensagensMemoria.get(conversaId).push({
    id: proximoMensagemId++,
    conversa_id: conversaId,
    usuario_id: usuarioId,
    remetente,
    conteudo: texto,
    mensagem: texto,
    criado_em: new Date().toISOString()
  });
}

app.get('/conversas', authRequired, async (req, res) => {
  if (mysqlDisponivel) {
    try {
      const [conversas] = await pool.query(
        'SELECT id, titulo, fixada, atualizado_em FROM conversas WHERE usuario_id = ? ORDER BY fixada DESC, atualizado_em DESC',
        [req.user.id]
      );
      return res.json({ status: 'sucesso', conversas });
    } catch {}
  }
  const lista = Array.from(conversasMemoria.values())
    .filter(c => String(c.usuario_id) === String(req.user.id));
  return res.json({ status: 'sucesso', conversas: lista });
});

app.get('/conversas/:id', authRequired, async (req, res) => {
  if (mysqlDisponivel) {
    try {
      const [mensagens] = await pool.query(
        'SELECT id, mensagem as conteudo, remetente, criado_em FROM mensagens WHERE conversa_id = ? AND usuario_id = ? ORDER BY id ASC',
        [req.params.id, req.user.id]
      );
      return res.json({ status: 'sucesso', id: req.params.id, conversa_id: req.params.id, mensagens });
    } catch {}
  }
  const msgs = (mensagensMemoria.get(req.params.id) || [])
    .filter(m => String(m.usuario_id) === String(req.user.id));
  return res.json({ status: 'sucesso', id: req.params.id, conversa_id: req.params.id, mensagens: msgs });
});

app.post('/conversas/:id/fixar', authRequired, async (req, res) => {
  if (mysqlDisponivel) {
    try {
      const [conversas] = await pool.query(
        'SELECT fixada FROM conversas WHERE id = ? AND usuario_id = ?',
        [req.params.id, req.user.id]
      );
      if (!conversas.length) return res.status(404).json({ status: 'erro', mensagem: 'Conversa não encontrada.' });
      const fixada = conversas[0].fixada ? 0 : 1;
      await pool.query('UPDATE conversas SET fixada = ? WHERE id = ? AND usuario_id = ?', [fixada, req.params.id, req.user.id]);
      return res.json({ status: 'sucesso', fixada: Boolean(fixada) });
    } catch {}
  }
  const conv = conversasMemoria.get(req.params.id);
  if (!conv || String(conv.usuario_id) !== String(req.user.id)) {
    return res.status(404).json({ status: 'erro', mensagem: 'Conversa não encontrada.' });
  }
  conv.fixada = !conv.fixada;
  return res.json({ status: 'sucesso', fixada: conv.fixada });
});

app.patch('/conversas/:id', authRequired, async (req, res) => {
  const titulo = typeof req.body.titulo === 'string' ? req.body.titulo.trim() : '';
  if (!titulo || titulo.length > 80) {
    return res.status(400).json({ status: 'erro', mensagem: 'O título deve ter entre 1 e 80 caracteres.' });
  }
  if (mysqlDisponivel) {
    try {
      await pool.query('UPDATE conversas SET titulo = ? WHERE id = ? AND usuario_id = ?', [titulo, req.params.id, req.user.id]);
      return res.json({ status: 'sucesso', titulo });
    } catch {}
  }
  const conv = conversasMemoria.get(req.params.id);
  if (conv && String(conv.usuario_id) === String(req.user.id)) conv.titulo = titulo;
  return res.json({ status: 'sucesso', titulo });
});

app.delete('/conversas/:id', authRequired, async (req, res) => {
  if (mysqlDisponivel) {
    try {
      await pool.query('DELETE FROM mensagens WHERE conversa_id = ? AND usuario_id = ?', [req.params.id, req.user.id]);
      await pool.query('DELETE FROM conversas WHERE id = ? AND usuario_id = ?', [req.params.id, req.user.id]);
      return res.json({ status: 'sucesso', mensagem: 'Conversa excluída.' });
    } catch {}
  }
  conversasMemoria.delete(req.params.id);
  mensagensMemoria.delete(req.params.id);
  return res.json({ status: 'sucesso', mensagem: 'Conversa excluída.' });
});

app.post('/feedback', chatLimiter, async (req, res) => {
  const feedback = typeof req.body.feedback === 'string' ? req.body.feedback.trim() : '';
  if (!feedback || feedback.length > 4000) {
    return res.status(400).json({ status: 'erro', mensagem: 'O feedback deve ter entre 1 e 4000 caracteres.' });
  }
  if (!SENDGRID_API_KEY || !EMAIL_FROM || !FEEDBACK_TO_EMAIL) {
    return res.json({ status: 'sucesso', mensagem: 'Feedback registrado localmente.' });
  }
  const nome = escapeHTML(req.user?.nome || 'Visitante');
  const email = escapeHTML(req.user?.email || 'sem login');
  try {
    await sgMail.send({
      to: FEEDBACK_TO_EMAIL,
      from: EMAIL_FROM,
      replyTo: req.user?.email || undefined,
      subject: '[Iana] Feedback do usuário',
      html: `<p><strong>De:</strong> ${nome} (${email})</p><p><strong>Feedback:</strong></p><p>${escapeHTML(feedback).replace(/\n/g, '<br>')}</p>`
    });
    return res.json({ status: 'sucesso', mensagem: 'Feedback enviado.' });
  } catch (err) {
    return res.status(503).json({ status: 'erro', mensagem: 'Não foi possível enviar o feedback agora.' });
  }
});

/* ================================================================
   7. ROTAS DE CHAT E STREAMING (SSE — VISITANTES E LOGADOS)
   ================================================================ */
app.post('/chat', chatLimiter, async (req, res) => {
  const nomeUsuario = req.user?.nome || req.body.nome_usuario || 'Jogador';
  const mensagem = (req.body.mensagem || req.body.message || '').trim();
  const conversaId = req.body.conversa_id || req.body.sessao_id || `sessao_${Date.now()}`;
  const identidade = conversationIdentity(req.user, req.session);

  if (!mensagem) {
    return res.status(400).json({ status: 'erro', mensagem: 'O campo mensagem é obrigatório.' });
  }

  const payload = {
    mensagem,
    sessao_id: conversaId,
    nome_usuario: nomeUsuario,
    usuario_id: identidade,
    config_usuario: req.body.config_usuario || req.body.configRaw
  };

  for (const campo of ['imagem', 'audio', 'video', 'arquivo']) {
    if (typeof req.body[campo] === 'string') payload[campo] = req.body[campo];
  }

  try {
    const pythonResp = await fetch(PYTHON_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': IANA_API_KEY
      },
      body: JSON.stringify(payload)
    });

    const data = await pythonResp.json().catch(() => ({}));
    if (!pythonResp.ok) {
      return res.status(pythonResp.status).json({
        status: 'erro',
        mensagem: data.mensagem || `API Python respondeu HTTP ${pythonResp.status}`
      });
    }

    const respostaTexto = data.resposta || 'GG! Recebi sua mensagem!';
    if (req.user?.id) {
      await salvarMensagemHistorico(req.user.id, conversaId, 'user', mensagem, mensagem.slice(0, 60));
      await salvarMensagemHistorico(req.user.id, conversaId, 'iana', respostaTexto);
    }

    return res.json({
      status: 'sucesso',
      conversa_id: conversaId,
      resposta: respostaTexto,
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('[CHAT ERRO]', err.message);
    return res.status(503).json({
      status: 'erro',
      mensagem: 'Não foi possível processar a resposta localmente.'
    });
  }
});

// FIX CRÍTICO: Removido authRequired para permitir que visitantes conversem sem erro 401
app.get('/chat/stream', chatLimiter, async (req, res) => {
  const mensagem = (req.query.mensagem || '').trim();
  const conversaId = (req.query.conversa_id || '').trim() || `sessao_${Date.now()}`;
  const nomeUsuario = req.user?.nome || 'Jogador';
  const identidade = conversationIdentity(req.user, req.session);

  if (!mensagem) {
    return res.status(400).json({ status: 'erro', mensagem: 'Mensagem obrigatória.' });
  }

  let configUsuario = {};
  if (typeof req.query.config === 'string' && req.query.config.trim()) {
    try { configUsuario = JSON.parse(req.query.config); } catch {}
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let clienteDesconectou = false;
  req.on('close', () => { clienteDesconectou = true; });

  try {
    const pythonResp = await fetch(PYTHON_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': IANA_API_KEY
      },
      body: JSON.stringify({
        mensagem,
        sessao_id: conversaId,
        nome_usuario: nomeUsuario,
        usuario_id: identidade,
        config_usuario: configUsuario
      })
    });

    const data = await pythonResp.json().catch(() => ({}));
    if (!pythonResp.ok) {
      res.write(`data: ${JSON.stringify({ erro: data.mensagem || 'Erro ao gerar resposta na IA.' })}\n\n`);
      res.end();
      return;
    }

    const textoCompleto = String(data.resposta || 'GG! Estou pronta!');

    if (req.user?.id) {
      await salvarMensagemHistorico(req.user.id, conversaId, 'user', mensagem, mensagem.slice(0, 60));
      await salvarMensagemHistorico(req.user.id, conversaId, 'iana', textoCompleto);
    }

    // Divide preservando palavras e quebras de linha para streaming suave
    const pedacos = textoCompleto.match(/.{1,14}|[\s\S]/g) || [textoCompleto];

    for (const pedaco of pedacos) {
      if (clienteDesconectou) break;
      res.write(`data: ${JSON.stringify({ chunk: pedaco, conversa_id: conversaId })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    if (!clienteDesconectou) {
      res.write(`data: ${JSON.stringify({ done: true, conversa_id: conversaId })}\n\n`);
    }
    res.end();
  } catch (err) {
    console.error('[CHAT STREAM ERRO]', err.message);
    if (!clienteDesconectou) {
      res.write(`data: ${JSON.stringify({ erro: 'Falha na conexão com o cérebro da Iana.' })}\n\n`);
      res.end();
    }
  }
});

/* ================================================================
   8. SOCKET.IO (COMUNICAÇÃO EM TEMPO REAL E VOZ COMPLETA)
   ================================================================ */
const io = new SocketIOServer(server, {
  cors: { origin: origensPermitidas, credentials: true }
});

io.engine.use((req, res, next) => sessionMiddleware(req, res, next));

const voiceStates = new Map();
const voiceTtsSockets = new Map();
const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY_SECRET || process.env.ELEVENLABS_API_KEY || '').trim();
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '42swcOVaxVM4TNSGUmkc';
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
const HAS_VALID_ELEVENLABS_KEY = ELEVENLABS_API_KEY.startsWith('sk_') || /^[a-f0-9]{32}$/i.test(ELEVENLABS_API_KEY);

function disconnectVoiceSession(sessionId) {
  if (sessionId) io.in(voiceSessionRoom(sessionId)).disconnectSockets(true);
}

async function validarSessaoVoz(socket, expected = socket.data.voiceSession) {
  try {
    if (await socket.data.voiceSessionReady && await socketSessionCurrent(socket, expected)) return true;
  } catch {}
  clearVoiceState(socket.id, voiceStates, voiceTtsSockets);
  socket.disconnect(true);
  return false;
}

function limparTextoFalado(texto) {
  return String(texto || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#*_>`~-]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function pedirRespostaVoz(estado, mensagem, contextoVisual = '', signal, persistirMensagem = true) {
  const response = await fetch(PYTHON_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': IANA_API_KEY
    },
    body: JSON.stringify(voiceRequestPayload(estado, mensagem, contextoVisual, persistirMensagem)),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.resposta !== 'string' || !data.resposta.trim()) {
    throw new Error(data.mensagem || `API Python respondeu HTTP ${response.status}.`);
  }
  return data.resposta.trim();
}

function identificarJogoNaFala(mensagem, jogoAtual = '') {
  const patterns = [
    /(?:estou|tô|to)\s+jogando\s+([^,.!?]{2,80})/i,
    /(?:o jogo é|o jogo e|jogo chamado)\s+([^,.!?]{2,80})/i
  ];
  for (const pattern of patterns) {
    const match = mensagem.match(pattern);
    if (match?.[1]) return match[1].trim().replace(/\s+$/, '').slice(0, 80);
  }
  return jogoAtual;
}

function falarRespostaVoz(socket, estado, texto, turno) {
  const turnoAtivo = () => voiceTurnActive(socket, estado, turno, voiceStates);
  if (!turnoAtivo()) return;
  const textoFalado = limparTextoFalado(texto);
  socket.emit('voz:transcricao-iana', {
    texto: textoFalado,
    conversa_id: estado.conversaId,
    ttsNativo: !HAS_VALID_ELEVENLABS_KEY
  });

  if (!HAS_VALID_ELEVENLABS_KEY) {
    socket.emit('voz:usar-tts-local', { texto: textoFalado });
    return;
  }

  const url = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input`
    + `?model_id=${encodeURIComponent(ELEVENLABS_MODEL_ID)}&output_format=pcm_24000`;
  const tts = new WebSocket(url, { headers: { 'xi-api-key': ELEVENLABS_API_KEY } });
  let terminou = false;
  let enviouAudio = false;
  const timeout = setTimeout(() => {
    if (terminou) return;
    terminou = true;
    tts.close();
    if (voiceTtsSockets.get(socket.id) === tts) voiceTtsSockets.delete(socket.id);
    if (turnoAtivo()) {
      estado.ocupado = false;
      if (!enviouAudio) socket.emit('voz:usar-tts-local', { texto: textoFalado });
      else socket.emit('voz:erro', { mensagem: 'A geração de áudio da Iana excedeu o tempo limite.' });
    }
  }, 20_000);
  voiceTtsSockets.set(socket.id, tts);

  tts.on('open', () => {
    if (!turnoAtivo()) { tts.close(); return; }
    tts.send(JSON.stringify({
      text: ' ',
      voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
      generation_config: { chunk_length_schedule: [50, 80, 120, 160] }
    }));
    tts.send(JSON.stringify({ text: `${textoFalado} `, flush: true }));
    tts.send(JSON.stringify({ text: '' }));
  });

  tts.on('message', raw => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data.audio && turnoAtivo()) {
      enviouAudio = true;
      socket.emit('voz:audio-resposta', { audio: data.audio });
    }
    if (data.isFinal && !terminou) {
      terminou = true;
      clearTimeout(timeout);
      if (voiceTtsSockets.get(socket.id) === tts) voiceTtsSockets.delete(socket.id);
      if (turnoAtivo()) {
        estado.ocupado = false;
        socket.emit('voz:fala-finalizada');
      }
      tts.close();
    }
    if (data.error && !terminou) {
      terminou = true;
      clearTimeout(timeout);
      if (voiceTtsSockets.get(socket.id) === tts) voiceTtsSockets.delete(socket.id);
      if (turnoAtivo()) {
        estado.ocupado = false;
        if (!enviouAudio) socket.emit('voz:usar-tts-local', { texto: textoFalado });
        else socket.emit('voz:erro', { mensagem: 'Não foi possível concluir o áudio da Iana.' });
      }
      tts.close();
    }
  });

  tts.on('error', () => {
    if (terminou) return;
    terminou = true;
    clearTimeout(timeout);
    if (voiceTtsSockets.get(socket.id) === tts) voiceTtsSockets.delete(socket.id);
    if (turnoAtivo()) {
      estado.ocupado = false;
      if (!enviouAudio) socket.emit('voz:usar-tts-local', { texto: textoFalado });
    }
  });

  tts.on('close', () => {
    terminou = true;
    clearTimeout(timeout);
    if (voiceTtsSockets.get(socket.id) === tts) voiceTtsSockets.delete(socket.id);
    if (turnoAtivo()) estado.ocupado = false;
  });
}

async function responderNaChamada(socket, estado, mensagem, contextoVisual = '', persistirMensagem = true) {
  if (estado.ocupado || !voiceTurnActive(socket, estado, estado.turno, voiceStates)) return;
  if (!await validarSessaoVoz(socket)) return;
  const agora = Date.now();
  if (agora - estado.inicioJanela >= 60_000) {
    estado.inicioJanela = agora;
    estado.chamadasNaJanela = 0;
  }
  if (estado.chamadasNaJanela >= 20) {
    socket.emit('voz:erro', { mensagem: 'A chamada atingiu o limite temporário de análises. Aguarde um minuto.' });
    return;
  }
  estado.chamadasNaJanela += 1;
  estado.ocupado = true;
  const turno = ++estado.turno;
  const controller = new AbortController();
  estado.requestController = controller;
  const turnoAtivo = () => voiceTurnActive(socket, estado, turno, voiceStates);
  try {
    const resposta = await pedirRespostaVoz(estado, mensagem, contextoVisual, controller.signal, persistirMensagem);
    if (!turnoAtivo() || !await validarSessaoVoz(socket)) return;
    if (estado.userId) {
      if (persistirMensagem) await salvarMensagemHistorico(estado.userId, estado.conversaId, 'user', mensagem, 'Chamada de voz');
      await salvarMensagemHistorico(estado.userId, estado.conversaId, 'iana', resposta, 'Chamada de voz');
    }
    if (!turnoAtivo() || !await validarSessaoVoz(socket)) return;
    falarRespostaVoz(socket, estado, resposta, turno);
  } catch (error) {
    if (!turnoAtivo() || controller.signal.aborted) return;
    console.error('[VOZ IANA]', error.message);
    socket.emit('voz:erro', { mensagem: 'Não consegui conectar ao cérebro da Iana.' });
    estado.ocupado = false;
  } finally {
    if (estado.requestController === controller) estado.requestController = null;
  }
}

io.on('connection', (socket) => {
  const sessionState = socket.request?.session;
  if (!sessionState || !socket.request?.sessionID) { socket.disconnect(true); return; }
  const connectionUserId = sessionState?.passport?.user || null;
  const hadGuestIdentity = Boolean(sessionState?.knowledgeGuestId);
  socket.data.voiceSession = {
    sessionId: socket.request?.sessionID,
    identity: conversationIdentity(connectionUserId ? { id: connectionUserId } : null, sessionState),
  };
  socket.join(voiceSessionRoom(socket.data.voiceSession.sessionId));
  socket.data.voiceSessionReady = !connectionUserId && !hadGuestIdentity
    ? new Promise(resolve => sessionState.save(() => resolve(true)))
    : Promise.resolve(true);

  socket.on('voz:iniciar', async (dados = {}) => {
    if (socket.data.voiceStarting) return;
    socket.data.voiceStarting = true;
    try {
      if (!await validarSessaoVoz(socket)) return;
      if (voiceStates.has(socket.id)) { socket.emit('voz:pronto'); return; }
      const userId = socket.request.session?.passport?.user || null;
      let nome = typeof dados.nomeUsuario === 'string' ? dados.nomeUsuario.trim().slice(0, 80) : 'Jogador';
      let conversaId = typeof dados.idConversa === 'string' ? dados.idConversa.trim().slice(0, 128) : '';
      if (!conversaId) conversaId = `voice_${socket.id}`;

      voiceStates.set(socket.id, {
        userId,
        identidadeAprendizado: socket.data.voiceSession.identity,
        nome: nome || 'Jogador',
        conversaId,
        jogoAtual: typeof dados.jogoAtual === 'string' ? dados.jogoAtual.trim().slice(0, 80) : '',
        configUsuario: dados.configUsuario && typeof dados.configUsuario === 'object' && !Array.isArray(dados.configUsuario)
          ? dados.configUsuario
          : {},
        contextoVisual: '',
        visualAssinatura: '',
        ultimaFalaVisual: 0,
        turno: 0,
        ocupado: false,
        inicioJanela: Date.now(),
        chamadasNaJanela: 0
      });
      socket.emit('voz:pronto');
    } catch (error) {
      if (socket.connected) socket.emit('voz:erro', { mensagem: 'Não foi possível iniciar a chamada da Iana.' });
    } finally {
      socket.data.voiceStarting = false;
    }
  });

  socket.on('voz:texto', async textoRecebido => {
    if (!await validarSessaoVoz(socket)) return;
    const estado = voiceStates.get(socket.id);
    const mensagem = typeof textoRecebido === 'string' ? textoRecebido.trim() : '';
    if (!estado || !mensagem) return;
    if (mensagem.length > 2000) {
      socket.emit('voz:erro', { mensagem: 'Fala muito longa.' });
      return;
    }
    estado.jogoAtual = identificarJogoNaFala(mensagem, estado.jogoAtual);
    const contextoVisual = Date.now() - estado.ultimaFalaVisual < 20_000 ? estado.contextoVisual : '';
    await responderNaChamada(socket, estado, mensagem, contextoVisual);
  });

  socket.on('voz:interromper', async () => {
    if (!await validarSessaoVoz(socket)) return;
    const estado = voiceStates.get(socket.id);
    cancelVoiceTurn(estado);
    const tts = voiceTtsSockets.get(socket.id);
    if (tts) {
      tts.close();
      voiceTtsSockets.delete(socket.id);
    }
    socket.emit('voz:interrompido');
  });

  socket.on('voz:tts-local-finalizado', async () => {
    if (!await validarSessaoVoz(socket)) return;
    const estado = voiceStates.get(socket.id);
    if (estado) estado.ocupado = false;
    socket.emit('voz:fala-finalizada');
  });

  socket.on('voz:encerrar', () => clearVoiceState(socket.id, voiceStates, voiceTtsSockets));
  socket.on('disconnect', () => clearVoiceState(socket.id, voiceStates, voiceTtsSockets));
});

/* ================================================================
   9. HANDLER GLOBAL DE ERROS E INICIALIZAÇÃO
   ================================================================ */
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

let pythonApiError = null;
pythonApi?.on('error', error => {
  pythonApiError = error;
  console.error('[PYTHON API] Não foi possível iniciar o processo:', error);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    pythonApi?.kill();
    server.close(() => process.exit(0));
  });
}

app.use((req, res) => res.status(404).json({ status: 'erro', mensagem: 'Rota não encontrada.' }));

app.use((err, req, res, next) => {
  console.error('[ERRO NÃO TRATADO]', err.message);
  return res.status(500).json({ status: 'erro', mensagem: 'Erro interno no servidor Node.js.' });
});

async function waitForPythonApi() {
  const urlHealth = new URL('/health', PYTHON_API_URL);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (pythonApiError) throw pythonApiError;
    try {
      const response = await fetch(urlHealth, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  console.warn('[PYTHON API] Aviso: API Python demorou a responder no healthcheck, iniciando servidor mesmo assim.');
}

async function iniciarServidor() {
  await configurarBancoESessao();
  if (pythonApi) await waitForPythonApi();
  server.listen(PORT, () => {
    console.log(`🚀 Servidor Node.js (server.js) rodando na porta ${PORT}`);
    console.log(`🔗 Conectado à API Python da Iana em: ${PYTHON_API_URL}`);
  });
}

iniciarServidor();