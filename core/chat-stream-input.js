/**
 * Normaliza os dados de entrada do endpoint SSE do chat.
 * POST lê o corpo; GET é mantido apenas para compatibilidade legada.
 */
export function parseChatStreamInput(req = {}) {
  const input = req.method === 'POST' ? req.body : req.query;
  const mensagem = typeof input?.mensagem === 'string' ? input.mensagem.trim() : '';
  const conversaId = typeof input?.conversa_id === 'string' ? input.conversa_id.trim() : '';

  let configUsuario = {};
  const config = input?.config;

  if (typeof config === 'string' && config.trim()) {
    try {
      const parsed = JSON.parse(config);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        configUsuario = parsed;
      }
    } catch {}
  } else if (config && typeof config === 'object' && !Array.isArray(config)) {
    configUsuario = config;
  }

  return { mensagem, conversaId, configUsuario };
}
