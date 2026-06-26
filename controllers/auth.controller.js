// controllers/auth.controller.js
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Pool MySQL
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'iana_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Email transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

const codigosRecuperacao = new Map();

export const register = async (req, res) => {
    const { nome, email, senha } = req.body;

    if (!nome || !email || !senha) {
        return res.status(400).json({ erro: 'Preencha todos os campos.' });
    }

    const emailTratado = email.trim().toLowerCase();
    const nomeTratado = nome.trim();
    const senhaTratada = senha.trim();

    try {
        const [existe] = await pool.query(
            'SELECT id FROM usuarios WHERE email = ?',
            [emailTratado]
        );

        if (existe.length) {
            return res.status(409).json({ erro: 'Email já cadastrado.' });
        }

        const hash = await bcrypt.hash(senhaTratada, 12);

        const [result] = await pool.query(
            'INSERT INTO usuarios (nome, email, senha) VALUES (?, ?, ?)',
            [nomeTratado, emailTratado, hash]
        );

        const [usuario] = await pool.query(
            'SELECT id, nome, email FROM usuarios WHERE id = ?',
            [result.insertId]
        );

        req.login(usuario[0], (err) => {
            if (err) {
                return res.status(500).json({ erro: 'Erro ao criar sessão.' });
            }

            res.status(201).json({ usuario: usuario[0] });
        });

    } catch (err) {
        console.error('💥 Registro:', err);
        res.status(500).json({ erro: 'Erro interno ao registrar.' });
    }
};

export const login = (req, res) => {
    res.json({
        message: 'Login realizado com sucesso',
        usuario: req.user
    });
};

export const logout = (req, res) => {
    req.logout((err) => {
        if (err) {
            return res.status(500).json({ erro: 'Erro ao fazer logout.' });
        }
        res.json({ message: 'Logout realizado com sucesso.' });
    });
};

export const forgotPassword = async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ erro: 'Email é obrigatório.' });
    }

    const emailTratado = email.trim().toLowerCase();

    try {
        const [usuario] = await pool.query(
            'SELECT id, email, nome FROM usuarios WHERE email = ?',
            [emailTratado]
        );

        if (!usuario.length) {
            return res.status(404).json({ erro: 'Email não encontrado.' });
        }

        const codigo = Math.random().toString(36).substr(2, 6).toUpperCase();
        codigosRecuperacao.set(emailTratado, { codigo, timestamp: Date.now() });

        // Limpar código após 15 minutos
        setTimeout(() => codigosRecuperacao.delete(emailTratado), 15 * 60 * 1000);

        await transporter.sendMail({
            from: `"Iana Games 🎮" <${process.env.EMAIL_USER}>`,
            to: emailTratado,
            subject: 'Seu código de recuperação — Iana',
            html: `
                <div style="font-family:sans-serif;background:#111;color:white;padding:30px;border-radius:12px;max-width:400px;margin:auto;">
                    <h2 style="color:#a855f7;">🎮 Iana Games</h2>
                    <p>Você solicitou a recuperação de senha. Use o código abaixo:</p>
                    <div style="background:#1e1f20;border:1px solid #333;border-radius:8px;padding:20px;text-align:center;margin:20px 0;">
                        <span style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#a855f7;">${codigo}</span>
                    </div>
                    <p style="color:#aaa;font-size:13px;">Este código expira em <strong style="color:white;">15 minutos</strong>.</p>
                </div>
            `
        });

        res.json({ message: 'Código enviado para o email.' });

    } catch (err) {
        console.error('💥 Forgot Password:', err);
        res.status(500).json({ erro: 'Erro ao enviar código.' });
    }
};

export const resetPassword = async (req, res) => {
    const { email, codigo, novaSenha } = req.body;

    if (!email || !codigo || !novaSenha) {
        return res.status(400).json({ erro: 'Preencha todos os campos.' });
    }

    const emailTratado = email.trim().toLowerCase();

    try {
        const recuperacao = codigosRecuperacao.get(emailTratado);

        if (!recuperacao || recuperacao.codigo !== codigo) {
            return res.status(400).json({ erro: 'Código inválido ou expirado.' });
        }

        const hash = await bcrypt.hash(novaSenha.trim(), 12);

        await pool.query(
            'UPDATE usuarios SET senha = ? WHERE email = ?',
            [hash, emailTratado]
        );

        codigosRecuperacao.delete(emailTratado);

        res.json({ message: 'Senha alterada com sucesso.' });

    } catch (err) {
        console.error('💥 Reset Password:', err);
        res.status(500).json({ erro: 'Erro ao resetar senha.' });
    }
};

export const getUser = async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ erro: 'Não autenticado.' });
    }

    res.json({ usuario: req.user });
};
