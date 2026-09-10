import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function pythonExecutable(root, env = process.env) {
  if (env.IANA_PYTHON_PATH) return env.IANA_PYTHON_PATH;
  for (const folder of ['.venv', 'venv']) {
    const candidate = path.join(root, folder, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

export async function ensureConversation(pool, userId, requestedId, message) {
  if (!userId) return null;
  if (requestedId) {
    const [rows] = await pool.query('SELECT id FROM conversas WHERE id=? AND usuario_id=?', [requestedId, userId]);
    if (rows.length) return rows[0].id;
    const error = new Error('Conversa não encontrada.');
    error.status = 404;
    throw error;
  }
  const id = `conv_${crypto.randomUUID()}`;
  const title = String(message).replace(/\[.*?\]/g, '').trim().slice(0, 80) || 'Nova Conversa';
  await pool.query('INSERT INTO conversas (id,usuario_id,titulo,atualizado_em) VALUES (?,?,?,NOW())', [id, userId, title]);
  return id;
}

export function attachmentPart(body) {
  const raw = body.imagem || body.audio || body.arquivo;
  if (!raw) return null;
  if (typeof raw !== 'string') throw Object.assign(new Error('Anexo inválido.'), { status: 400 });
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(raw);
  const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'audio/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'application/pdf']);
  if (!match || !allowed.has(match[1])) throw Object.assign(new Error('Formato de anexo não suportado.'), { status: 400 });
  if (Buffer.byteLength(match[2], 'base64') > 10 * 1024 * 1024) throw Object.assign(new Error('Anexo maior que 10 MB.'), { status: 413 });
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
}
