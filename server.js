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
    name: 'iana.sid',
    cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 7*24*60*60*1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

/* ── MYSQL ────────────────────────────────────────────────────── */
const pool = mysql.createPool({
    host:     process.env.DB_HOST || 'localhost',
    user:     process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'iana_db',
    waitForConnections: true,
    connectionLimit: 10
});

/* ── GEMINI ───────────────────────────────────────────────────── */
let genAI = null;
try {
    if (process.env.GEMINI_API_KEY) {
        genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    } else {
        console.warn('⚠️ GEMINI_API_KEY ausente no .env — só usará o fallback Python.');
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

async function askGemini(mensagem, historicoConversa = [], instrucaoEmocional = '') {
    if (!genAI) return null;
    try {
        const systemPrompt = (process.env.SYSTEM_PROMPT ||
            'Você é a Iana, uma assistente animada, humanizada, divertida, conversacional, criativa e solidária.')
            + (instrucaoEmocional ? `\n\n[CONTEXTO DE TOM]: ${instrucaoEmocional}` : '');

        const model = genAI.getGenerativeModel({
            model: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
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
        return result.response.text();
    } catch (err) {
        console.error('[GEMINI] Erro:', err.message);
        return null;
    }
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
            if (!email || !senha) return done(null, false, { message: 'Campos obrigatórios.' });
            const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email.trim().toLowerCase()]);
            if (!rows.length) return done(null, false, { message: 'E-mail não cadastrado.' });
            const usuario = rows[0];
            if (!usuario.senha) return done(null, false, { message: 'Senha incorreta.' });
            const ok = await bcrypt.compare(senha.trim(), usuario.senha);
            if (!ok) return done(null, false, { message: 'Senha incorreta.' });
            return done(null, usuario);
        } catch (err) { return done(err); }
    }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        const [rows] = await pool.query('SELECT id,nome,email FROM usuarios WHERE id=?', [id]);
        done(null, rows[0] || null);
    } catch (err) { done(err); }
});

function autenticado(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.status(401).json({ erro: 'Login necessário.' });
}

/* ── ROOT ─────────────────────────────────────────────────────── */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));

/* ── AUTH ─────────────────────────────────────────────────────── */
app.post('/auth/registro', async (req, res) => {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: 'Preencha todos os campos.' });
    const emailT = email.trim().toLowerCase();
    try {
        const [existe] = await pool.query('SELECT id FROM usuarios WHERE email=?', [emailT]);
        if (existe.length) return res.status(409).json({ erro: 'Email já cadastrado.' });
        const hash = await bcrypt.hash(senha.trim(), 12);
        const [result] = await pool.query('INSERT INTO usuarios (nome,email,senha) VALUES (?,?,?)', [nome.trim(), emailT, hash]);
        const [usuario] = await pool.query('SELECT id,nome,email FROM usuarios WHERE id=?', [result.insertId]);
        req.login(usuario[0], err => {
            if (err) return res.status(500).json({ erro: 'Erro ao criar sessão.' });
            res.status(201).json({ usuario: usuario[0] });
        });
    } catch (err) { res.status(500).json({ erro: 'Erro interno.' }); }
});
app.post('/auth/register', (req, res) => app._router.handle(Object.assign(req, { url: '/auth/registro', originalUrl: '/auth/registro' }), res));

app.post('/auth/login', (req, res, next) => {
    passport.authenticate('local', (err, usuario, info) => {
        if (err)      return res.status(500).json({ erro: 'Erro interno.' });
        if (!usuario) return res.status(401).json({ erro: info?.message || 'Falha no login.' });
        req.login(usuario, err => {
            if (err) return res.status(500).json({ erro: 'Erro ao criar sessão.' });
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

app.post('/auth/esqueci-senha', async (req, res) => {
    const email = req.body.email?.trim().toLowerCase();
    if (!email) return res.status(400).json({ erro: 'Email obrigatório.' });
    try {
        const [rows] = await pool.query('SELECT id FROM usuarios WHERE email=?', [email]);
        if (!rows.length) return res.status(404).json({ erro: 'E-mail não encontrado.' });
        const codigo = Math.floor(100000 + Math.random() * 900000).toString();
        codigosRecuperacao.set(email, { codigo, expiracao: Date.now() + 15*60*1000 });
        await enviarEmailCodigo(email, codigo);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ erro: 'Erro ao enviar email.' }); }
});

app.post('/auth/mudar-senha', async (req, res) => {
    const { codigo, nova_senha } = req.body;
    const email = req.body.email?.trim().toLowerCase();
    if (!email || !codigo || !nova_senha) return res.status(400).json({ erro: 'Dados incompletos.' });
    const token = codigosRecuperacao.get(email);
    if (!token || token.codigo !== codigo.trim() || Date.now() > token.expiracao)
        return res.status(400).json({ erro: 'Código inválido ou expirado.' });
    try {
        const hash = await bcrypt.hash(nova_senha.trim(), 12);
        await pool.query('UPDATE usuarios SET senha=? WHERE email=?', [hash, email]);
        codigosRecuperacao.delete(email);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ erro: 'Erro ao salvar nova senha.' }); }
});

/* ── HELPERS DE CONVERSA ──────────────────────────────────────── */
async function garantirConversa(idUsuario, idConversa, mensagem) {
    if (!idUsuario) return idConversa || null;
    const idFinal = idConversa || `conversa_${idUsuario}_${Date.now()}`;
    const limpo   = mensagem.replace(/\[.*?\]/g, '').trim();
    const titulo  = (limpo.slice(0, 40) || 'Nova Conversa') + (limpo.length > 40 ? '...' : '');
    try {
        await pool.query(
            'INSERT INTO conversas (id,usuario_id,titulo) VALUES (?,?,?) ON DUPLICATE KEY UPDATE titulo=titulo',
            [idFinal, idUsuario, titulo]
        );
    } catch (e) { console.error('[DB] garantirConversa:', e.message); }
    return idFinal;
}

/* ── CHAT PRINCIPAL: /chat/stream (Gemini + fallback Python) ───── */
app.post('/chat/stream', async (req, res) => {
    const nomeUsuario = req.user?.nome || 'Visitante';
    const idUsuario   = req.user?.id || null;
    const mensagem    = req.body.mensagem;

    if (!mensagem?.trim()) return res.status(400).json({ error: 'Mensagem não fornecida.' });

    const idConversa = await garantirConversa(idUsuario, req.body.idConversa, mensagem);

    if (idUsuario && idConversa) {
        try {
            await pool.query('INSERT INTO mensagens (conversa_id,remetente,mensagem) VALUES (?,?,?)', [idConversa, 'user', mensagem]);
        } catch (e) { console.error('[DB] salvar user:', e.message); }
    }

    let historicoConversa = [];
    if (idUsuario && idConversa) {
        try {
            const [msgs] = await pool.query(
                'SELECT mensagem, remetente FROM mensagens WHERE conversa_id=? ORDER BY id DESC LIMIT 10',
                [idConversa]
            );
            historicoConversa = msgs.reverse();
        } catch (e) { console.error('[DB] histórico:', e.message); }
    }

    const humor = req.body.estadoEmocional || detectarHumor(mensagem);
    let respostaIana = await askGemini(mensagem, historicoConversa, instrucaoPorHumor(humor));

    if (!respostaIana) {
        console.log('[FALLBACK] Gemini falhou, tentando iana.py...');
        try {
            respostaIana = await askIanaPython(nomeUsuario, idConversa || 'chat_geral', mensagem);
        } catch (e) {
            console.error('[FALLBACK] iana.py também falhou:', e.message);
        }
    }

    if (!respostaIana) {
        respostaIana = 'Estou em atualização nesse assunto agora — em breve devo ter mais informações. Posso te ajudar com outra coisa? 😊';
        console.warn('[AVISO] Gemini e Python falharam. Veja os logs acima.');
    }

    if (idUsuario && idConversa) {
        try {
            await pool.query('INSERT INTO mensagens (conversa_id,remetente,mensagem) VALUES (?,?,?)', [idConversa, 'iana', respostaIana.trim()]);
        } catch (e) { console.error('[DB] salvar resposta:', e.message); }
    }

    res.json({ resposta: respostaIana.trim(), idConversa: idConversa || null });
});

/* ── /chat/conversas — lista (formato que o frontend espera) ───── */
app.get('/chat/conversas', autenticado, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, titulo, fixada FROM conversas WHERE usuario_id=? ORDER BY fixada DESC, id DESC',
            [req.user.id]
        );
        const conversas = rows.map(r => ({ id_conversa: r.id, titulo: r.titulo, fixada: !!r.fixada }));
        res.json({ conversas });
    } catch (err) { res.status(500).json({ erro: err.message }); }
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
    // 🎯 AQUI ESTÁ A CORREÇÃO: Buscando na tabela certa (mensagens_chat) e com a coluna certa (id_conversa)
    const [rows] = await pool.query(
      'SELECT conteudo, tipo_sender, criado_em FROM mensagens_chat WHERE id_conversa=? ORDER BY id ASC',
      [req.params.id]
    );
    
    // Mapeando do jeito que o chat.js espera receber
    const mensagens = rows.map(r => ({
      conteudo: r.conteudo,
      tipo_sender: r.tipo_sender, 
      criado_em: r.criado_em
    }));
    
    res.json({ mensagens });
  } catch (err) {
    res.status(500).json({ erro: err.message });
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
        // 🎯 CORREÇÃO: Tabela mensagens_chat e coluna id_conversa
        await pool.query('DELETE FROM mensagens_chat WHERE id_conversa=?', [req.params.id]);
        
        // Deleta a conversa mãe
        await pool.query('DELETE FROM conversas WHERE id=? AND usuario_id=?', [req.params.id, req.user.id]);
        
        res.json({ message: 'Conversa deletada.' });
    } catch (err) { 
        res.status(500).json({ erro: err.message }); 
    }
});

/* ── ROTAS ANTIGAS — mantidas por compatibilidade ──────────────── */
app.get('/historico', async (req, res) => {
    if (!req.isAuthenticated()) return res.json([]);
    try {
        const [rows] = await pool.query('SELECT * FROM conversas WHERE usuario_id=? ORDER BY fixada DESC, id DESC', [req.user.id]);
        res.json(rows);
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

/* ── 404 ──────────────────────────────────────────────────────── */
app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

app.listen(process.env.PORT || 3333, () => console.log('🚀 Iana: http://localhost:3333'));