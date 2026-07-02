
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'iana_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

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
    if (!genAI) {
        console.warn('[GEMINI] genAI não inicializado (sem API key ou erro de import).');
        return null;
    }
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
                role: msg.sender === 'iana' ? 'model' : 'user',
                parts: [{ text: msg.conteudo }]
            })),
            generationConfig: { maxOutputTokens: 2048 }
        });

        const result = await chat.sendMessage(mensagem);
        return result.response.text();
    } catch (err) {
        console.error('[GEMINI] Erro detalhado:', err.message);
        return null;
    }
}

function resolvePythonExecutable() {
    if (process.env.IANA_PYTHON_PATH) return process.env.IANA_PYTHON_PATH;
    return process.platform === 'win32' ? 'python' : 'python3';
}

async function askIanaPython(nomeUsuario, idConversa, mensagem) {
    return new Promise((resolve, reject) => {
        const pythonExecutable = resolvePythonExecutable();
        const scriptPath = path.join(__dirname, "..", "iana.py");

        const ianaProcess = spawn(pythonExecutable, [
            scriptPath, nomeUsuario, idConversa || "chat_geral", mensagem
        ]);

        let respostaIana = "", erroLog = "";
        ianaProcess.stdout.on("data", d => respostaIana += d.toString());
        ianaProcess.stderr.on("data", d => erroLog += d.toString());

        ianaProcess.on("close", (code) => {
            if (code !== 0 || !respostaIana.trim()) {
                console.error('[PYTHON] stderr:', erroLog || '(vazio)');
                console.error('[PYTHON] exit code:', code);
                return reject(new Error(`Python exited with code ${code}`));
            }
            resolve(respostaIana.trim());
        });

        ianaProcess.on("error", (err) => {
            console.error('[PYTHON] Falha ao executar (provavelmente python não está no PATH):', err.message);
            reject(err);
        });
    });
}

async function garantirConversa(idUsuario, idConversa, mensagem) {
    if (!idUsuario) return idConversa || null;
    const idFinal = idConversa || `conversa_${idUsuario}_${Date.now()}`;
    const limpo   = mensagem.replace(/\[.*?\]/g, '').trim();
    const titulo  = (limpo.slice(0, 40) || 'Nova Conversa') + (limpo.length > 40 ? '...' : '');

    try {
        await pool.query(
            `INSERT INTO conversas (id_conversa, id_usuario, titulo)
             VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE titulo = titulo`,
            [idFinal, idUsuario, titulo]
        );
    } catch (e) {
        console.error('[DB] Erro ao criar/atualizar conversa:', e.message);
    }
    return idFinal;
}

export const streamChat = async (req, res) => {
    const nomeUsuario = req.user?.nome || "Visitante";
    const idUsuario   = req.user?.id || null;
    const mensagem    = req.body.mensagem;

    if (!mensagem?.trim()) {
        return res.status(400).json({ error: "Mensagem não fornecida." });
    }

    let idConversa = null;
    try {
        idConversa = await garantirConversa(idUsuario, req.body.idConversa, mensagem);
    } catch (e) {
        console.error('[DB] garantirConversa falhou:', e.message);
    }

    // Salva mensagem do usuário (não trava o fluxo se falhar)
    if (idUsuario && idConversa) {
        try {
            await pool.query(
                `INSERT INTO mensagens_chat (id_usuario, id_conversa, conteudo, tipo_sender, criado_em)
                 VALUES (?, ?, ?, 'usuario', NOW())`,
                [idUsuario, idConversa, mensagem]
            );
        } catch (e) {
            console.error('[DB] Erro ao salvar mensagem do usuário:', e.message);
        }
    }

    // Histórico (não trava se falhar)
    let historicoConversa = [];
    if (idUsuario && idConversa) {
        try {
            const [msgs] = await pool.query(
                `SELECT conteudo, tipo_sender as sender FROM mensagens_chat
                 WHERE id_usuario = ? AND id_conversa = ? ORDER BY criado_em DESC LIMIT 10`,
                [idUsuario, idConversa]
            );
            historicoConversa = msgs.reverse();
        } catch (e) {
            console.error('[DB] Erro ao buscar histórico:', e.message);
        }
    }

    const humor = req.body.estadoEmocional || detectarHumor(mensagem);

    // Tenta Gemini
    let respostaIana = await askGemini(mensagem, historicoConversa, instrucaoPorHumor(humor));

    // Tenta Python se Gemini falhou
    if (!respostaIana) {
        console.log('[FALLBACK] Gemini falhou, tentando iana.py...');
        try {
            respostaIana = await askIanaPython(nomeUsuario, idConversa || "chat_geral", mensagem);
        } catch (e) {
            console.error('[FALLBACK] iana.py também falhou:', e.message);
        }
    }

    // Se TUDO falhou, ainda responde 200 com mensagem amigável
    if (!respostaIana) {
        respostaIana = 'Estou em atualização nesse assunto agora — em breve devo ter mais informações. Posso te ajudar com outra coisa? 😊';
        console.warn('[AVISO] Nenhuma fonte respondeu (Gemini e Python falharam). Verifique logs acima.');
    }

    // Salva resposta (não trava se falhar)
    if (idUsuario && idConversa) {
        try {
            await pool.query(
                `INSERT INTO mensagens_chat (id_usuario, id_conversa, conteudo, tipo_sender, criado_em)
                 VALUES (?, ?, ?, 'iana', NOW())`,
                [idUsuario, idConversa, respostaIana.trim()]
            );
        } catch (e) {
            console.error('[DB] Erro ao salvar resposta da Iana:', e.message);
        }
    }

    return res.json({ resposta: respostaIana.trim(), idConversa: idConversa || null });

};