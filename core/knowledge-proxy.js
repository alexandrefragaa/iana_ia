import express from 'express';
import net from 'node:net';
import { isPublicIP } from './safe-links.js';
import { conversationIdentity } from './runtime.js';

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function validateKnowledgeRequest(body = {}) {
  if (typeof body.url !== 'string' || !body.url.trim() || body.url.length > 2048) {
    throw invalid('Informe um link de site, vídeo ou busca do YouTube (até 2048 caracteres).');
  }
  let url;
  try { url = new URL(body.url.trim()); } catch { throw invalid('Link inválido. Use http:// ou https://.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      /[\s\x00-\x1f]/.test(body.url.trim()) || !['', '80', '443'].includes(url.port) ||
      host === 'localhost' || /\.(localhost|local|internal)$/.test(host) ||
      (net.isIP(host) ? !isPublicIP(host) : !host.includes('.'))) {
    throw invalid('Use um link público sem credenciais, espaços ou porta personalizada.');
  }
  const max_videos = body.max_videos ?? 5;
  const recent_days = body.recent_days ?? 7;
  if (!Number.isInteger(max_videos) || max_videos < 1 || max_videos > 20) {
    throw invalid('A quantidade de vídeos precisa estar entre 1 e 20.');
  }
  if (!Number.isInteger(recent_days) || recent_days < 0 || recent_days > 365) {
    throw invalid('O período precisa estar entre 0 e 365 dias (0 = sem filtro).');
  }
  return { url: url.href, max_videos, recent_days };
}

// Keep the Python credential on the server even when an upstream error echoes it.
function redact(value, secret) {
  if (typeof value === 'string') return secret ? value.split(secret).join('[redigido]') : value;
  if (Array.isArray(value)) return value.map(item => redact(item, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secret), redact(item, secret)]));
  }
  return value;
}

export function createKnowledgeRouter({ pythonApiUrl, apiKey, authRequired, createLimiter, fetchImpl = fetch }) {
  const base = new URL('/api/v1/knowledge', pythonApiUrl);
  if (!['http:', 'https:'].includes(base.protocol) || !apiKey || !authRequired) {
    throw new Error('Configuração da base de conhecimento inválida.');
  }
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(authRequired);

  async function request(path = '', options = {}, userId = null) {
    let response;
    try {
      response = await fetchImpl(`${base.href}${path}`, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, ...(userId ? { 'X-Iana-User-Id': userId } : {}) }
      });
    } catch {
      throw Object.assign(new Error('O serviço de conhecimento está indisponível. Tente novamente.'), { status: 503 });
    }
    let data;
    try { data = await response.json(); } catch {
      throw Object.assign(new Error('O serviço de conhecimento retornou uma resposta inválida.'), { status: 502 });
    }
    if (!response.ok) {
      const status = [400, 404, 409, 413, 422, 429].includes(response.status) ? response.status : 503;
      const message = status === 503 ? 'O serviço de conhecimento está indisponível. Tente novamente.' :
        (data.mensagem || data.error || data.erro || 'Não foi possível processar esta fonte.');
      throw Object.assign(new Error(redact(String(message), apiKey)), { status });
    }
    return redact(data, apiKey);
  }

  const handle = handler => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await handler(req, res); }
    catch (error) { res.status(error.status || 500).json({ status: 'erro', mensagem: error.message || 'Não foi possível acessar a base.' }); }
  };

  router.get('/', handle(async (req, res) => {
    const data = await request('', {}, conversationIdentity(req.user, req.session));
    if (!Array.isArray(data.documents) || !data.stats) throw Object.assign(new Error('Resposta da base de conhecimento inválida.'), { status: 502 });
    res.json(data);
  }));

  router.post('/jobs', ...(createLimiter ? [createLimiter] : []), handle(async (req, res) => {
    const input = validateKnowledgeRequest(req.body);
    const data = await request('/jobs', { method: 'POST', body: JSON.stringify(input) });
    if (!data.job || typeof data.job.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(data.job.id)) {
      throw Object.assign(new Error('O serviço não informou uma tarefa válida.'), { status: 502 });
    }
    req.session.knowledgeJobIds = [...(req.session.knowledgeJobIds || []), data.job.id].slice(-100);
    res.status(202).json(data);
  }));

  router.get('/jobs/:id', handle(async (req, res) => {
    const id = req.params.id;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw invalid('Identificador de tarefa inválido.');
    if (!req.session.knowledgeJobIds?.includes(id)) {
      return res.status(404).json({ status: 'erro', mensagem: 'Tarefa não encontrada nesta sessão.' });
    }
    res.json(await request(`/jobs/${encodeURIComponent(id)}`));
  }));
  return router;
}
