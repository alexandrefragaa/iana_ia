import express from 'express';
import cors from 'cors';
import pool from './db.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors({ origin: 'http://localhost:3333', credentials: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 dias
}));

app.use(passport.initialize());
app.use(passport.session());

// ── GEMINI ──────────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const systemInstruction = `Você é a Iana, uma assistente animada, divertida, conversacional e solidária.
Sempre eficaz, entrega o que pedem da melhor forma.
Usa emojis para deixar a conversa mais leve e interativa.
Nunca expõe dados sensíveis.

REGRA PRINCIPAL — ADAPTAÇÃO DE TOM:
Antes de responder, analise silenciosamente o estilo e o estado emocional do usuário com base nas mensagens dele:

- CAPS LOCK ou muitas exclamações → está animado ou estressado. Combine energia ou acalme com cuidado.
- Mensagens curtas e secas → está ocupado ou impaciente. Seja direto, sem enrolação.
- Linguagem informal, gírias, abreviações → seja descontraída e informal também.
- Erros de digitação frequentes → está digitando rápido ou ansioso. Seja ágil e tranquilizadora.
- Mensagens longas e detalhadas → quer atenção e cuidado. Responda com profundidade.
- Palavras de tristeza, cansaço, frustração → seja acolhedora, gentil, sem forçar animação.
- Tom agressivo ou grosseiro → mantenha calma, não rebata, desvie com leveza.
- Tom ansioso ou urgente → priorize clareza e segurança na resposta.

Nunca mencione que está analisando o tom. Apenas adapte naturalmente.`;

const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL,
    systemInstruction
});

// ── PASSPORT ─────────────────────────────────────────────────────────────────
passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, senha, done) => {
    try {
        const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email]);
        if (!rows.length) return done(null, false, { message: 'Email não encontrado.' });

        const usuario = rows[0];
        const senhaCorreta = await bcrypt.compare(senha, usuario.senha);
        if (!senhaCorreta) return done(null, false, { message: 'Senha incorreta.' });

        return done(null, usuario);
    } catch (err) {
        return done(err);
    }
}));

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: 'http://localhost:3333/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
    try {
        const email = profile.emails[0].value;
        const nome  = profile.displayName;

        const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email]);
        if (rows.length) return done(null, rows[0]);

        const [result] = await pool.query(
            'INSERT INTO usuarios (nome, email, senha) VALUES (?, ?, ?)',
            [nome, email, '']
        );

        const [novoUser] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [result.insertId]);
        return done(null, novoUser[0]);
    } catch (err) {
        return done(err);
    }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        const [rows] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [id]);
        done(null, rows[0]);
    } catch (err) {
        done(err);
    }
});

// ── MIDDLEWARE AUTH ───────────────────────────────────────────────────────────
function autenticado(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.status(401).json({ erro: 'Não autorizado.' });
}

// ── ROTAS PÚBLICAS ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// Registro email/senha
app.post('/auth/registro', async (req, res) => {
    const { nome, email, senha } = req.body;

    if (!nome || !email || !senha)
        return res.status(400).json({ erro: 'Preencha todos os campos.' });

    try {
        const [existe] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [email]);
        if (existe.length) return res.status(409).json({ erro: 'Email já cadastrado.' });

        const hash = await bcrypt.hash(senha, 12);
        const [result] = await pool.query(
            'INSERT INTO usuarios (nome, email, senha) VALUES (?, ?, ?)',
            [nome, email, hash]
        );

        const [usuario] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [result.insertId]);

        req.login(usuario[0], (err) => {
            if (err) return res.status(500).json({ erro: 'Erro ao criar sessão.' });
            res.status(201).json({ usuario: { id: usuario[0].id, nome: usuario[0].nome } });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao registrar.' });
    }
});

// Login email/senha
app.post('/auth/login', (req, res, next) => {
    passport.authenticate('local', (err, usuario, info) => {
        if (err) return res.status(500).json({ erro: 'Erro interno.' });
        if (!usuario) return res.status(401).json({ erro: info.message });

        req.login(usuario, (err) => {
            if (err) return res.status(500).json({ erro: 'Erro ao criar sessão.' });
            res.json({ usuario: { id: usuario.id, nome: usuario.nome } });
        });
    })(req, res, next);
});

// Logout
app.post('/auth/logout', (req, res) => {
    req.logout(() => res.json({ ok: true }));
});

// Retorna usuário logado
app.get('/auth/me', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ logado: false });
    res.json({ logado: true, usuario: { id: req.user.id, nome: req.user.nome } });
});

// Google OAuth
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/?erro=google' }),
    (req, res) => res.redirect('/')
);

// ── ROTAS PROTEGIDAS ──────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
    const { mensagem, conversa_id, anonimo } = req.body;

    try {
        // Só salva no banco se estiver logado
        if (!anonimo && req.isAuthenticated()) {
            const usuario_id = req.user.id;

            const [conv] = await pool.query(
                'SELECT id FROM conversas WHERE id = ? AND usuario_id = ?',
                [conversa_id, usuario_id]
            );

            if (!conv.length) {
                await pool.query(
                    'INSERT INTO conversas (id, usuario_id, titulo) VALUES (?, ?, ?)',
                    [conversa_id, usuario_id, mensagem.slice(0, 40)]
                );
            }

            await pool.query(
                "INSERT INTO mensagens (conversa_id, remetente, texto) VALUES (?, 'user', ?)",
                [conversa_id, mensagem]
            );
        }

        // Monta histórico — se logado puxa do banco, se anônimo manda só a mensagem atual
        let chatContext = `Usuário: ${mensagem}`;
        let mensagensUsuario = [mensagem];

        if (!anonimo && req.isAuthenticated()) {
            const [historico] = await pool.query(
                'SELECT remetente, texto FROM mensagens WHERE conversa_id = ? ORDER BY id ASC LIMIT 20',
                [conversa_id]
            );

            chatContext = historico.map(m =>
                `${m.remetente === 'user' ? 'Usuário' : 'Iana'}: ${m.texto}`
            ).join('\n');

            mensagensUsuario = historico
                .filter(m => m.remetente === 'user')
                .slice(-5)
                .map(m => m.texto);
        }

        const prompt = `
Histórico da conversa:
${chatContext}

Padrão recente do usuário (últimas mensagens dele):
${mensagensUsuario.join(' | ')}

Com base no padrão acima, adapte seu tom e responda à última mensagem do usuário como Iana.
Iana:`.trim();

        const result = await model.generateContent(prompt);
        const respostaIana = result.response.text();

        // Salva resposta da Iana no banco se logado
        if (!anonimo && req.isAuthenticated()) {
            await pool.query(
                "INSERT INTO mensagens (conversa_id, remetente, texto) VALUES (?, 'iana', ?)",
                [conversa_id, respostaIana]
            );
        }

        res.status(200).json({ resposta: respostaIana });

    } catch (err) {
        console.error('💥 Erro:', err);
        res.status(500).json({ erro: 'Erro ao processar mensagem.' });
    }
});

app.get('/historico', autenticado, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM conversas WHERE usuario_id = ? ORDER BY id DESC',
            [req.user.id]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
});

app.get('/mensagens', autenticado, async (req, res) => {
    const { conversa_id } = req.query;
    try {
        const [rows] = await pool.query(
            'SELECT * FROM mensagens WHERE conversa_id = ? ORDER BY id ASC',
            [conversa_id]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
});

app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

app.listen(3333, () => console.log('🚀 Iana rodando em http://localhost:3333'));