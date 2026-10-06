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
import { ensureConversation, escapeHTML, pythonExecutable } from './core/runtime.js';

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
    console.warn(`[CORS] Origem bloqueada: ${origin}`);
    return callback(new Error('Origem não permitida por CORS'));
  },
  credentials: true
}));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/configuracoes', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configuraçoes.html'));
});

/* ================================================================
   3. BANCO DE DADOS MYSQL & SESSÃO PERSISTENTE
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

// Teste inicial de conexão MySQL
(async () => {
  try {
    const conn = await pool.getConnection();
    console.log(`✅ MySQL conectado com sucesso: ${dbConfig.database}`);
    conn.release();
  } catch (err) {
    console.error(`⚠️ Alerta MySQL: Não foi possível conectar ao banco (${err.message}). Operando com fallback.`);
  }
})();

const MySQLStore = MySQLStoreFactory(session);
const sessionStore = new MySQLStore(dbConfig);

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
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 dias
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

// Middleware de verificação de autenticação
const authRequired = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ status: 'erro', mensagem: 'Login necessário para acessar este recurso.' });
};

// Rate Limiters para proteção contra força bruta
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
    console.error('[AUTH REGISTRO]', err);
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
    if (err) {
      console.error('[AUTH LOGOUT]', err.message);
      return res.status(500).json({ status: 'erro', mensagem: 'Não foi possível encerrar a sessão.' });
    }
    req.session.destroy(destroyError => {
      if (destroyError) {
        console.error('[AUTH SESSION DESTROY]', destroyError.message);
        return res.status(500).json({ status: 'erro', mensagem: 'Não foi possível encerrar a sessão.' });
      }
      res.clearCookie('iana.sid');
      return res.json({ status: 'sucesso', mensagem: 'Sessão encerrada.' });
    });
  });
});

app.get('/auth/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ logado: false });
  return res.json({ logado: true, usuario: req.user });
});

app.post('/auth/trocar-senha', authRequired, async (req, res) => {
  const senhaAtual = typeof req.body.senhaAtual === 'string' ? req.body.senhaAtual : '';
  const novaSenha = typeof req.body.novaSenha === 'string' ? req.body.novaSenha : '';
  if (!senhaAtual || !novaSenha) {
    return res.status(400).json({ status: 'erro', mensagem: 'Preencha a senha atual e a nova senha.' });
  }
  if (novaSenha.trim().length < 8) {
    return res.status(400).json({ status: 'erro', mensagem: 'A nova senha precisa ter no mínimo 8 caracteres.' });
  }

  try {
    const [usuarios] = await pool.query('SELECT senha FROM usuarios WHERE id = ?', [req.user.id]);
    if (!usuarios.length) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado.' });
    if (!await bcrypt.compare(senhaAtual, usuarios[0].senha || '')) {
      return res.status(400).json({ status: 'erro', mensagem: 'Senha atual incorreta.' });
    }

    const hash = await bcrypt.hash(novaSenha.trim(), 12);
    await pool.query('UPDATE usuarios SET senha = ? WHERE id = ?', [hash, req.user.id]);
    return res.json({ status: 'sucesso', mensagem: 'Senha alterada com sucesso.' });
  } catch (err) {
    console.error('[AUTH TROCAR SENHA]', err.message);
    return res.status(500).json({ status: 'erro', mensagem: 'Não foi possível alterar a senha.' });
  }
});

app.post('/auth/esqueci-senha', loginLimiter, async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ status: 'erro', mensagem: 'Digite um e-mail válido.' });
  }
  if (!SENDGRID_API_KEY || !EMAIL_FROM) {
    return res.status(503).json({ status: 'erro', mensagem: 'Recuperação por e-mail indisponível: configure o provedor de e-mail.' });
  }

  try {
    const [usuarios] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [email]);
    if (!usuarios.length) {
      return res.json({ status: 'sucesso', mensagem: 'Se o e-mail estiver cadastrado, enviaremos um código de recuperação.' });
    }

    const codigo = String(crypto.randomInt(100000, 1000000));
    await sgMail.send({
      to: email,
      from: EMAIL_FROM,
      subject: 'Código de recuperação da Iana',
      html: `<p>Seu código para redefinir a senha é <strong>${codigo}</strong>.</p><p>Ele expira em 15 minutos.</p>`
    });
    passwordResetCodes.set(email, { codigo, expiraEm: Date.now() + 15 * 60 * 1000, tentativas: 5 });
    return res.json({ status: 'sucesso', mensagem: 'Se o e-mail estiver cadastrado, enviaremos um código de recuperação.' });
  } catch (err) {
    console.error('[AUTH RECUPERAR SENHA]', err.message);
    return res.status(503).json({ status: 'erro', mensagem: 'Não foi possível enviar o código de recuperação. Tente novamente mais tarde.' });
  }
});

app.post('/auth/mudar-senha', loginLimiter, async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const codigo = typeof req.body.codigo === 'string' ? req.body.codigo.trim() : '';
  const novaSenha = typeof req.body.nova_senha === 'string' ? req.body.nova_senha : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(codigo) || !novaSenha) {
    return res.status(400).json({ status: 'erro', mensagem: 'Preencha o e-mail, o código e a nova senha.' });
  }
  if (novaSenha.trim().length < 8) {
    return res.status(400).json({ status: 'erro', mensagem: 'A nova senha precisa ter no mínimo 8 caracteres.' });
  }

  const registro = passwordResetCodes.get(email);
  if (!registro || Date.now() > registro.expiraEm) {
    passwordResetCodes.delete(email);
    return res.status(400).json({ status: 'erro', mensagem: 'Código inválido ou expirado.' });
  }
  if (registro.codigo !== codigo) {
    registro.tentativas -= 1;
    if (registro.tentativas <= 0) passwordResetCodes.delete(email);
    return res.status(400).json({ status: 'erro', mensagem: 'Código inválido ou expirado.' });
  }

  try {
    const hash = await bcrypt.hash(novaSenha.trim(), 12);
    const [resultado] = await pool.query('UPDATE usuarios SET senha = ? WHERE email = ?', [hash, email]);
    if (!resultado.affectedRows) {
      passwordResetCodes.delete(email);
      return res.status(400).json({ status: 'erro', mensagem: 'Código inválido ou expirado.' });
    }
    passwordResetCodes.delete(email);
    return res.json({ status: 'sucesso', mensagem: 'Senha alterada com sucesso.' });
  } catch (err) {
    console.error('[AUTH REDEFINIR SENHA]', err.message);
    return res.status(500).json({ status: 'erro', mensagem: 'Não foi possível alterar a senha.' });
  }
});

/* ================================================================
   6. ROTAS DE GERENCIAMENTO DE CONVERSAS (HISTÓRICO MYSQL)
   ================================================================ */
app.get('/conversas', authRequired, async (req, res) => {
  try {
    const [conversas] = await pool.query(
      'SELECT id, titulo, fixada, atualizado_em FROM conversas WHERE usuario_id = ? ORDER BY fixada DESC, atualizado_em DESC',
      [req.user.id]
    );
    return res.json({ status: 'sucesso', conversas });
  } catch (err) {
    return res.status(500).json({ status: 'erro', mensagem: err.message });
  }
});

app.get('/conversas/:id', authRequired, async (req, res) => {
  try {
    const [mensagens] = await pool.query(
      'SELECT id, mensagem, remetente, criado_em FROM mensagens WHERE conversa_id = ? AND usuario_id = ? ORDER BY id ASC',
      [req.params.id, req.user.id]
    );
    return res.json({ status: 'sucesso', conversa_id: req.params.id, mensagens });
  } catch (err) {
    return res.status(500).json({ status: 'erro', mensagem: err.message });
  }
});

app.post('/conversas/:id/fixar', authRequired, async (req, res) => {
  try {
    const [conversas] = await pool.query(
      'SELECT fixada FROM conversas WHERE id = ? AND usuario_id = ?',
      [req.params.id, req.user.id]
    );
    if (!conversas.length) return res.status(404).json({ status: 'erro', mensagem: 'Conversa não encontrada.' });

    const fixada = conversas[0].fixada ? 0 : 1;
    await pool.query(
      'UPDATE conversas SET fixada = ? WHERE id = ? AND usuario_id = ?',
      [fixada, req.params.id, req.user.id]
    );
    return res.json({ status: 'sucesso', fixada: Boolean(fixada) });
  } catch (err) {
    console.error('[CONVERSA FIXAR]', err.message);
    return res.status(500).json({ status: 'erro', mensagem: 'Não foi possível fixar a conversa.' });
  }
});

app.patch('/conversas/:id', authRequired, async (req, res) => {
  const titulo = typeof req.body.titulo === 'string' ? req.body.titulo.trim() : '';
  if (!titulo || titulo.length > 80) {
    return res.status(400).json({ status: 'erro', mensagem: 'O título deve ter entre 1 e 80 caracteres.' });
  }
  try {
    const [existentes] = await pool.query(
      'SELECT id FROM conversas WHERE id = ? AND usuario_id = ?',
      [req.params.id, req.user.id]
    );
    if (!existentes.length) return res.status(404).json({ status: 'erro', mensagem: 'Conversa não encontrada.' });
    await pool.query(
      'UPDATE conversas SET titulo = ? WHERE id = ? AND usuario_id = ?',
      [titulo, req.params.id, req.user.id]
    );
    return res.json({ status: 'sucesso', titulo });
  } catch (err) {
    console.error('[CONVERSA RENOMEAR]', err.message);
    return res.status(500).json({ status: 'erro', mensagem: 'Não foi possível renomear a conversa.' });
  }
});

app.delete('/conversas/:id', authRequired, async (req, res) => {
  try {
    await pool.query('DELETE FROM mensagens WHERE conversa_id = ? AND usuario_id = ?', [req.params.id, req.user.id]);
    await pool.query('DELETE FROM conversas WHERE id = ? AND usuario_id = ?', [req.params.id, req.user.id]);
    return res.json({ status: 'sucesso', mensagem: 'Conversa excluída.' });
  } catch (err) {
    return res.status(500).json({ status: 'erro', mensagem: err.message });
  }
});

app.post('/feedback', chatLimiter, async (req, res) => {
  const feedback = typeof req.body.feedback === 'string' ? req.body.feedback.trim() : '';
  if (!feedback || feedback.length > 4000) {
    return res.status(400).json({ status: 'erro', mensagem: 'O feedback deve ter entre 1 e 4000 caracteres.' });
  }
  if (!SENDGRID_API_KEY || !EMAIL_FROM || !FEEDBACK_TO_EMAIL) {
    return res.status(503).json({ status: 'erro', mensagem: 'Envio de feedback indisponível: configure o provedor de e-mail.' });
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
    console.error('[FEEDBACK]', err.message);
    return res.status(503).json({ status: 'erro', mensagem: 'Não foi possível enviar o feedback agora.' });
  }
});

/* ================================================================
   7. ROTA PRINCIPAL DE CHAT (INTEGRAÇÃO NODE -> PYTHON FLASK API)
   ================================================================ */
app.post('/chat', chatLimiter, async (req, res) => {
  const nomeUsuario = req.user?.nome || req.body.nome_usuario || 'Jogador';
  const idUsuario = req.user?.id || null;
  const mensagem = (req.body.mensagem || req.body.message || '').trim();
  const conversaId = req.body.conversa_id || req.body.sessao_id || `sessao_${Date.now()}`;

  if (!mensagem) {
    return res.status(400).json({ status: 'erro', mensagem: 'O campo mensagem é obrigatório.' });
  }

  // 1. Salva a mensagem do usuário no MySQL (se autenticado)
  if (idUsuario) {
    try {
      const [existe] = await pool.query('SELECT id FROM conversas WHERE id = ? AND usuario_id = ?', [conversaId, idUsuario]);
      if (!existe.length) {
        const tituloAuto = mensagem.length > 30 ? mensagem.substring(0, 30) + '...' : mensagem;
        await pool.query('INSERT INTO conversas (id, usuario_id, titulo) VALUES (?, ?, ?)', [conversaId, idUsuario, tituloAuto]);
      }
      await pool.query('INSERT INTO mensagens (conversa_id, usuario_id, remetente, mensagem) VALUES (?, ?, ?, ?)', [conversaId, idUsuario, 'user', mensagem]);
    } catch (dbErr) {
      console.warn(`[CHAT DB] Não foi possível registrar mensagem no MySQL: ${dbErr.message}`);
    }
  }

  // 2. Faz a chamada HTTP para o Servidor Python da Iana (app.py na porta 5000)
  let respostaIana = '';
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
        config_usuario: req.body.configRaw,
        estadoEmocional: req.body.estadoEmocional,
        imagem: req.body.imagem,
        audio: req.body.audio,
        video: req.body.video,
        arquivo: req.body.arquivo,
        mimeType: req.body.mimeType
      })
    });

    if (pythonResp.ok) {
      const data = await pythonResp.json();
      respostaIana = data.resposta || data.message || 'GG! Recebi sua mensagem, jogador!';
    } else {
      console.error(`[PYTHON API] Erro HTTP ${pythonResp.status}`);
      const data = await pythonResp.json().catch(() => ({}));
      return res.status(pythonResp.status).json({
        status: 'erro',
        mensagem: data.mensagem || `A API da Iana respondeu HTTP ${pythonResp.status}.`
      });
    }
  } catch (err) {
    console.error(`[PYTHON API CONEXÃO] Falha ao conectar em ${PYTHON_API_URL}:`, err.message);
    return res.status(503).json({
      status: 'erro',
      mensagem: 'Não foi possível conectar ao serviço de IA. Tente novamente em instantes.'
    });
  }

  // 3. Salva a resposta da Iana no MySQL (se autenticado)
  if (idUsuario) {
    try {
      await pool.query('INSERT INTO mensagens (conversa_id, usuario_id, remetente, mensagem) VALUES (?, ?, ?, ?)', [conversaId, idUsuario, 'iana', respostaIana]);
      await pool.query('UPDATE conversas SET atualizado_em = NOW() WHERE id = ?', [conversaId]);
    } catch (dbErr) {
      console.warn(`[CHAT DB] Erro ao salvar resposta da Iana: ${dbErr.message}`);
    }
  }

  // 4. Retorna a resposta JSON para o Frontend
  return res.json({
    status: 'sucesso',
    conversa_id: conversaId,
    resposta: respostaIana,
    timestamp: Date.now()
  });
});

/* ================================================================
   8. SOCKET.IO (COMUNICAÇÃO EM TEMPO REAL E VOZ)
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

function limparTextoFalado(texto) {
  return String(texto || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#*_>`~-]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function pedirRespostaVoz(estado, mensagem, contextoVisual = '') {
  const response = await fetch(PYTHON_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': IANA_API_KEY
    },
    body: JSON.stringify({
      mensagem,
      sessao_id: estado.conversaId,
      nome_usuario: estado.nome,
      config_usuario: estado.configUsuario,
      jogo_atual: estado.jogoAtual,
      contexto_visual: contextoVisual
    }),
    signal: AbortSignal.timeout(35_000)
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
  const textoFalado = limparTextoFalado(texto);
  socket.emit('voz:transcricao-iana', {
    texto: textoFalado,
    conversa_id: estado.conversaId,
    ttsNativo: !ELEVENLABS_API_KEY.startsWith('sk_')
  });

  if (!ELEVENLABS_API_KEY.startsWith('sk_')) {
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
    voiceTtsSockets.delete(socket.id);
    estado.ocupado = false;
    if (estado.turno === turno) {
      if (!enviouAudio) socket.emit('voz:usar-tts-local', { texto: textoFalado });
      else socket.emit('voz:erro', { mensagem: 'A geração de áudio da Iana excedeu o tempo limite.' });
    }
  }, 20_000);
  voiceTtsSockets.set(socket.id, tts);

  tts.on('open', () => {
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
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.audio && estado.turno === turno) {
      enviouAudio = true;
      socket.emit('voz:audio-resposta', { audio: data.audio });
    }
    if (data.isFinal && !terminou) {
      terminou = true;
      clearTimeout(timeout);
      voiceTtsSockets.delete(socket.id);
      estado.ocupado = false;
      if (estado.turno === turno) socket.emit('voz:fala-finalizada');
      tts.close();
    }
    if (data.error && !terminou) {
      terminou = true;
      clearTimeout(timeout);
      voiceTtsSockets.delete(socket.id);
      estado.ocupado = false;
      if (estado.turno === turno) {
        if (!enviouAudio) socket.emit('voz:usar-tts-local', { texto: textoFalado });
        else socket.emit('voz:erro', { mensagem: 'Não foi possível concluir o áudio da Iana.' });
      }
      tts.close();
    }
  });

  tts.on('error', error => {
    if (terminou) return;
    terminou = true;
    clearTimeout(timeout);
    voiceTtsSockets.delete(socket.id);
    estado.ocupado = false;
    console.error('[ELEVENLABS VOZ]', error.message);
    if (estado.turno === turno) {
      if (!enviouAudio) socket.emit('voz:usar-tts-local', { texto: textoFalado });
      else socket.emit('voz:erro', { mensagem: 'Não foi possível concluir o áudio da Iana.' });
    }
  });
}

async function responderNaChamada(socket, estado, mensagem, contextoVisual = '', persistirMensagem = true) {
  if (estado.ocupado) return;
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
  try {
    const resposta = await pedirRespostaVoz(estado, mensagem, contextoVisual);
    if (estado.turno !== turno) return;
    if (estado.userId) {
      try {
        if (persistirMensagem) {
          await pool.query(
            'INSERT INTO mensagens (conversa_id, usuario_id, remetente, mensagem) VALUES (?, ?, ?, ?)',
            [estado.conversaId, estado.userId, 'user', mensagem]
          );
        }
        await pool.query(
          'INSERT INTO mensagens (conversa_id, usuario_id, remetente, mensagem) VALUES (?, ?, ?, ?)',
          [estado.conversaId, estado.userId, 'assistant', resposta]
        );
        await pool.query('UPDATE conversas SET atualizado_em = NOW() WHERE id = ?', [estado.conversaId]);
      } catch (error) {
        console.warn('[VOZ DB] Não foi possível salvar a fala:', error.message);
      }
    }
    if (estado.turno !== turno) return;
    falarRespostaVoz(socket, estado, resposta, turno);
  } catch (error) {
    console.error('[VOZ IANA]', error.message);
    if (estado.turno === turno) socket.emit('voz:erro', { mensagem: 'Não consegui conectar ao cérebro da Iana. Confira os logs do serviço.' });
    estado.ocupado = false;
  }
}

io.on('connection', (socket) => {
  const userId = socket.request?.session?.passport?.user || null;
  const user = userId || 'Visitante';
  console.log(`🔌 Cliente conectado via Socket.IO (ID: ${socket.id}, User: ${user || 'Visitante'})`);

  socket.on('voz:iniciar', async (dados = {}) => {
    if (voiceStates.has(socket.id)) {
      socket.emit('voz:pronto');
      return;
    }
    try {
      let nome = typeof dados.nomeUsuario === 'string' ? dados.nomeUsuario.trim().slice(0, 80) : 'Jogador';
      if (userId) {
        const [rows] = await pool.query('SELECT nome FROM usuarios WHERE id = ?', [userId]);
        if (rows[0]?.nome) nome = rows[0].nome;
      }
      let conversaId = typeof dados.idConversa === 'string' ? dados.idConversa.trim().slice(0, 128) : '';
      if (userId) conversaId = await ensureConversation(pool, userId, conversaId || null, 'Chamada de voz');
      if (!conversaId) conversaId = `voice_${socket.id}`;

      voiceStates.set(socket.id, {
        userId,
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
      console.error('[VOZ INICIAR]', error.message);
      socket.emit('voz:erro', { mensagem: 'Não foi possível iniciar a chamada da Iana.' });
    }
  });

  socket.on('voz:jogo', dados => {
    const estado = voiceStates.get(socket.id);
    const jogoAtual = typeof dados?.jogoAtual === 'string' ? dados.jogoAtual.trim().slice(0, 80) : '';
    if (!estado || !jogoAtual) return;
    estado.jogoAtual = jogoAtual;
    estado.visualAssinatura = '';
    estado.ultimaFalaVisual = 0;
    socket.emit('voz:jogo-confirmado', { jogoAtual });
  });

  socket.on('voz:texto', async textoRecebido => {
    const estado = voiceStates.get(socket.id);
    const mensagem = typeof textoRecebido === 'string' ? textoRecebido.trim() : '';
    if (!estado || !mensagem) return;
    if (mensagem.length > 2000) {
      socket.emit('voz:erro', { mensagem: 'Fala muito longa.' });
      return;
    }
    estado.jogoAtual = identificarJogoNaFala(mensagem, estado.jogoAtual);
    const contextoVisual = Date.now() - estado.ultimaFalaVisual < 20_000 ? estado.contextoVisual : '';
    await responderNaChamada(
      socket,
      estado,
      contextoVisual
        ? `${mensagem}\n\nConsidere também a observação visual recente, sem assumir que os rótulos YOLO identificam corretamente objetos do jogo.`
        : mensagem,
      contextoVisual
    );
  });

  socket.on('voz:visao', async dados => {
    const estado = voiceStates.get(socket.id);
    if (!estado || !dados || typeof dados !== 'object') return;
    const frameWidth = Number.isFinite(dados.width) ? Math.max(1, Math.min(4096, dados.width)) : 1;
    const frameHeight = Number.isFinite(dados.height) ? Math.max(1, Math.min(4096, dados.height)) : 1;
    const detections = Array.isArray(dados.detections)
      ? dados.detections.slice(0, 20).flatMap(item => {
        if (typeof item?.label !== 'string' || !Number.isFinite(item.confidence)) return [];
        const label = item.label.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 40);
        if (!label) return [];
        const coords = Array.isArray(item.xyxy) && item.xyxy.length === 4 && item.xyxy.every(Number.isFinite)
          ? item.xyxy
          : null;
        const confidence = Math.round(Math.max(0, Math.min(1, item.confidence)) * 100);
        if (!coords) return [`${label} (${confidence}%)`];
        const [x1, y1, x2, y2] = coords;
        const centerX = ((x1 + x2) / 2) / frameWidth;
        const centerY = ((y1 + y2) / 2) / frameHeight;
        const horizontal = centerX < 0.34 ? 'esquerda' : centerX > 0.66 ? 'direita' : 'centro';
        const vertical = centerY < 0.34 ? 'superior' : centerY > 0.66 ? 'inferior' : 'meio';
        return [`${label} (${confidence}%, ${vertical}-${horizontal} da tela)`];
      })
      : [];
    const assinatura = [...new Set(detections)].sort().join('|');
    if (!assinatura) return;

    estado.contextoVisual = `Detecções locais YOLO: ${[...new Set(detections)].join(', ')}. As posições se referem apenas ao quadro, não ao mapa do jogo. Os rótulos são genéricos e podem estar incorretos; descreva apenas o que esta evidência permite.`;
    const agora = Date.now();
    if (assinatura === estado.visualAssinatura || estado.ocupado || agora - estado.ultimaFalaVisual < 8000) return;

    estado.visualAssinatura = assinatura;
    estado.ultimaFalaVisual = agora;
    await responderNaChamada(
      socket,
      estado,
      'Comente naturalmente, como numa conversa, se algo visível ajuda o jogador agora. Não fale de YOLO, rótulos, percentuais, coordenadas, chaves, colchetes ou parênteses; não invente elementos, objetivos ou mecânicas do jogo.',
      estado.contextoVisual,
      false
    );
  });

  socket.on('voz:interromper', () => {
    const estado = voiceStates.get(socket.id);
    if (estado) {
      estado.turno += 1;
      estado.ocupado = false;
    }
    const tts = voiceTtsSockets.get(socket.id);
    if (tts) {
      tts.close();
      voiceTtsSockets.delete(socket.id);
    }
    socket.emit('voz:interrompido');
  });

  socket.on('voz:tts-local-finalizado', () => {
    const estado = voiceStates.get(socket.id);
    if (estado) estado.ocupado = false;
    socket.emit('voz:fala-finalizada');
  });

  socket.on('voz:encerrar', () => {
    voiceStates.delete(socket.id);
    const tts = voiceTtsSockets.get(socket.id);
    if (tts) tts.close();
    voiceTtsSockets.delete(socket.id);
  });

  socket.on('disconnect', () => {
    voiceStates.delete(socket.id);
    const tts = voiceTtsSockets.get(socket.id);
    if (tts) tts.close();
    voiceTtsSockets.delete(socket.id);
    console.log(`🔌 Cliente desconectado (ID: ${socket.id})`);
  });
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
pythonApi?.on('exit', (code, signal) => {
  if (code !== 0 && code !== null) console.error(`[PYTHON API] Processo encerrado com código ${code}.`);
  if (signal) console.warn(`[PYTHON API] Processo encerrado pelo sinal ${signal}.`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    pythonApi?.kill();
    server.close(() => process.exit(0));
  });
}

app.use((req, res) => res.status(404).json({ status: 'erro', mensagem: 'Rota não encontrada.' }));

app.use((err, req, res, next) => {
  console.error('[ERRO NÃO TRATADO]', err);
  return res.status(500).json({ status: 'erro', mensagem: 'Erro interno no servidor Node.js.' });
});

async function waitForPythonApi() {
  const urlHealth = new URL('/health', PYTHON_API_URL);
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    if (pythonApiError) throw pythonApiError;
    if (pythonApi && (pythonApi.exitCode !== null || pythonApi.signalCode !== null)) {
      throw new Error('O processo da API Python encerrou antes de ficar pronto.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(urlHealth, { signal: controller.signal });
      if (response.ok) {
        const health = await response.json();
        if (health.status === 'online') return;
      }
    } catch {
      // A API pode ainda estar importando dependências.
    } finally {
      clearTimeout(timeout);
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`A API Python não ficou pronta em tempo hábil: ${urlHealth}`);
}

async function iniciarServidor() {
  if (pythonApi) await waitForPythonApi();
  server.listen(PORT, () => {
    console.log(`🚀 Servidor Node.js (server.js) rodando na porta ${PORT}`);
    console.log(`🔗 Conectado à API Python da Iana em: ${PYTHON_API_URL}`);
  });
}

iniciarServidor().catch(error => {
  console.error('[STARTUP] Falha ao iniciar os serviços:', error.message);
  pythonApi?.kill();
  process.exitCode = 1;
});
