// Guardas de sessão da chamada, sem abrir serviços externos.
export function voiceSessionRoom(sessionId) {
  return `voice-session:${sessionId}`;
}

export function voiceSessionIdentity(session) {
  const userId = session?.passport?.user;
  if (userId !== undefined && userId !== null) return `user:${userId}`;
  return session?.knowledgeGuestId ? `guest:${session.knowledgeGuestId}` : null;
}

export function voiceRequestPayload(state, message, visualContext = '', humanMessage = true) {
  return {
    mensagem: message,
    sessao_id: state.conversaId,
    usuario_id: state.identidadeAprendizado,
    nome_usuario: state.nome,
    config_usuario: humanMessage ? state.configUsuario : { ...state.configUsuario, aprender_conversas: false },
    jogo_atual: state.jogoAtual,
    contexto_visual: visualContext,
  };
}

export async function socketSessionCurrent(socket, expected) {
  if (!socket.connected || !expected?.sessionId || socket.request?.sessionID !== expected.sessionId) return false;
  const session = socket.request?.session;
  if (typeof session?.reload !== 'function') return false;
  const loaded = await new Promise(resolve => session.reload(error => resolve(!error)));
  return loaded && socket.connected && socket.request.sessionID === expected.sessionId
    && voiceSessionIdentity(socket.request.session) === expected.identity;
}

export function voiceTurnActive(socket, state, turn, states) {
  return socket.connected && states.get(socket.id) === state && state.turno === turn;
}

export function cancelVoiceTurn(state) {
  if (!state) return;
  state.turno += 1;
  state.ocupado = false;
  state.requestController?.abort();
  state.requestController = null;
}

export function clearVoiceState(socketId, states, streams) {
  cancelVoiceTurn(states.get(socketId));
  states.delete(socketId);
  const stream = streams.get(socketId);
  streams.delete(socketId);
  if (stream) {
    try { stream.close(); } catch {}
  }
}
