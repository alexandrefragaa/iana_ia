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
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import crypto from 'crypto';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

/* ================================================================
   1. CONFIGURAÇÃO DE SEGURANÇA E AMBIENTE
   ================================================================ */
const PORT = process.env.PORT || 3333;
const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://localhost:5000/api/v1/chat';
const IANA_API_KEY = process.env.IANA_API_KEY || 'iana-v1-secret';
const SESSION_SECRET = process.env.SESSION_SECRET || 'iana-super-secret-key';

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
passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, senha, done) => {
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
  req.logout(() => {
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

app.delete('/conversas/:id', authRequired, async (req, res) => {
  try {
    await pool.query('DELETE FROM mensagens WHERE conversa_id = ? AND usuario_id = ?', [req.params.id, req.user.id]);
    await pool.query('DELETE FROM conversas WHERE id = ? AND usuario_id = ?', [req.params.id, req.user.id]);
    return res.json({ status: 'sucesso', mensagem: 'Conversa excluída.' });
  } catch (err) {
    return res.status(500).json({ status: 'erro', mensagem: err.message });
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
        nome_usuario: nomeUsuario
      })
    });

    if (pythonResp.ok) {
      const data = await pythonResp.json();
      respostaIana = data.resposta || data.message || 'GG! Recebi sua mensagem, jogador!';
    } else {
      console.error(`[PYTHON API] Erro HTTP ${pythonResp.status}`);
      respostaIana = `E aí, ${nomeUsuario}! 🎮 Tive um pequeno lag de conexão com o cérebro principal, mas estou pronta para o próximo round!`;
    }
  } catch (err) {
    console.error(`[PYTHON API CONEXÃO] Falha ao conectar em ${PYTHON_API_URL}:`, err.message);
    respostaIana = `E aí, ${nomeUsuario}! 🎮 Meu servidor de IA está inicializando. Vamos trocar uma ideia sobre o seu jogo favorito enquanto isso!`;
  }

  // 3. Salva a resposta da Iana no MySQL (se autenticado)
  if (idUsuario) {
    try {
      await pool.query('INSERT INTO mensagens (conversa_id, usuario_id, remetente, mensagem) VALUES (?, ?, ?, ?)', [conversaId, idUsuario, 'assistant', respostaIana]);
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

io.on('connection', (socket) => {
  const user = socket.request?.session?.passport?.user;
  console.log(`🔌 Cliente conectado via Socket.IO (ID: ${socket.id}, User: ${user || 'Visitante'})`);

  socket.on('disconnect', () => {
    console.log(`🔌 Cliente desconectado (ID: ${socket.id})`);
  });
});

/* ================================================================
   9. HANDLER GLOBAL DE ERROS E INICIALIZAÇÃO
   ================================================================ */
app.use((req, res) => res.status(404).json({ status: 'erro', mensagem: 'Rota não encontrada.' }));

app.use((err, req, res, next) => {
  console.error('[ERRO NÃO TRATADO]', err);
  return res.status(500).json({ status: 'erro', mensagem: 'Erro interno no servidor Node.js.' });
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor Node.js (server.js) rodando na porta ${PORT}`);
  console.log(`🔗 Conectado à API Python da Iana em: ${PYTHON_API_URL}`);
});
