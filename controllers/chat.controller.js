import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Conexão com o Banco de Dados
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'iana_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Inicialização do Gemini
let genAI = null;
try {
    if (process.env.GEMINI_API_KEY) {
        genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    } else {
        console.warn('⚠️ GEMINI_API_KEY ausente no .env');
    }
} catch (e) {
    console.error('💥 Falha ao inicializar GoogleGenerativeAI:', e.message);
}

function resolvePythonExecutable() {
    if (process.env.IANA_PYTHON_PATH) return process.env.IANA_PYTHON_PATH;
    return process.platform === 'win32' ? 'python' : 'python3';
}

// 🎯 FUNÇÃO: Buscar Histórico (Corrigida!)
export const getHistoricoChat = async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT conteudo, tipo_sender, criado_em FROM mensagens_chat WHERE id_conversa=? ORDER BY id ASC',
            [req.params.id]
        );
        const mensagens = rows.map(r => ({
            conteudo: r.conteudo,
            tipo_sender: r.tipo_sender,
            criado_em: r.criado_em
        }));
        res.json({ mensagens });
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
};

// 🎯 FUNÇÃO: Listar Conversas
export const listarConversas = async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, titulo, fixada FROM conversas WHERE usuario_id=? ORDER BY fixada DESC, id DESC',
            [req.user.id]
        );
        const conversas = rows.map(r => ({
            id_conversa: r.id,
            titulo: r.titulo,
            fixada: !!r.fixada
        }));
        res.json({ conversas });
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
};

// 🎯 FUNÇÃO: Criar Conversa
export const criarConversa = async (req, res) => {
    const { titulo } = req.body;
    const idConversa = `conversa_${req.user.id}_${Date.now()}`;
    try {
        await pool.query('INSERT INTO conversas (id, usuario_id, titulo) VALUES (?,?,?)', 
            [idConversa, req.user.id, titulo || 'Nova Conversa']);
        res.json({ idConversa });
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
};

// 🎯 FUNÇÃO: Renomear Conversa
export const renomearConversa = async (req, res) => {
    const { novoTitulo } = req.body;
    if (!novoTitulo?.trim()) return res.status(400).json({ erro: 'Título obrigatório.' });
    try {
        await pool.query('UPDATE conversas SET titulo=? WHERE id=? AND usuario_id=?', 
            [novoTitulo.trim(), req.params.id, req.user.id]);
        res.json({ message: 'Conversa renomeada.' });
    } catch (err) { 
        res.status(500).json({ erro: err.message }); 
    }
};

// 🎯 FUNÇÃO: Fixar Conversa
export const alternarFixada = async (req, res) => {
    const { fixada } = req.body;
    try {
        await pool.query('UPDATE conversas SET fixada=? WHERE id=? AND usuario_id=?', 
            [fixada ? 1 : 0, req.params.id, req.user.id]);
        res.json({ message: 'Conversa atualizada.' });
    } catch (err) { 
        res.status(500).json({ erro: err.message }); 
    }
};

// 🎯 FUNÇÃO: Deletar Conversa (Corrigida!)
export const deletarConversa = async (req, res) => {
    try {
        await pool.query('DELETE FROM mensagens_chat WHERE id_conversa=?', [req.params.id]);
        await pool.query('DELETE FROM conversas WHERE id=? AND usuario_id=?', [req.params.id, req.user.id]);
        res.json({ message: 'Conversa deletada.' });
    } catch (err) { 
        res.status(500).json({ erro: err.message }); 
    }
};

// 🎯 FUNÇÃO: Stream do Chat (O Cérebro da IA salvando na tabela certa)
export const streamChat = async (req, res) => {
    const nomeUsuario = req.user?.nome || "Visitante";
    const idUsuario   = req.user?.id || null;
    const { mensagem, conversa_id, anonimo } = req.body;

    try {
        // Salva a mensagem do usuário no banco (tabela nova)
        if (!anonimo && req.isAuthenticated() && conversa_id) {
            await pool.query(
                'INSERT INTO mensagens_chat (id_usuario, id_conversa, conteudo, tipo_sender) VALUES (?, ?, ?, ?)',
                [idUsuario, conversa_id, mensagem, 'usuario']
            );
        }

        // Simula processamento da IA (Aqui você chama o Python/Gemini como antes)
        // Substitua esta parte pela sua lógica real do askIanaPython/askGemini se necessário
        let respostaIA = "Processando sua mensagem pelas engrenagens neurais...";
        
        const pythonExecutable = resolvePythonExecutable();
        const scriptPath = path.join(__dirname, "..", "iana.py");
        
        const proc = spawn(pythonExecutable, [scriptPath, nomeUsuario, conversa_id || 'chat_geral', mensagem]);
        
        let resposta = '', erroLog = '';
        proc.stdout.on('data', d => resposta += d.toString());
        proc.stderr.on('data', d => erroLog += d.toString());
        
        proc.on('close', async code => {
            respostaIA = resposta.trim() || "Desculpe, tive um problema de conexão.";
            
            // Salva a resposta da IA no banco (tabela nova)
            if (!anonimo && req.isAuthenticated() && conversa_id) {
                await pool.query(
                    'INSERT INTO mensagens_chat (id_usuario, id_conversa, conteudo, tipo_sender) VALUES (?, ?, ?, ?)',
                    [idUsuario, conversa_id, respostaIA, 'iana']
                );
            }
            
            res.json({ resposta: respostaIA });
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: "Erro ao processar mensagem." });
    }
};