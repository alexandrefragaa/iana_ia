/* ================================================================
   IANA — chat.js — reescrito e otimizado
   (com integração do IanaHUD — ver comentários "INTEGRAÇÃO HUD")
   ================================================================ */

'use strict';

let aguardandoResposta = false;
let idConversaAtiva = null;
let controller = new AbortController();
let emailRecuperacao = '';
let idConversaRenomear = null;
let idConversaExcluir = null;
let usuarioAtual = null;

let ttsEnabled = true;
let ttsNextResponse = false;
let ttsVoice = null;

let mediaRecorderAudio = null;
let audioChunks = [];
let gravandoAudio = false;

let streamCamera = null;
let streamVoz = null;

// Chamada de voz em tempo real (Gemini Live via socket.io — ver
// abrirVoz/fecharVoz). Nada de SpeechRecognition nem TTS do navegador
// aqui: o áudio do microfone é streamado cru pro servidor, e o áudio
// de resposta chega já pronto e é tocado direto.
let emChamadaVoz = false;
let socketVoz = null;
let mutadoVoz = false;
let micStreamVoz = null;
let audioCtxCapturaVoz = null;
let processorVozCaptura = null;
let audioCtxReproducaoVoz = null;
let proximoInicioReproducao = 0;
let fontesAgendadasVoz = [];
let bufferTranscricaoUsuario = '';
let bufferTranscricaoIana = '';

const TELAS = [
    'tela-login', 'tela-cadastro', 'tela-esqueci', 'tela-codigo',
    'tela-pesquisa', 'tela-feedback', 'tela-renomear', 'tela-confirmar'
];

/* ── UTILS ────────────────────────────────────────────────────── */
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function sanitizarHTML(html) {
    return typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
}

// FIX (XSS): títulos de conversa vêm do usuário (mensagem original ou
// renomeação via /chat/conversas/:id) e o server não sanitiza. Antes,
// carregarHistorico() jogava o título direto num innerHTML sem escapar,
// permitindo injetar HTML/JS armazenado (ex: renomear pra
// "<img src=x onerror=alert(1)>"), que rodava pra qualquer um que
// abrisse a sidebar depois. Esta função escapa entidades HTML antes de
// qualquer título entrar em innerHTML.
function escaparHTML(texto) {
    const div = document.createElement('div');
    div.textContent = String(texto ?? '');
    return div.innerHTML;
}

/* ── CONFIGURAÇÕES (lidas do localStorage) ────────────────────── */
const CONFIG_KEY = 'iana_config';

function obterConfigSalva() {
    try {
        return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
    } catch {
        return {};
    }
}

function montarConfigPrompt() {
    const c = obterConfigSalva();
    if (!Object.keys(c).length) return '';

    const linhas = [];
    if (c.personalidade?.length) linhas.push(`Estilo de personalidade: ${c.personalidade.join(', ')}.`);
    if (c.foco?.length) linhas.push(`Foco principal (priorize esses assuntos): ${c.foco.join(', ')}.`);
    if (c.plataforma?.length) linhas.push(`Plataforma do usuário: ${c.plataforma.join(', ')}.`);
    if (c.voz?.length) linhas.push(`Estilo de escrita/voz: ${c.voz.join(', ')}.`);
    if (c.tamanho) linhas.push(`Tamanho preferido das respostas: ${c.tamanho}.`);
    if (c.emojis) linhas.push(`Uso de emojis: ${c.emojis}.`);
    if (c.instrucoes) linhas.push(`Instruções específicas do usuário: ${c.instrucoes}`);
    if (c.sobreVoce) linhas.push(`Sobre o usuário: ${c.sobreVoce}`);

    const comportamentos = [];
    if (c.perguntas === false) comportamentos.push('NÃO termine a resposta com uma pergunta.');
    if (c.humor === false) comportamentos.push('NÃO precisa adaptar o tom ao humor do usuário.');
    if (c.criatividade === false) comportamentos.push('NÃO invente/crie conteúdo quando não souber a resposta — diga que não sabe.');
    if (c.contexto === false) comportamentos.push('NÃO dependa do contexto de mensagens anteriores.');
    if (comportamentos.length) linhas.push(comportamentos.join(' '));

    return linhas.join('\n');
}

/* ── TTS (TEXT-TO-SPEECH) — só usado no CHAT DE TEXTO. Na chamada de
   voz (Gemini Live) o áudio já vem pronto do servidor, não passa por
   aqui. ────────────────────────────────────────────────────────── */
function getVoicesTTS() {
    return typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : [];
}

function escolherVozTTS() {
    if (ttsVoice) return ttsVoice;
    const voices = getVoicesTTS();
    if (!voices.length) return null;
    const preferida = voices.find(v => /pt-BR|pt/i.test(v.lang) && /female|maria|luciana|fernanda/i.test(v.name));
    ttsVoice = preferida || voices.find(v => /pt-BR|pt/i.test(v.lang)) || voices[0];
    return ttsVoice;
}

function falar(texto) {
    try {
        if (!ttsEnabled || typeof speechSynthesis === 'undefined' || !texto) return;
        const ut = new SpeechSynthesisUtterance(texto.replace(/\n/g, ' '));
        ut.lang = 'pt-BR';
        const voz = escolherVozTTS();
        if (voz) ut.voice = voz;
        ut.rate = 1;
        ut.pitch = 1.05;
        ut.onstart = () => { window.IanaHUD?.setEstado('falando'); };
        ut.onend = () => { window.IanaHUD?.setEstado('ocioso'); };
        speechSynthesis.cancel();
        speechSynthesis.speak(ut);
    } catch (e) {
        console.warn('TTS falhou:', e);
    }
}

/* ── MODAL DE AUTENTICAÇÃO (overlay-auth) ────────────────────── */
function mostrarTela(id) {
    const overlay = document.getElementById('overlay-auth');
    if (!overlay) return;
    TELAS.forEach(t => {
        const el = document.getElementById(t);
        if (el) el.style.display = (t === id) ? 'block' : 'none';
    });
    overlay.style.display = 'flex';
}

function fecharAuth() {
    const overlay = document.getElementById('overlay-auth');
    if (overlay) overlay.style.display = 'none';
}

/* ── MODAL CÂMERA ─────────────────────────────────────────────── */
async function abrirCamera() {
    const overlay = document.getElementById('overlay-camera');
    const preview = document.getElementById('camera-preview');
    if (!overlay || !preview) return;
    try {
        streamCamera = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        preview.srcObject = streamCamera;
        overlay.style.display = 'flex';
    } catch (e) {
        alert('Não foi possível acessar a câmera: ' + e.message);
    }
}

function fecharCamera() {
    const overlay = document.getElementById('overlay-camera');
    if (streamCamera) {
        streamCamera.getTracks().forEach(t => t.stop());
        streamCamera = null;
    }
    if (overlay) overlay.style.display = 'none';
}

async function capturarFoto() {
    const preview = document.getElementById('camera-preview');
    if (!preview) return;
    const canvas = document.createElement('canvas');
    canvas.width = preview.videoWidth || 640;
    canvas.height = preview.videoHeight || 480;
    canvas.getContext('2d').drawImage(preview, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');

    adicionarImagemUsuario(dataUrl);
    fecharCamera();
    await processarEnvioIA('[Usuário enviou uma foto capturada pela câmera.]');
}

/* ── CHAMADA DE VOZ EM TEMPO REAL (Gemini Live) ──────────────────
   Fluxo: microfone -> PCM 16kHz -> socket.io -> servidor (sessão Live)
   -> Gemini já responde em áudio conforme processa, sem esperar você
   terminar de falar pra só então "processar tudo". O áudio de volta
   (PCM 24kHz) chega em pedaços e é tocado assim que chega. ────────── */

function abrirVoz() {
    const overlay = document.getElementById('overlay-voz');
    if (overlay) overlay.style.display = 'flex';

    emChamadaVoz = true;
    mutadoVoz = false;
    bufferTranscricaoUsuario = '';
    bufferTranscricaoIana = '';
    window.IanaHUD?.iniciar('voz-hud-grande', 'lg');
    window.IanaHUD?.setEstado('ouvindo');
    limparFeedVoz();

    const statusEl = document.getElementById('voz-status');
    if (statusEl) statusEl.textContent = 'Conectando...';

    iniciarSocketVoz();
}

function fecharVoz() {
    const overlay = document.getElementById('overlay-voz');
    if (overlay) overlay.style.display = 'none';

    if (socketVoz) {
        try { socketVoz.emit('voz:encerrar'); } catch (e) { }
        socketVoz.disconnect();
        socketVoz = null;
    }

    pararCapturaMicrofone();
    pararReproducaoVoz();
    if (audioCtxReproducaoVoz) {
        audioCtxReproducaoVoz.close().catch(() => { });
        audioCtxReproducaoVoz = null;
    }

    emChamadaVoz = false;
    mutadoVoz = false;
    bufferTranscricaoUsuario = '';
    bufferTranscricaoIana = '';

    const interim = document.getElementById('voz-interim');
    if (interim) interim.textContent = '';

    const btnMute = document.getElementById('btn-voz-mute');
    if (btnMute) { btnMute.classList.remove('mutado'); btnMute.textContent = '🎙️'; }

    // INTEGRAÇÃO HUD: saiu da chamada, volta ao repouso.
    window.IanaHUD?.setEstado('ocioso');
}

/* Conecta o socket.io (exige login — mesma auth do resto do app) e
   registra os eventos da sessão de voz. */
function iniciarSocketVoz() {
    const statusEl = document.getElementById('voz-status');

    if (typeof io === 'undefined') {
        if (statusEl) statusEl.textContent = 'Chamada de voz indisponível (socket.io não carregado).';
        return;
    }

    socketVoz = io({ withCredentials: true });

    socketVoz.on('connect', () => socketVoz.emit('voz:iniciar'));

    socketVoz.on('connect_error', () => {
        if (statusEl) statusEl.textContent = 'Faça login pra usar a chamada de voz.';
    });

    socketVoz.on('voz:pronto', async () => {
        if (statusEl) statusEl.textContent = 'Fale com a Iana';
        try {
            iniciarReproducaoVoz();
            await iniciarCapturaMicrofone();
        } catch (e) {
            if (statusEl) statusEl.textContent = 'Não consegui acessar o microfone: ' + e.message;
        }
    });

    socketVoz.on('voz:transcricao-usuario', ({ texto, final }) => {
        const interim = document.getElementById('voz-interim');
        if (final) {
            if (bufferTranscricaoUsuario.trim()) adicionarNaFeedVoz('user', bufferTranscricaoUsuario.trim());
            bufferTranscricaoUsuario = '';
            if (interim) interim.textContent = '';
        } else {
            bufferTranscricaoUsuario += texto;
            if (interim) interim.textContent = bufferTranscricaoUsuario;
        }
    });

    socketVoz.on('voz:transcricao-iana', ({ texto, final }) => {
        if (final) {
            if (bufferTranscricaoIana.trim()) adicionarNaFeedVoz('iana', bufferTranscricaoIana.trim());
            bufferTranscricaoIana = '';
        } else {
            bufferTranscricaoIana += texto;
        }
    });

    // Áudio de resposta chegando em tempo real — toca assim que chega,
    // sem esperar a frase inteira (é isso que dá a sensação "ao vivo").
    socketVoz.on('voz:audio-resposta', ({ audio }) => tocarChunkAudio(audio));

    // Barge-in: você começou a falar por cima dela — para o que estava tocando.
    socketVoz.on('voz:interrompido', () => pararReproducaoVoz());

    socketVoz.on('voz:erro', ({ mensagem }) => {
        if (statusEl) statusEl.textContent = mensagem || 'Erro na chamada.';
    });

    socketVoz.on('disconnect', () => {
        window.IanaHUD?.setEstado('ocioso');
    });
}

/* ── CAPTURA DO MICROFONE (mic -> PCM 16kHz -> base64 -> socket) ── */
async function iniciarCapturaMicrofone() {
    micStreamVoz = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    audioCtxCapturaVoz = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtxCapturaVoz.createMediaStreamSource(micStreamVoz);

    // ScriptProcessorNode é o jeito mais simples e compatível de pegar
    // os samples crus sem precisar carregar um AudioWorklet à parte;
    // é deprecated mas ainda funciona em todo navegador relevante.
    processorVozCaptura = audioCtxCapturaVoz.createScriptProcessor(4096, 1, 1);

    // Precisa estar conectado até .destination pra o onaudioprocess
    // disparar de forma confiável — mas com gain 0 pra não tocar o
    // seu próprio microfone de volta (eco).
    const silencioso = audioCtxCapturaVoz.createGain();
    silencioso.gain.value = 0;

    processorVozCaptura.onaudioprocess = (e) => {
        if (mutadoVoz || !socketVoz?.connected) return;
        const entrada = e.inputBuffer.getChannelData(0);

        // Nível real pro visualizador do orbe (mesma captura — sem 2º
        // getUserMedia separado só pra isso, como era antes).
        let soma = 0;
        for (let i = 0; i < entrada.length; i++) soma += entrada[i] * entrada[i];
        const nivel = Math.min(1, Math.sqrt(soma / entrada.length) * 6);
        document.querySelectorAll('.jarvis-bars').forEach(b => b.style.setProperty('--nivel', nivel.toFixed(2)));

        const reamostrado = reamostrarPara16kHz(entrada, audioCtxCapturaVoz.sampleRate);
        const pcm16 = float32ParaPCM16(reamostrado);
        socketVoz.emit('voz:audio', arrayBufferParaBase64(pcm16.buffer));
    };

    source.connect(processorVozCaptura);
    processorVozCaptura.connect(silencioso);
    silencioso.connect(audioCtxCapturaVoz.destination);
}

function pararCapturaMicrofone() {
    if (processorVozCaptura) { processorVozCaptura.disconnect(); processorVozCaptura = null; }
    if (micStreamVoz) { micStreamVoz.getTracks().forEach(t => t.stop()); micStreamVoz = null; }
    if (audioCtxCapturaVoz) { audioCtxCapturaVoz.close().catch(() => { }); audioCtxCapturaVoz = null; }
    document.querySelectorAll('.jarvis-bars').forEach(b => b.style.setProperty('--nivel', 0));
}

// A Live API espera PCM a 16kHz, mas o microfone roda na taxa nativa
// do aparelho (normalmente 44.1/48kHz) — reamostragem simples por
// decimação (suficiente pra voz; não é qualidade de estúdio, mas é
// leve o bastante pra rodar em tempo real sem travar).
function reamostrarPara16kHz(float32, taxaOriginal) {
    if (taxaOriginal === 16000) return float32;
    const razao = taxaOriginal / 16000;
    const novoTamanho = Math.floor(float32.length / razao);
    const resultado = new Float32Array(novoTamanho);
    for (let i = 0; i < novoTamanho; i++) resultado[i] = float32[Math.floor(i * razao)];
    return resultado;
}

function float32ParaPCM16(float32Array) {
    const pcm16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm16;
}

function arrayBufferParaBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function base64ParaArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

/* ── REPRODUÇÃO DO ÁUDIO DE RESPOSTA (PCM 24kHz, chega em pedaços) ──
   Agenda cada pedaço pra tocar logo depois do anterior (fila por
   currentTime), então mesmo chegando em chunks separados soa como
   uma fala contínua, sem cortes nem sobreposição. */
function iniciarReproducaoVoz() {
    audioCtxReproducaoVoz = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    proximoInicioReproducao = 0;
}

function tocarChunkAudio(base64PCM) {
    if (!audioCtxReproducaoVoz) return;

    const pcm16 = new Int16Array(base64ParaArrayBuffer(base64PCM));
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;

    const audioBuffer = audioCtxReproducaoVoz.createBuffer(1, float32.length, 24000);
    audioBuffer.copyToChannel(float32, 0);

    const source = audioCtxReproducaoVoz.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtxReproducaoVoz.destination);

    const agora = audioCtxReproducaoVoz.currentTime;
    const inicio = Math.max(agora, proximoInicioReproducao);
    source.start(inicio);
    proximoInicioReproducao = inicio + audioBuffer.duration;
    fontesAgendadasVoz.push(source);

    // INTEGRAÇÃO HUD: enquanto tem áudio agendado tocando, orbe "fala".
    window.IanaHUD?.setEstado('falando');
    source.onended = () => {
        fontesAgendadasVoz = fontesAgendadasVoz.filter(s => s !== source);
        if (!fontesAgendadasVoz.length) window.IanaHUD?.setEstado('ouvindo');
    };
}

function pararReproducaoVoz() {
    fontesAgendadasVoz.forEach(s => { try { s.stop(); } catch (e) { } });
    fontesAgendadasVoz = [];
    proximoInicioReproducao = 0;
}

/* ── FEED AO VIVO DA CHAMADA ──────────────────────────────────── */
function limparFeedVoz() {
    const feed = document.getElementById('voz-feed');
    if (feed) feed.innerHTML = '';
    const interim = document.getElementById('voz-interim');
    if (interim) interim.textContent = '';
}

function adicionarNaFeedVoz(tipo, texto) {
    const feed = document.getElementById('voz-feed');
    if (!feed || !texto?.trim()) return;
    const bolha = document.createElement('div');
    bolha.className = `voz-feed-msg ${tipo === 'user' ? 'voz-feed-user' : 'voz-feed-iana'}`;
    bolha.textContent = texto;
    feed.appendChild(bolha);
    feed.scrollTop = feed.scrollHeight;
}

function toggleMuteVoz() {
    mutadoVoz = !mutadoVoz;
    const btn = document.getElementById('btn-voz-mute');
    if (btn) {
        btn.textContent = mutadoVoz ? '🔇' : '🎙️';
        btn.classList.toggle('mutado', mutadoVoz);
    }
    if (mutadoVoz) {
        document.querySelectorAll('.jarvis-bars').forEach(b => b.style.setProperty('--nivel', 0));
    }
}

/* ── MENU DE UPLOAD ───────────────────────────────────────────── */
function iniciarMenuUpload() {
    const btnMais = document.getElementById('btn-mais');
    const menu = document.getElementById('upload-menu');
    const fileInput = document.getElementById('file-input');
    if (!btnMais || !menu) return;

    btnMais.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = btnMais.getBoundingClientRect();
        menu.style.left = rect.left + 'px';
        menu.style.top = (rect.top - menu.offsetHeight - 8) + 'px';
        menu.style.display = (menu.style.display === 'flex') ? 'none' : 'flex';
    });

    document.addEventListener('click', () => {
        menu.style.display = 'none';
    });

    menu.addEventListener('click', (e) => e.stopPropagation());

    document.getElementById('up-foto')?.addEventListener('click', () => {
        menu.style.display = 'none';
        abrirCamera();
    });

    document.getElementById('up-imagem')?.addEventListener('click', () => {
        menu.style.display = 'none';
        if (fileInput) { fileInput.accept = 'image/*'; fileInput.click(); }
    });

    document.getElementById('up-arquivo')?.addEventListener('click', () => {
        menu.style.display = 'none';
        if (fileInput) { fileInput.accept = '.pdf,.txt,.doc,.docx'; fileInput.click(); }
    });

    document.getElementById('up-audio')?.addEventListener('click', () => {
        menu.style.display = 'none';
        if (fileInput) { fileInput.accept = 'audio/*'; fileInput.click(); }
    });

    document.getElementById('up-tela')?.addEventListener('click', () => {
        menu.style.display = 'none';
        compartilharTela();
    });
}

function iniciarUpload() {
    const fileInput = document.getElementById('file-input');
    if (!fileInput) return;

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;

        if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = async () => {
                adicionarImagemUsuario(reader.result);
                await processarEnvioIA(`[Usuário enviou uma imagem: ${file.name}]`);
            };
            reader.readAsDataURL(file);
        } else {
            await processarEnvioIA(`[Usuário enviou um arquivo: ${file.name}]`);
        }
        fileInput.value = '';
    });
}

async function compartilharTela() {
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        stream.getVideoTracks()[0].addEventListener('ended', () => { });
        await processarEnvioIA('[Usuário compartilhou a tela.]');
        stream.getTracks().forEach(t => t.stop());
    } catch (e) {
        if (e.name !== 'NotAllowedError') {
            alert('Erro ao compartilhar tela: ' + e.message);
        }
    }
}

/* ── GRAVAÇÃO DE ÁUDIO ────────────────────────────────────────── */
function iniciarGravacaoAudio() {
    const btn = document.getElementById('btn-mic');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        if (!gravandoAudio) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorderAudio = new MediaRecorder(stream);
                audioChunks = [];
                mediaRecorderAudio.ondataavailable = e => audioChunks.push(e.data);
                mediaRecorderAudio.onstop = () => {
                    stream.getTracks().forEach(t => t.stop());
                    const blob = new Blob(audioChunks, { type: 'audio/webm' });
                    console.log('Áudio gravado:', blob);
                    // O envio de áudio para transcrição no backend deve ser implementado aqui
                };
                mediaRecorderAudio.start();
                gravandoAudio = true;
                btn.classList.add('gravando');
                btn.title = 'Parar gravação';
            } catch (e) {
                alert('Não foi possível acessar o microfone: ' + e.message);
            }
        } else {
            if (mediaRecorderAudio && mediaRecorderAudio.state !== 'inactive') {
                mediaRecorderAudio.stop();
            }
            gravandoAudio = false;
            btn.classList.remove('gravando');
            btn.title = 'Gravar áudio';
        }
    });
}

/* ── SESSÃO E IDENTIDADE ──────────────────────────────────────── */
async function verificarSessao() {
    try {
        const res = await fetch('/auth/me', { credentials: 'include' });
        const data = await res.json();
        if (data.logado) {
            atualizarUILogado(data.usuario);
        } else {
            atualizarUIVisitante();
        }
    } catch (e) {
        atualizarUIVisitante();
    }
}

function atualizarUIVisitante() {
    usuarioAtual = null;
    const authButtons = document.getElementById('auth-buttons');
    const footer = document.getElementById('sidebar-footer');
    if (authButtons) authButtons.style.display = 'flex';
    if (footer) footer.style.display = 'none';

    const hint = document.getElementById('historico-hint');
    if (hint) hint.textContent = 'Faça login para salvar conversas.';
    const lista = document.getElementById('historico-lista');
    if (lista) lista.innerHTML = '<p class="sidebar-hint">Faça login para salvar conversas.</p>';
}

function atualizarUILogado(usuario) {
    usuarioAtual = usuario;
    const authButtons = document.getElementById('auth-buttons');
    const footer = document.getElementById('sidebar-footer');
    if (authButtons) authButtons.style.display = 'none';
    if (footer) footer.style.display = 'block';

    const nomeEl = document.getElementById('user-nome-sidebar');
    if (nomeEl) nomeEl.textContent = usuario.nome;

    carregarHistorico();
}

/* ── AUTH ─────────────────────────────────────────────────────── */
function mensagemErroAuth(msg, fallback = 'Erro inesperado.') {
    const texto = String(msg || '').toLowerCase();
    if (texto.includes('já cadastrado')) return 'Este e-mail já está cadastrado.';
    if (texto.includes('inválidas')) return 'E-mail ou senha inválidos.';
    if (texto.includes('mínima')) return 'Senha muito curta (mínimo 8 caracteres).';
    return msg || fallback;
}

function mostrarErroTela(id, msg) {
    const el = document.getElementById(id);
    if (el) el.textContent = msg;
}

async function realizarLogin() {
    const email = document.getElementById('login-email')?.value.trim();
    const senha = document.getElementById('login-senha')?.value;
    if (!email || !senha) {
        mostrarErroTela('login-erro', 'Preencha e-mail e senha.');
        return;
    }

    const btn = document.getElementById('btn-login');
    const orig = btn.textContent;
    btn.textContent = 'Entrando...';
    btn.disabled = true;

    try {
        const res = await fetch('/auth/login', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, senha })
        });
        const data = await res.json();
        if (!res.ok) {
            mostrarErroTela('login-erro', mensagemErroAuth(data.erro, 'Falha no login.'));
        } else {
            fecharAuth();
            atualizarUILogado(data.usuario);
        }
    } catch (e) {
        mostrarErroTela('login-erro', 'Erro de conexão.');
    } finally {
        btn.textContent = orig;
        btn.disabled = false;
    }
}

async function realizarCadastro() {
    const nome = document.getElementById('cad-nome')?.value.trim();
    const email = document.getElementById('cad-email')?.value.trim();
    const senha = document.getElementById('cad-senha')?.value;

    if (!nome || !email || !senha) {
        mostrarErroTela('cad-erro', 'Preencha todos os campos.');
        return;
    }

    const btn = document.getElementById('btn-cadastrar');
    const orig = btn.textContent;
    btn.textContent = 'Criando...';
    btn.disabled = true;

    try {
        const res = await fetch('/auth/registro', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, email, senha })
        });
        const data = await res.json();
        if (!res.ok) {
            mostrarErroTela('cad-erro', mensagemErroAuth(data.erro, 'Falha no cadastro.'));
        } else {
            fecharAuth();
            atualizarUILogado(data.usuario);
        }
    } catch (e) {
        mostrarErroTela('cad-erro', 'Erro de conexão.');
    } finally {
        btn.textContent = orig;
        btn.disabled = false;
    }
}

async function realizarLogout() {
    try {
        await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (e) {
        console.warn('Logout falhou:', e);
    }
    atualizarUIVisitante();
    resetarChat();
}

async function enviarCodigoRecuperacao() {
    const email = document.getElementById('esq-email')?.value.trim();
    if (!email) {
        mostrarErroTela('esq-erro', 'Digite seu e-mail.');
        return;
    }

    mostrarErroTela('esq-erro', '');
    try {
        const res = await fetch('/auth/esqueci-senha', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (!res.ok) {
            mostrarErroTela('esq-erro', mensagemErroAuth(data.erro, 'Não foi possível enviar o código.'));
        } else {
            emailRecuperacao = email;
            const label = document.getElementById('cod-label');
            if (label) label.textContent = `Código enviado para ${email}`;
            mostrarTela('tela-codigo');
        }
    } catch (e) {
        mostrarErroTela('esq-erro', 'Erro de conexão.');
    }
}

async function alterarSenha() {
    const codigo = document.getElementById('cod-input')?.value.trim();
    const novaSenha = document.getElementById('cod-nova-senha')?.value;
    if (!codigo || !novaSenha) {
        mostrarErroTela('cod-erro', 'Preencha o código e a nova senha.');
        return;
    }

    try {
        const res = await fetch('/auth/mudar-senha', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: emailRecuperacao, codigo, nova_senha: novaSenha })
        });
        const data = await res.json();
        if (!res.ok) {
            mostrarErroTela('cod-erro', mensagemErroAuth(data.erro, 'Código inválido.'));
        } else {
            alert('✅ Senha alterada! Faça login.');
            mostrarTela('tela-login');
        }
    } catch (e) {
        mostrarErroTela('cod-erro', 'Erro de conexão.');
    }
}

/* ── HISTÓRICO DE CONVERSAS ───────────────────────────────────── */
async function carregarHistorico() {
    const container = document.getElementById('historico-lista');
    if (!container) return;
    try {
        const res = await fetch('/chat/conversas', { credentials: 'include' });
        if (!res.ok) {
            container.innerHTML = '<p class="sidebar-hint">Erro ao carregar o histórico.</p>';
            return;
        }

        const { conversas } = await res.json();
        container.innerHTML = '';

        if (!conversas?.length) {
            container.innerHTML = '<p class="sidebar-hint">Nenhum chat salvo ainda.</p>';
            return;
        }

        conversas.forEach(c => {
            const item = document.createElement('div');
            item.className = `chat-item ${idConversaAtiva === c.id_conversa ? 'active' : ''} ${c.fixada ? 'fixada' : ''}`;
            const tituloOriginal = c.titulo || 'Conversa';
            const tituloEscapado = escaparHTML(tituloOriginal);

            item.innerHTML = `
                <span class="chat-titulo">${tituloEscapado}</span>
                <div class="chat-options-wrapper">
                    <button class="btn-chat-options" type="button">⋮</button>
                    <div class="chat-options-menu">
                        <button class="chat-option-btn" data-acao="fixar">
                            <img src="/img/pin.png" class="menu-icon">
                            <span>${c.fixada ? 'Desafixar' : 'Fixar'}</span>
                        </button>
                        <button class="chat-option-btn" data-acao="renomear">
                            <img src="/img/escrever.png" class="menu-icon">
                            <span>Renomear</span>
                        </button>
                        <button class="chat-option-btn excluir" data-acao="excluir">
                            <img src="/img/lixo.png" class="menu-icon">
                            <span>Excluir</span>
                        </button>
                    </div>
                </div>`;

            item.querySelector('.chat-titulo').addEventListener('click', () => ativarConversa(c.id_conversa, tituloOriginal));

            item.querySelector('.btn-chat-options').addEventListener('click', (e) => {
                e.stopPropagation();
                const btn = e.currentTarget;
                const menu = item.querySelector('.chat-options-menu');
                const isOpen = menu.classList.contains('ativo');

                // Fecha todos os outros menus abertos no histórico
                fecharChatOptionsMenu();

                if (!isOpen) {
                    // FIX: como o menu agora é position:fixed, a posição
                    // precisa ser calculada em relação à janela (viewport),
                    // não mais herdada do CSS relativo ao item.
                    posicionarChatOptionsMenu(btn, menu);
                    menu.classList.add('ativo');
                }
            });

            item.querySelector('[data-acao="fixar"]').addEventListener('click', (e) => {
                e.stopPropagation();
                acaoFixar(c.id_conversa, !c.fixada);
            });

            item.querySelector('[data-acao="renomear"]').addEventListener('click', (e) => {
                e.stopPropagation();
                acaoRenomear(c.id_conversa, tituloOriginal); // Passando a string diretamente sem escapes prejudiciais
            });

            item.querySelector('[data-acao="excluir"]').addEventListener('click', (e) => {
                e.stopPropagation();
                acaoExcluir(c.id_conversa);
            });

            container.appendChild(item);
        });
    } catch (e) {
        console.error('Histórico:', e);
    }
}

function fecharChatOptionsMenu() {
    document.querySelectorAll('.chat-options-menu').forEach(m => m.classList.remove('ativo'));
}

// FIX: menu agora é position:fixed (ver styles.css), então precisa da
// posição calculada em px reais a partir do botão ⋮. Se não couber à
// direita (sidebar perto da borda da tela), cai pra esquerda do botão.
function posicionarChatOptionsMenu(btn, menu) {
    const rectBtn = btn.getBoundingClientRect();
    const larguraMenu = menu.offsetWidth || 140;
    const alturaMenu = menu.offsetHeight || 120;

    let left = rectBtn.right + 8;
    if (left + larguraMenu > window.innerWidth - 8) {
        left = rectBtn.left - larguraMenu - 8;
    }

    let top = rectBtn.top + rectBtn.height / 2 - alturaMenu / 2;
    top = Math.max(8, Math.min(top, window.innerHeight - alturaMenu - 8));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

// Fecha o menu se a lista rolar ou a janela for redimensionada, pra
// não deixar um menu "flutuando" desalinhado do botão que o abriu.
document.getElementById('historico-lista')?.addEventListener('scroll', fecharChatOptionsMenu, { passive: true });
window.addEventListener('resize', fecharChatOptionsMenu);

async function acaoFixar(id, fixar) {
    fecharChatOptionsMenu();
    await fetch(`/chat/conversas/${id}/fixar`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixada: fixar })
    });
    carregarHistorico();
}

function acaoRenomear(id, tituloAtual) {
    fecharChatOptionsMenu();
    idConversaRenomear = id;
    const input = document.getElementById('rename-input');
    if (input) input.value = tituloAtual;
    mostrarTela('tela-renomear');
}

async function salvarRenomear() {
    const novo = document.getElementById('rename-input')?.value.trim();
    if (!novo || !idConversaRenomear) {
        fecharAuth();
        return;
    }
    await fetch(`/chat/conversas/${idConversaRenomear}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novoTitulo: novo })
    });
    fecharAuth();
    carregarHistorico();
}

function acaoExcluir(id) {
    fecharChatOptionsMenu();
    idConversaExcluir = id;
    mostrarTela('tela-confirmar');
}

async function confirmarExcluir() {
    if (!idConversaExcluir) {
        fecharAuth();
        return;
    }
    await fetch(`/chat/conversas/${idConversaExcluir}`, { method: 'DELETE', credentials: 'include' });
    fecharAuth();
    if (idConversaAtiva === idConversaExcluir) {
        resetarChat();
    } else {
        carregarHistorico();
    }
    idConversaExcluir = null;
}

async function pesquisarConversas(termo) {
    const resultados = document.getElementById('pesquisa-resultados');
    if (!resultados) return;
    resultados.innerHTML = '';

    if (!termo.trim()) return;

    try {
        const res = await fetch('/chat/conversas', { credentials: 'include' });
        const { conversas } = await res.json();
        const found = (conversas || []).filter(c => c.titulo?.toLowerCase().includes(termo.toLowerCase()));

        if (!found.length) {
            resultados.innerHTML = '<p class="sidebar-hint">Nenhuma conversa encontrada.</p>';
            return;
        }

        found.forEach(c => {
            const item = document.createElement('div');
            item.className = 'chat-item';
            item.textContent = c.titulo || 'Sem título';
            item.addEventListener('click', () => {
                ativarConversa(c.id_conversa, c.titulo);
                fecharAuth();
            });
            resultados.appendChild(item);
        });
    } catch (e) {
        console.error('Pesquisa:', e);
    }
}

/* ── MENSAGENS (bolhas em #msgs) ──────────────────────────────── */
function mostrarWelcome(mostrar) {
    const welcome = document.getElementById('welcome');
    const chatbox = document.getElementById('chatbox');
    if (welcome) welcome.style.display = mostrar ? 'flex' : 'none';
    if (chatbox) chatbox.classList.toggle('has-messages', !mostrar);
}

function criarBotaoCopiar(getTexto) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-action-btn';
    btn.title = 'Copiar';

    // Atualizado para o nome exato da imagem: copia.png
    btn.innerHTML = '<img src="/img/copia.png" style="width:16px; filter:invert(.7);" alt="Copiar">';

    btn.addEventListener('click', () => {
        const texto = getTexto();
        navigator.clipboard?.writeText(texto).then(() => {
            const original = btn.innerHTML;
            btn.innerHTML = '<span style="font-size:12px; color:#a855f7; font-weight:bold;">Copiado!</span>';
            setTimeout(() => { btn.innerHTML = original; }, 1200);
        }).catch(() => { });
    });
    return btn;
}

function criarBotaoEditar(texto) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-action-btn';
    btn.title = 'Editar mensagem';

    // Atualizado para usar lapis.png
    btn.innerHTML = '<img src="/img/lapis.png" style="width:16px; filter:invert(.7);" alt="Editar">';

    btn.addEventListener('click', () => {
        const input = document.getElementById('chat-input');
        if (!input) return;
        input.value = texto;
        input.focus();
        input.style.height = 'auto';
        input.style.height = input.scrollHeight + 'px';
    });
    return btn;
}

function configurarExpandir(bubble, linhaAcoes) {
    bubble.classList.add('msg-clamped');

    // Pequeno timeout para garantir que o DOM processou a altura corretamente
    setTimeout(() => {
        const ultrapassou = bubble.scrollHeight > bubble.clientHeight + 1;
        if (!ultrapassou) {
            bubble.classList.remove('msg-clamped');
            return;
        }

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'msg-expand-btn';
        btn.textContent = '▼ Expandir';
        let expandido = false;

        btn.addEventListener('click', () => {
            expandido = !expandido;
            bubble.classList.toggle('msg-clamped', !expandido);
            btn.textContent = expandido ? '▲ Recolher' : '▼ Expandir';
        });

        linhaAcoes.appendChild(btn);
    }, 50);
}

function adicionarBolhaUsuario(texto) {
    const msgs = document.getElementById('msgs');
    if (!msgs) return;
    mostrarWelcome(false);

    const wrap = document.createElement('div');
    wrap.className = 'user-msg-wrap nova-mensagem';

    const bubble = document.createElement('div');
    bubble.className = 'user-msg-bubble';
    bubble.textContent = texto;
    wrap.appendChild(bubble);

    const acoes = document.createElement('div');
    acoes.className = 'msg-actions user-actions';
    acoes.appendChild(criarBotaoEditar(texto));
    acoes.appendChild(criarBotaoCopiar(() => texto));
    wrap.appendChild(acoes);

    msgs.appendChild(wrap);
    configurarExpandir(bubble, acoes);
    scrollParaFim();

    // Em chamada de voz, a mesma fala também aparece no feed ao vivo.
    if (emChamadaVoz) adicionarNaFeedVoz('user', texto);
}

function adicionarImagemUsuario(dataUrl) {
    const msgs = document.getElementById('msgs');
    if (!msgs) return;
    mostrarWelcome(false);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;justify-content:flex-end;width:100%;margin-bottom:8px;';
    wrap.innerHTML = `<img src="${dataUrl}" style="max-width:240px;max-height:180px;border-radius:12px;border:1px solid rgba(168,85,247,.3);">`;
    msgs.appendChild(wrap);
    scrollParaFim();
}

function adicionarRespostaIA(texto) {
    const msgs = document.getElementById('msgs');
    if (!msgs) return;

    const container = document.createElement('div');
    container.className = 'iana-response-container nova-mensagem';

    const av = document.createElement('img');
    av.src = '/img/iana-avatar.png';
    av.className = 'iana-avatar-img';
    container.appendChild(av);

    const wrapConteudo = document.createElement('div');
    wrapConteudo.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0;';

    const bubble = document.createElement('div');
    bubble.className = 'iana-message-bubble';
    const html = (typeof marked !== 'undefined') ? marked.parse(texto) : texto.replace(/\n/g, '<br>');
    bubble.innerHTML = sanitizarHTML(html);
    wrapConteudo.appendChild(bubble);

    const acoes = document.createElement('div');
    acoes.className = 'msg-actions';
    acoes.appendChild(criarBotaoCopiar(() => bubble.innerText || bubble.textContent || ''));
    wrapConteudo.appendChild(acoes);

    container.appendChild(wrapConteudo);
    msgs.appendChild(container);
    configurarExpandir(bubble, acoes);
    scrollParaFim();

    if (ttsNextResponse) {
        falar(texto); // dispara IanaHUD 'falando' via onstart, ver falar()
        ttsNextResponse = false;
    }

    // Em chamada de voz, a resposta dela também aparece no feed ao vivo.
    if (emChamadaVoz) adicionarNaFeedVoz('iana', texto);
}

function scrollParaFim() {
    const chatbox = document.getElementById('chatbox');
    if (chatbox) chatbox.scrollTop = chatbox.scrollHeight;
}

function mostrarTypingIndicator() {
    const msgs = document.getElementById('msgs');
    if (!msgs) return;
    const typing = document.createElement('div');
    typing.id = 'typing-indicator';
    typing.className = 'iana-response-container';
    typing.innerHTML = `
        <img src="/img/iana-avatar.png" class="iana-avatar-img">
        <div class="thinking-bubble">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        </div>`;
    msgs.appendChild(typing);
    scrollParaFim();
}

function esconderTypingIndicator() {
    document.getElementById('typing-indicator')?.remove();
}

/* ── ENVIO / RECEBIMENTO DE MENSAGENS ─────────────────────────── */
function usarSugestao(texto) {
    const input = document.getElementById('chat-input');
    if (input) input.value = texto;
    enviarMensagem();
}

async function enviarMensagem() {
    const input = document.getElementById('chat-input');
    if (!input || aguardandoResposta) return;
    const mensagem = input.value.trim();
    if (!mensagem) return;

    input.value = '';
    input.style.height = 'auto';
    await processarEnvioIA(mensagem);
}

async function processarEnvioIA(conteudo) {
    if (typeof conteudo !== 'string' || !conteudo.trim()) return;
    aguardandoResposta = true;

    // INTEGRAÇÃO HUD: entrando em processamento. Na 1ª mensagem, o
    // AnimacaoChat.iniciarPensamento() (chamado abaixo) já seta
    // 'pensando' sozinho — mas setar aqui também não faz mal e cobre
    // o caso de mensagens seguintes, que não passam por lá.
    window.IanaHUD?.setEstado('pensando');

    // FIX (integração real do animation-controller.js): a transição
    // "cheia" (welcome sai de cena, status Pensando/Analisando/
    // Respondendo aparece) só roda na 1ª mensagem da sessão/conversa,
    // enquanto a tela de welcome ainda está visível. Nas mensagens
    // seguintes, usamos o indicador de digitação simples de sempre —
    // repetir a transição cheia a cada mensagem esconderia o histórico
    // do chat toda vez, o que seria ruim.
    const welcomeEl = document.getElementById('welcome');
    const primeiraMensagem = typeof animacaoChat !== 'undefined'
        && welcomeEl && welcomeEl.style.display !== 'none'
        && !animacaoChat.primeiraMensagemFeita;

    if (primeiraMensagem) {
        await animacaoChat.iniciarPensamento();
    } else {
        adicionarBolhaUsuario(conteudo);
        mostrarTypingIndicator();
    }

    const sendBtn = document.getElementById('btn-send');
    const stopBtn = document.getElementById('btn-stop');
    const input = document.getElementById('chat-input');

    if (sendBtn) sendBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'flex';
    if (input) {
        input.disabled = true;
        input.placeholder = 'Iana está pensando...';
    }

    controller = new AbortController();

    // Esconde o indicador certo (transição cheia OU digitando simples) e,
    // se foi a 1ª mensagem, só agora insere a bolha do usuário — welcome
    // já sumiu suavemente pela animação nesse ponto.
    async function esconderIndicador() {
        if (primeiraMensagem) {
            await animacaoChat.finalizarPensamento();
            adicionarBolhaUsuario(conteudo);
        } else {
            esconderTypingIndicator();
        }
    }

    try {
        const res = await fetch('/chat/stream', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mensagem: conteudo,
                idConversa: idConversaAtiva,
                configPrompt: montarConfigPrompt(),
                estadoEmocional: typeof detectarEstadoEmocional === 'function' ? detectarEstadoEmocional(conteudo) : undefined
            }),
            signal: controller.signal
        });

        if (!res.ok) {
            const erroData = await res.json().catch(() => ({}));
            throw new Error(erroData.erro || 'Erro na comunicação com o servidor.');
        }

        const data = await res.json();

        if (data.idConversa && !idConversaAtiva) {
            idConversaAtiva = data.idConversa;
        }

        // Reordena a sidebar: a conversa que acabou de receber mensagem
        // sobe pro topo (fixadas continuam por cima; as outras descem).
        if (usuarioAtual) carregarHistorico();

        await esconderIndicador();
        adicionarRespostaIA(data.resposta);

        // INTEGRAÇÃO HUD: se não vai tocar TTS (ex: chat de texto puro),
        // volta pro repouso agora. Se vai tocar TTS, quem assume o
        // estado 'falando'/'ouvindo' são os eventos onstart/onend dentro
        // de falar() — não sobrescreve aqui pra não brigar com eles.
        if (!ttsNextResponse) {
            window.IanaHUD?.setEstado('ocioso');
        }

    } catch (e) {
        await esconderIndicador();
        if (e.name !== 'AbortError') {
            adicionarRespostaIA('Desculpe, não consegui processar sua solicitação no momento.');
            console.error('Erro no envio:', e);
        }
        window.IanaHUD?.setEstado('ocioso');
    } finally {
        aguardandoResposta = false;
        if (sendBtn) sendBtn.style.display = 'flex';
        if (stopBtn) stopBtn.style.display = 'none';
        if (input) {
            input.disabled = false;
            input.placeholder = 'Peça à Iana...';
            input.focus();
        }
    }
}

function pararRespostaIA() {
    try { controller.abort(); } catch (e) { }
    aguardandoResposta = false;
    esconderTypingIndicator();
    window.IanaHUD?.setEstado('ocioso');

    const sendBtn = document.getElementById('btn-send');
    const stopBtn = document.getElementById('btn-stop');
    const input = document.getElementById('chat-input');

    if (sendBtn) sendBtn.style.display = 'flex';
    if (stopBtn) stopBtn.style.display = 'none';
    if (input) {
        input.disabled = false;
        input.placeholder = 'Peça à Iana...';
    }
}

/* ── CONVERSAS ────────────────────────────────────────────────── */
async function ativarConversa(id, titulo) {
    idConversaAtiva = id;
    carregarHistorico();

    const msgs = document.getElementById('msgs');
    if (!msgs) return;
    msgs.innerHTML = '';
    mostrarWelcome(false);

    try {
        const res = await fetch(`/chat/historico/${id}`, { credentials: 'include' });
        if (!res.ok) {
            msgs.innerHTML = '<p class="sidebar-hint">Não consegui carregar esta conversa.</p>';
            return;
        }

        const { mensagens } = await res.json();
        if (!mensagens?.length) {
            msgs.innerHTML = '<p class="sidebar-hint">Esta conversa ainda não tem mensagens.</p>';
        } else {
            mensagens.forEach(m => {
                if (m.tipo_sender === 'usuario') adicionarBolhaUsuario(m.conteudo);
                else adicionarRespostaIA(m.conteudo);
            });
        }
        scrollParaFim();
    } catch (e) {
        console.error('Erro ao carregar histórico:', e);
    }
}

function resetarChat() {
    idConversaAtiva = null;
    const msgs = document.getElementById('msgs');
    if (msgs) msgs.innerHTML = '';
    mostrarWelcome(true);
    // Novo chat = welcome volta a aparecer; permite a transição
    // welcome->pensando tocar de novo na próxima mensagem.
    if (typeof animacaoChat !== 'undefined') animacaoChat.primeiraMensagemFeita = false;
    window.IanaHUD?.setEstado('ocioso');
    if (usuarioAtual) carregarHistorico();
}

/* ── FEEDBACK ─────────────────────────────────────────────────── */
async function enviarFeedback() {
    const assunto = document.getElementById('fb-assunto')?.value.trim();
    const texto = document.getElementById('fb-texto')?.value.trim();
    const autoriza = document.getElementById('fb-autoriza')?.checked;
    const btn = document.getElementById('btn-fb-enviar');

    if (!assunto) { alert('Preencha o assunto.'); return; }
    if (!texto) { alert('Descreva seu feedback.'); return; }
    if (!autoriza) { alert('Marque a autorização de uso.'); return; }

    const orig = btn.textContent;
    btn.textContent = 'Enviando...';
    btn.disabled = true;

    try {
        // FIX: antes ia direto pro formsubmit.co com um e-mail placeholder
        // nunca preenchido (SEU_EMAIL_AQUI) — nenhum feedback era enviado.
        // Agora passa pelo backend (/feedback), que usa o SendGrid já
        // configurado no server.js.
        const res = await fetch('/feedback', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assunto, texto, autorizou: autoriza })
        });

        if (res.ok) {
            alert('✅ Feedback enviado! Obrigado.');
            fecharAuth();
            document.getElementById('fb-assunto').value = '';
            document.getElementById('fb-texto').value = '';
            document.getElementById('fb-autoriza').checked = false;
        } else {
            alert('Erro ao enviar feedback.');
        }
    } catch (e) {
        alert('Erro de conexão.');
    } finally {
        btn.textContent = orig;
        btn.disabled = false;
    }
}

/* ── INICIALIZAÇÃO ────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    verificarSessao();
    iniciarMenuUpload();
    iniciarUpload();
    iniciarGravacaoAudio();

    // O orbe estilo Jarvis agora só existe na tela de chamada de voz
    // (ver abrirVoz() em vez daqui) — fica separado do chat de texto.

    // Sidebar
    document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
        document.getElementById('sidebar')?.classList.toggle('collapsed');
    });
    document.getElementById('btn-novo-chat')?.addEventListener('click', resetarChat);
    document.getElementById('btn-buscar')?.addEventListener('click', () => mostrarTela('tela-pesquisa'));

    // Menu do usuário (footer da sidebar)
    const btnMenu = document.getElementById('btn-user-menu');
    const dropdown = document.getElementById('user-dropdown');

    btnMenu?.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown?.classList.toggle('aberto');
    });

    document.addEventListener('click', () => {
        dropdown?.classList.remove('aberto');
        fecharChatOptionsMenu();
    });

    document.getElementById('dd-config')?.addEventListener('click', () => { window.location.href = '/configuracoes'; });
    document.getElementById('dd-feedback')?.addEventListener('click', () => { dropdown?.classList.remove('aberto'); mostrarTela('tela-feedback'); });
    document.getElementById('dd-logout')?.addEventListener('click', realizarLogout);

    // Botões de entrar/registrar (topbar)
    document.getElementById('btn-entrar')?.addEventListener('click', () => mostrarTela('tela-login'));
    document.getElementById('btn-registrar')?.addEventListener('click', () => mostrarTela('tela-cadastro'));

    // Overlay de auth: clicar fora fecha
    document.getElementById('overlay-auth')?.addEventListener('click', (e) => {
        if (e.target.id === 'overlay-auth') fecharAuth();
    });

    // Formulários de auth
    document.getElementById('btn-login')?.addEventListener('click', realizarLogin);
    document.getElementById('btn-cadastrar')?.addEventListener('click', realizarCadastro);
    document.getElementById('btn-enviar-cod')?.addEventListener('click', enviarCodigoRecuperacao);
    document.getElementById('btn-mudar-senha')?.addEventListener('click', alterarSenha);
    document.getElementById('btn-salvar-rename')?.addEventListener('click', salvarRenomear);
    document.getElementById('btn-confirmar-excluir')?.addEventListener('click', confirmarExcluir);
    document.getElementById('btn-fb-enviar')?.addEventListener('click', enviarFeedback);

    document.getElementById('login-senha')?.addEventListener('keydown', e => { if (e.key === 'Enter') realizarLogin(); });
    document.getElementById('cad-senha')?.addEventListener('keydown', e => { if (e.key === 'Enter') realizarCadastro(); });
    document.getElementById('pesquisa-input')?.addEventListener('input', e => pesquisarConversas(e.target.value));

    // Chamada de voz e câmera
    document.getElementById('btn-voz-call')?.addEventListener('click', abrirVoz);
    document.getElementById('btn-voz-encerrar')?.addEventListener('click', fecharVoz);
    document.getElementById('btn-voz-mute')?.addEventListener('click', toggleMuteVoz);
    document.getElementById('btn-capturar-foto')?.addEventListener('click', capturarFoto);

    // Envio de mensagem
    document.getElementById('btn-send')?.addEventListener('click', enviarMensagem);
    document.getElementById('btn-stop')?.addEventListener('click', pararRespostaIA);

    const textarea = document.getElementById('chat-input');
    textarea?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            enviarMensagem();
        }
    });

    textarea?.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = this.scrollHeight + 'px';
    });
});

/* Expor globalmente para os onclick inline do HTML */
window.mostrarTela = mostrarTela;
window.fecharAuth = fecharAuth;
window.fecharCamera = fecharCamera;
window.usarSugestao = usarSugestao;