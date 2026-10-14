/* ================================================================
   IANA — public/js/chat.js (FICHEIRO COMPLETO E DEFINITIVO)
   Contém: Estado Global + Auth + Chat Streaming (SSE) + Histórico +
   Upload + Câmera + Voice Mode + Sidebar + Eventos de Todos os Botões
================================================================ */

'use strict';

/* ================================================================
   1. ESTADO GLOBAL E CONFIGURAÇÃO
================================================================ */
let aguardandoResposta = false;
let idConversaAtiva = null;
let controller = null;

let emailRecuperacao = '';
let idConversaRenomear = null;
let idConversaExcluir = null;
let usuarioAtual = null;

let ttsEnabled = true;
let ttsNextResponse = false;
let ttsVoice = null;

let vozSocket = null;
let vozSocketConectando = false;

let audioCtxEleven = null;
let audioNextPlaybackTime = 0;
let audioSourcesEleven = new Set();
let audioPcmResto = new Uint8Array(0);

let vozProcessando = false;
let vozFalando = false;
let vozInicializando = false;
let vozSpeechRetryCount = 0;
let vozSpeechRetryTimer = null;

let emChamadaVoz = false;
let visaoChamadaAtiva = false;
let visaoChamadaToken = '';
let visaoChamadaStream = null;
let visaoChamadaVideo = null;
let visaoChamadaCanvas = null;
let visaoChamadaOverlay = null;

let mediaRecorderAudio = null;
let audioChunks = [];
let gravandoAudio = false;

let streamCamera = null;

let audioCtxVoz = null;
let analyserVoz = null;
let streamAudioVozBars = null;
let rafVozId = null;

let chatInicializado = false;
let uploadInicializado = false;
let menuUploadInicializado = false;
let gravacaoInicializada = false;

const CONFIG_KEY = 'iana_config';
const URL_VISAO_LOCAL = 'http://127.0.0.1:3334';

const TELAS = [
    'tela-login',
    'tela-cadastro',
    'tela-esqueci',
    'tela-codigo',
    'tela-pesquisa',
    'tela-feedback',
    'tela-renomear',
    'tela-confirmar'
];

/* ================================================================
   2. UTILITÁRIOS DOM E FORMATAÇÃO
================================================================ */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function escaparHTML(texto) {
    const div = document.createElement('div');
    div.textContent = String(texto ?? '');
    return div.innerHTML;
}

function sanitizarHTML(html) {
    if (typeof DOMPurify !== 'undefined') {
        return DOMPurify.sanitize(html);
    }
    return escaparHTML(html);
}

function possuiMediaDevices() {
    return Boolean(
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function'
    );
}

function arquivoParaDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
        reader.readAsDataURL(file);
    });
}

function obterElemento(id) {
    return document.getElementById(id);
}

function definirTexto(id, texto) {
    const el = obterElemento(id);
    if (el) el.textContent = String(texto ?? '');
}

function mostrarElemento(id, display = 'block') {
    const el = obterElemento(id);
    if (el) el.style.display = display;
}

function esconderElemento(id) {
    const el = obterElemento(id);
    if (el) el.style.display = 'none';
}

function obterConfigSalva() {
    try {
        return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
    } catch {
        return {};
    }
}

/* ================================================================
   3. TTS NATIVO DO NAVEGADOR E ÁUDIO PCM (ELEVENLABS)
================================================================ */
function getVoicesTTS() {
    if (typeof speechSynthesis === 'undefined') return [];
    return speechSynthesis.getVoices();
}

function escolherVozTTS() {
    if (ttsVoice) return ttsVoice;
    const voices = getVoicesTTS();
    if (!voices.length) return null;

    const preferida = voices.find(voice =>
        /pt-BR|pt/i.test(voice.lang) &&
        /female|maria|luciana|fernanda|francisca|thalita/i.test(voice.name)
    );

    ttsVoice = preferida || voices.find(voice => /pt-BR|pt/i.test(voice.lang)) || voices[0];
    return ttsVoice;
}

function falar(texto) {
    if (emChamadaVoz) return Promise.resolve();
    return new Promise(resolve => {
        try {
            if (!ttsEnabled || typeof speechSynthesis === 'undefined' || !texto) {
                resolve();
                return;
            }
            const utterance = new SpeechSynthesisUtterance(String(texto).replace(/\n/g, ' '));
            utterance.lang = 'pt-BR';
            const voz = escolherVozTTS();
            if (voz) utterance.voice = voz;
            utterance.rate = 1.02;
            utterance.pitch = 1.05;
            utterance.onend = resolve;
            utterance.onerror = resolve;

            speechSynthesis.cancel();
            speechSynthesis.speak(utterance);
        } catch {
            resolve();
        }
    });
}

function pararAudioEleven() {
    for (const source of audioSourcesEleven) {
        try { source.stop(); } catch {}
    }
    audioSourcesEleven.clear();
    audioPcmResto = new Uint8Array(0);
    audioNextPlaybackTime = 0;
    vozFalando = false;
}

function obterAudioContextEleven() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioCtxEleven) {
        audioCtxEleven = new AudioContextClass({ sampleRate: 24000 });
    }
    return audioCtxEleven;
}

async function garantirAudioElevenAtivo() {
    const ctx = obterAudioContextEleven();
    if (!ctx) return null;
    if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch {}
    }
    return ctx;
}

function tocarAudioEleven(base64) {
    if (!emChamadaVoz || !base64) return;
    const ctx = obterAudioContextEleven();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    let binario;
    try {
        binario = atob(base64);
    } catch {
        return;
    }

    let bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) {
        bytes[i] = binario.charCodeAt(i);
    }

    if (audioPcmResto.length) {
        const combinado = new Uint8Array(audioPcmResto.length + bytes.length);
        combinado.set(audioPcmResto, 0);
        combinado.set(bytes, audioPcmResto.length);
        bytes = combinado;
        audioPcmResto = new Uint8Array(0);
    }

    if (bytes.length % 2 !== 0) {
        audioPcmResto = bytes.slice(bytes.length - 1);
        bytes = bytes.slice(0, -1);
    }

    if (!bytes.length) return;

    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const buffer = ctx.createBuffer(1, samples.length, 24000);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < samples.length; i++) {
        data[i] = samples[i] / 32768;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const agora = ctx.currentTime;
    const quando = Math.max(agora + 0.02, audioNextPlaybackTime);
    audioNextPlaybackTime = quando + buffer.duration;

    audioSourcesEleven.add(source);
    source.onended = () => audioSourcesEleven.delete(source);
    source.start(quando);

    vozFalando = true;
    atualizarEstadoVoz('falando', 'Iana está falando...');
}

/* ================================================================
   4. SOCKET DE VOZ E RECONHECIMENTO DE FALA
================================================================ */
function garantirSocketVoz() {
    if (vozSocket?.connected) return vozSocket;
    if (typeof io !== 'function') {
        atualizarEstadoVoz('processando', 'Socket de voz indisponível.');
        return null;
    }
    if (vozSocketConectando) return vozSocket;
    vozSocketConectando = true;

    try {
        vozSocket = io({
            transports: ['websocket', 'polling'],
            withCredentials: true
        });
    } catch (erro) {
        vozSocketConectando = false;
        console.error('[IANA VOZ] Socket:', erro);
        return null;
    }

    const socketVozAtual = vozSocket;
    vozSocket.on('connect', async () => {
        vozSocketConectando = false;
        await garantirAudioElevenAtivo();
        if (vozSocket !== socketVozAtual || !emChamadaVoz || !socketVozAtual.connected) return;

        try {
            vozSocket.emit('voz:iniciar', {
                idConversa: idConversaAtiva,
                nomeUsuario: usuarioAtual?.nome || 'Jogador',
                configUsuario: obterConfigSalva()
            });
        } catch (erro) {
            console.error('[IANA VOZ] voz:iniciar:', erro);
        }
    });

    vozSocket.on('voz:pronto', () => {
        if (emChamadaVoz && !vozFalando && !vozProcessando && !window._vozMutado) {
            atualizarEstadoVoz('ouvindo', 'Fale com a Iana');
            if (!window._recognitionVoz) iniciarReconhecimentoVoz();
        }
    });

    vozSocket.on('voz:transcricao-iana', dados => {
        const texto = dados?.texto;
        if (typeof texto !== 'string') return;
        const el = obterElemento('voz-transcript');
        if (el) el.textContent = texto;

        adicionarMensagemDOM('ia', texto);
        if (dados.conversa_id) idConversaAtiva = dados.conversa_id;
        if (usuarioAtual) carregarHistorico();
    });

    vozSocket.on('voz:usar-tts-local', dados => {
        const texto = String(dados?.texto || '');
        if (!texto || !emChamadaVoz || typeof speechSynthesis === 'undefined') {
            vozSocket?.emit('voz:tts-local-finalizado');
            return;
        }
        speechSynthesis.cancel();
        const fala = new SpeechSynthesisUtterance(texto);
        fala.lang = 'pt-BR';
        fala.voice = escolherVozTTS() || null;
        fala.onstart = () => {
            vozFalando = true;
            atualizarEstadoVoz('falando', 'Iana está falando...');
        };
        fala.onend = fala.onerror = () => {
            vozFalando = false;
            if (emChamadaVoz) vozSocket?.emit('voz:tts-local-finalizado');
        };
        speechSynthesis.speak(fala);
    });

    vozSocket.on('voz:audio-resposta', dados => tocarAudioEleven(dados?.audio));
    vozSocket.on('voz:fala-finalizada', () => verificarFimAudioVoz());

    vozSocket.on('voz:interrompido', () => {
        pararAudioEleven();
        vozFalando = false;
        vozProcessando = false;
        if (emChamadaVoz && !window._vozMutado) {
            atualizarEstadoVoz('ouvindo', 'Fale com a Iana');
            iniciarReconhecimentoVoz();
        }
    });

    vozSocket.on('voz:erro', dados => {
        pararAudioEleven();
        vozFalando = false;
        vozProcessando = false;
        if (emChamadaVoz) {
            atualizarEstadoVoz('processando', dados?.mensagem || 'Erro no sistema de voz.');
        }
    });

    vozSocket.on('disconnect', motivo => {
        if (vozSocket !== socketVozAtual) return;
        if (motivo === 'io server disconnect') {
            fecharVoz();
            return;
        }
        vozSocketConectando = false;
        if (emChamadaVoz) {
            pararReconhecimentoVoz();
            atualizarEstadoVoz('processando', 'Reconectando a Iana...');
        }
    });

    vozSocket.on('connect_error', () => {
        vozSocketConectando = false;
        if (emChamadaVoz) {
            atualizarEstadoVoz('processando', 'Não foi possível conectar à voz.');
        }
    });

    return vozSocket;
}

function verificarFimAudioVoz() {
    const verificar = () => {
        if (!emChamadaVoz || window._vozMutado) return;
        if (audioSourcesEleven.size === 0) {
            vozFalando = false;
            vozProcessando = false;
            atualizarEstadoVoz('ouvindo', 'Fale com a Iana');
            if (!window._recognitionVoz) iniciarReconhecimentoVoz();
            return;
        }
        setTimeout(verificar, 100);
    };
    setTimeout(verificar, 100);
}

function mostrarTela(id) {
    const overlay = obterElemento('overlay-auth');
    if (!overlay) return;
    TELAS.forEach(tela => {
        const elemento = obterElemento(tela);
        if (elemento) {
            elemento.style.display = tela === id ? 'block' : 'none';
        }
    });
    overlay.style.display = 'flex';
}

function fecharAuth() {
    const overlay = obterElemento('overlay-auth');
    if (overlay) overlay.style.display = 'none';
}

/* ================================================================
   5. CÂMERA E VOICE MODE
================================================================ */
async function abrirCamera() {
    const overlay = obterElemento('overlay-camera');
    const preview = obterElemento('camera-preview');
    if (!overlay || !preview) return;
    if (!possuiMediaDevices()) {
        alert('Seu navegador não suporta acesso à câmera.');
        return;
    }
    try {
        if (streamCamera) {
            streamCamera.getTracks().forEach(track => track.stop());
        }
        streamCamera = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user' },
            audio: false
        });
        preview.srcObject = streamCamera;
        try { await preview.play(); } catch {}
        overlay.style.display = 'flex';
    } catch (erro) {
        alert('Não foi possível acessar a câmera: ' + (erro.message || 'permissão negada.'));
    }
}

function fecharCamera() {
    const overlay = obterElemento('overlay-camera');
    const preview = obterElemento('camera-preview');
    if (streamCamera) {
        streamCamera.getTracks().forEach(track => track.stop());
        streamCamera = null;
    }
    if (preview) preview.srcObject = null;
    if (overlay) overlay.style.display = 'none';
}

async function capturarFoto() {
    const preview = obterElemento('camera-preview');
    if (!preview || !preview.videoWidth || !preview.videoHeight) {
        alert('A câmera ainda não está pronta.');
        return;
    }
    try {
        const canvas = document.createElement('canvas');
        canvas.width = preview.videoWidth;
        canvas.height = preview.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(preview, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.90);
        fecharCamera();

        await processarEnvioIA(
            'Dá uma olhada nesta foto e me responde naturalmente sobre o que você vê.',
            { imagem: dataUrl },
            { tipo: 'imagem', dataUrl, nome: 'foto-camera.jpg' }
        );
    } catch {
        alert('Não foi possível capturar a foto.');
    }
}

function atualizarEstadoVoz(estado, texto) {
    const overlay = obterElemento('overlay-voz');
    const status = obterElemento('voz-status');
    if (!overlay) return;

    overlay.classList.remove('iana-voz-ouvindo', 'iana-voz-processando', 'iana-voz-falando');
    if (estado === 'ouvindo') overlay.classList.add('iana-voz-ouvindo');
    if (estado === 'processando') overlay.classList.add('iana-voz-processando');
    if (estado === 'falando') overlay.classList.add('iana-voz-falando');

    if (status && texto) status.textContent = texto;
    if (window.IanaHUD?.setEstado) {
        try { window.IanaHUD.setEstado(estado); } catch {}
    }
}

async function abrirVoz() {
    const overlay = obterElemento('overlay-voz');
    if (!overlay) return;

    overlay.style.display = 'flex';
    emChamadaVoz = true;
    vozProcessando = false;
    vozFalando = false;
    vozInicializando = false;
    vozSpeechRetryCount = 0;
    window._vozMutado = false;

    limparFeedVoz();
    atualizarEstadoVoz('ouvindo', 'Fale com a Iana');

    try { await garantirAudioElevenAtivo(); } catch {}
    iniciarVisualizacaoAudio();

    const socket = garantirSocketVoz();
    if (!socket) {
        atualizarEstadoVoz('processando', 'Não foi possível iniciar a voz.');
        return;
    }

    if (socket.connected) {
        socket.emit('voz:iniciar', {
            idConversa: idConversaAtiva,
            nomeUsuario: usuarioAtual?.nome || 'Jogador',
            configUsuario: obterConfigSalva()
        });
        iniciarReconhecimentoVoz();
    }
}

function fecharVoz() {
    const overlay = obterElemento('overlay-voz');
    emChamadaVoz = false;
    pararVisaoChamada();
    vozProcessando = false;
    vozFalando = false;
    vozInicializando = false;
    ttsNextResponse = false;
    window._vozMutado = false;

    pararReconhecimentoVoz();

    if (overlay) {
        overlay.style.display = 'none';
        overlay.classList.remove('iana-voz-ouvindo', 'iana-voz-processando', 'iana-voz-falando');
    }

    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();

    if (vozSocket) {
        try { vozSocket.emit('voz:encerrar'); } catch {}
        try {
            vozSocket.removeAllListeners();
            vozSocket.disconnect();
        } catch {}
        vozSocket = null;
    }
    vozSocketConectando = false;

    pararAudioEleven();
    if (audioCtxEleven) {
        audioCtxEleven.close().catch(() => {});
        audioCtxEleven = null;
    }

    pararVisualizacaoAudio();
    limparFeedVoz();

    const mute = obterElemento('btn-voz-mute');
    if (mute) {
        mute.classList.remove('mutado');
        mute.setAttribute('aria-pressed', 'false');
        mute.setAttribute('aria-label', 'Mutar microfone');
        mute.title = 'Mutar microfone';
    }

    if (window.IanaHUD?.setEstado) {
        try { window.IanaHUD.setEstado('ocioso'); } catch {}
    }
}

function limparFeedVoz() {
    definirTexto('voz-transcript', '');
    definirTexto('voz-interim', '');
}

async function iniciarVisualizacaoAudio() {
    if (!possuiMediaDevices()) return;
    try {
        pararVisualizacaoAudio();
        streamAudioVozBars = await navigator.mediaDevices.getUserMedia({ audio: true });
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;

        audioCtxVoz = new AudioContextClass();
        const source = audioCtxVoz.createMediaStreamSource(streamAudioVozBars);
        analyserVoz = audioCtxVoz.createAnalyser();
        analyserVoz.fftSize = 32;
        source.connect(analyserVoz);

        if (audioCtxVoz.state === 'suspended') await audioCtxVoz.resume();
        loopVisualizacaoAudio();
    } catch {}
}

function loopVisualizacaoAudio() {
    if (!analyserVoz) return;
    const dados = new Uint8Array(analyserVoz.frequencyBinCount);
    analyserVoz.getByteFrequencyData(dados);
    const media = dados.length ? dados.reduce((total, v) => total + v, 0) / dados.length : 0;
    const nivel = Math.min(1, media / 90);

    document.querySelectorAll('.jarvis-bars').forEach(bars => {
        bars.style.setProperty('--nivel', nivel.toFixed(2));
    });
    rafVozId = requestAnimationFrame(loopVisualizacaoAudio);
}

function pararVisualizacaoAudio() {
    if (rafVozId) cancelAnimationFrame(rafVozId);
    rafVozId = null;
    if (streamAudioVozBars) {
        streamAudioVozBars.getTracks().forEach(t => t.stop());
        streamAudioVozBars = null;
    }
    if (audioCtxVoz) {
        audioCtxVoz.close().catch(() => {});
        audioCtxVoz = null;
    }
    analyserVoz = null;
}

function pararReconhecimentoVoz() {
    clearTimeout(vozSpeechRetryTimer);
    vozSpeechRetryTimer = null;
    const rec = window._recognitionVoz;
    window._recognitionVoz = null;
    vozInicializando = false;
    if (rec) {
        try {
            rec.onstart = null;
            rec.onend = null;
            rec.onerror = null;
            rec.onresult = null;
            rec.stop();
        } catch {}
    }
}

function iniciarReconhecimentoVoz() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!emChamadaVoz || window._vozMutado || vozFalando || vozProcessando) return;
    if (!SpeechRecognition) {
        atualizarEstadoVoz('processando', 'Reconhecimento de voz não suportado neste navegador.');
        return;
    }
    if (window._recognitionVoz || vozInicializando) return;

    vozInicializando = true;
    const transcriptEl = obterElemento('voz-transcript');
    const interimEl = obterElemento('voz-interim');

    const rec = new SpeechRecognition();
    rec.lang = 'pt-BR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    window._recognitionVoz = rec;

    rec.onstart = () => {
        vozInicializando = false;
        if (emChamadaVoz && !vozFalando && !vozProcessando) {
            atualizarEstadoVoz('ouvindo', 'Fale sua pergunta');
        }
    };

    rec.onresult = event => {
        let textoFinal = '';
        let textoInterim = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
            const resultado = event.results[i];
            const texto = resultado[0]?.transcript || '';
            if (resultado.isFinal) textoFinal += texto;
            else textoInterim += texto;
        }

        if (transcriptEl) transcriptEl.textContent = textoInterim || textoFinal;
        if (interimEl) interimEl.textContent = textoInterim;

        if (!textoFinal.trim() || vozProcessando || vozFalando) return;

        const texto = textoFinal.trim();
        vozSpeechRetryCount = 0;

        removerWelcome();
        adicionarMensagemDOM('usuario', texto);
        vozProcessando = true;
        if (interimEl) interimEl.textContent = '';

        atualizarEstadoVoz('processando', 'Iana está pensando...');
        pararReconhecimentoVoz();

        const socket = garantirSocketVoz();
        if (!socket) {
            vozProcessando = false;
            atualizarEstadoVoz('processando', 'Socket de voz indisponível.');
            return;
        }

        const enviar = () => {
            if (emChamadaVoz && !window._vozMutado && socket.connected) {
                socket.emit('voz:texto', texto);
            }
        };

        if (socket.connected) enviar();
        else socket.once('connect', enviar);
    };

    rec.onerror = event => {
        vozInicializando = false;
        if (!emChamadaVoz) return;
        window._recognitionVoz = null;
        if (event.error === 'no-speech') return;
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            atualizarEstadoVoz('processando', 'Permissão de microfone negada.');
            return;
        }
        if (event.error === 'network') vozSpeechRetryCount += 1;
    };

    rec.onend = () => {
        vozInicializando = false;
        if (window._recognitionVoz === rec) window._recognitionVoz = null;
        if (emChamadaVoz && !window._vozMutado && !vozFalando && !vozProcessando) {
            if (vozSpeechRetryCount >= 4) return;
            const retryDelay = vozSpeechRetryCount
                ? Math.min(750 * (2 ** (vozSpeechRetryCount - 1)), 6000)
                : 300;
            vozSpeechRetryTimer = setTimeout(() => {
                vozSpeechRetryTimer = null;
                if (emChamadaVoz && !window._vozMutado && !vozFalando && !vozProcessando && !window._recognitionVoz) {
                    iniciarReconhecimentoVoz();
                }
            }, retryDelay);
        }
    };

    try {
        rec.start();
    } catch {
        vozInicializando = false;
        window._recognitionVoz = null;
    }
}

function toggleMuteVoz() {
    const btn = obterElemento('btn-voz-mute');
    const atualmenteMutado = Boolean(window._vozMutado);

    if (!atualmenteMutado) {
        pararReconhecimentoVoz();
        window._vozMutado = true;
        btn?.classList.add('mutado');
        if (btn) {
            btn.setAttribute('aria-pressed', 'true');
            btn.setAttribute('aria-label', 'Ativar microfone');
            btn.title = 'Ativar microfone';
        }
        atualizarEstadoVoz('processando', 'Microfone desativado');
        return;
    }

    window._vozMutado = false;
    btn?.classList.remove('mutado');
    if (btn) {
        btn.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-label', 'Mutar microfone');
        btn.title = 'Mutar microfone';
    }
    if (emChamadaVoz && !vozFalando && !vozProcessando) {
        atualizarEstadoVoz('ouvindo', 'Fale com a Iana');
        iniciarReconhecimentoVoz();
    }
}

/* ================================================================
   6. UPLOAD, COMPARTILHAMENTO DE TELA E GRAVAÇÃO DE ÁUDIO
================================================================ */
function iniciarMenuUpload() {
    if (menuUploadInicializado) return;
    const btnMais = obterElemento('btn-mais');
    const menu = obterElemento('upload-menu');
    const fileInput = obterElemento('file-input');

    if (!btnMais || !menu) return;
    menuUploadInicializado = true;

    btnMais.addEventListener('click', event => {
        event.stopPropagation();
        const rect = btnMais.getBoundingClientRect();
        const aberto = menu.style.display === 'flex';

        if (!aberto) {
            menu.style.display = 'flex';
            const altura = menu.offsetHeight || 200;
            let left = rect.left;
            let top = rect.top - altura - 8;

            if (left + menu.offsetWidth > window.innerWidth - 8) {
                left = window.innerWidth - menu.offsetWidth - 8;
            }
            if (top < 8) top = rect.bottom + 8;

            menu.style.left = `${Math.max(8, left)}px`;
            menu.style.top = `${Math.max(8, top)}px`;
        } else {
            menu.style.display = 'none';
        }
    });

    document.addEventListener('click', () => { menu.style.display = 'none'; });
    menu.addEventListener('click', event => event.stopPropagation());

    obterElemento('up-foto')?.addEventListener('click', () => {
        menu.style.display = 'none';
        abrirCamera();
    });
    obterElemento('up-imagem')?.addEventListener('click', () => {
        menu.style.display = 'none';
        if (fileInput) { fileInput.accept = 'image/*'; fileInput.click(); }
    });
    obterElemento('up-video')?.addEventListener('click', () => {
        menu.style.display = 'none';
        if (fileInput) { fileInput.accept = 'video/mp4,video/webm,video/quicktime'; fileInput.click(); }
    });
    obterElemento('up-arquivo')?.addEventListener('click', () => {
        menu.style.display = 'none';
        if (fileInput) { fileInput.accept = '.pdf,.txt'; fileInput.click(); }
    });
    obterElemento('up-audio')?.addEventListener('click', () => {
        menu.style.display = 'none';
        if (fileInput) { fileInput.accept = 'audio/*'; fileInput.click(); }
    });
    obterElemento('up-tela')?.addEventListener('click', () => {
        menu.style.display = 'none';
        compartilharTela();
    });
}

function iniciarUpload() {
    if (uploadInicializado) return;
    const fileInput = obterElemento('file-input');
    if (!fileInput) return;
    uploadInicializado = true;

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;

        try {
            if (file.size > 10 * 1024 * 1024) throw new Error('Limite de 10 MB por arquivo.');

            if (file.type.startsWith('image/')) {
                const dataUrl = await arquivoParaDataURL(file);
                await processarEnvioIA(
                    'Dá uma olhada nesta imagem e me responde naturalmente sobre o que você vê.',
                    { imagem: dataUrl },
                    { tipo: 'imagem', dataUrl, nome: file.name }
                );
                return;
            }

            if (file.type.startsWith('video/') && ['video/mp4', 'video/webm', 'video/quicktime'].includes(file.type)) {
                const dataUrl = await arquivoParaDataURL(file);
                await processarEnvioIA(
                    'Assista a este vídeo e me responda naturalmente sobre o que acontece nele.',
                    { video: dataUrl },
                    { tipo: 'video', dataUrl, nome: file.name }
                );
                return;
            }

            if (file.type.startsWith('audio/')) {
                const dataUrl = await arquivoParaDataURL(file);
                await processarEnvioIA(
                    'Ouça este áudio e me responda naturalmente com base no que foi dito.',
                    { audio: dataUrl },
                    { tipo: 'audio', dataUrl, nome: file.name }
                );
                return;
            }

            if (file.type === 'text/plain' || file.name.toLowerCase().endsWith('.txt')) {
                const texto = await file.text();
                const limitado = texto.slice(0, 7500);
                await processarEnvioIA(
                    `Leia o arquivo "${file.name}" e responda naturalmente com base no conteúdo abaixo:\n\n${limitado}`
                );
                return;
            }

            if (file.type !== 'application/pdf') {
                throw new Error('Use imagem PNG/JPEG/WebP, vídeo MP4/WebM/MOV, áudio, PDF ou TXT.');
            }
            const dataUrl = await arquivoParaDataURL(file);
            await processarEnvioIA(
                `Leia o PDF "${file.name}" e responda naturalmente com base no conteúdo dele.`,
                { arquivo: dataUrl },
                { tipo: 'arquivo', dataUrl, nome: file.name }
            );
        } catch (erro) {
            alert(erro.message || 'Não foi possível processar o arquivo.');
        } finally {
            fileInput.value = '';
        }
    });
}

async function compartilharTela() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
        alert('Seu navegador não suporta compartilhamento de tela.');
        return;
    }
    let stream = null;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        await video.play();

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        video.srcObject = null;

        await processarEnvioIA(
            'Descreva esta captura de tela e ajude com o que aparece nela.',
            { imagem: dataUrl },
            { tipo: 'imagem', dataUrl, nome: 'captura-tela.jpg' }
        );
    } catch (erro) {
        if (erro?.name !== 'NotAllowedError') {
            alert('Erro ao compartilhar tela: ' + (erro.message || ''));
        }
    } finally {
        if (stream) stream.getTracks().forEach(t => t.stop());
    }
}

function iniciarGravacaoAudio() {
    if (gravacaoInicializada) return;
    const btn = obterElemento('btn-mic');
    if (!btn) return;
    gravacaoInicializada = true;

    btn.addEventListener('click', async () => {
        if (!gravandoAudio) {
            try {
                if (!possuiMediaDevices()) throw new Error('Seu navegador não suporta microfone.');
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                    ? 'audio/webm;codecs=opus'
                    : 'audio/webm';

                mediaRecorderAudio = new MediaRecorder(stream, { mimeType });
                audioChunks = [];

                mediaRecorderAudio.ondataavailable = e => {
                    if (e.data && e.data.size > 0) audioChunks.push(e.data);
                };

                mediaRecorderAudio.onstop = async () => {
                    stream.getTracks().forEach(t => t.stop());
                    const blob = new Blob(audioChunks, { type: mimeType });
                    audioChunks = [];
                    try {
                        const dataUrl = await arquivoParaDataURL(blob);
                        await processarEnvioIA(
                            'Ouça este áudio que gravei e me responda naturalmente.',
                            { audio: dataUrl },
                            { tipo: 'audio', dataUrl, nome: 'gravacao.webm' }
                        );
                    } catch (erro) {
                        console.error('[IANA ÁUDIO]', erro);
                    }
                };

                mediaRecorderAudio.start();
                gravandoAudio = true;
                btn.classList.add('gravando');
                btn.title = 'Parar gravação';
            } catch (erro) {
                alert('Não foi possível acessar o microfone: ' + (erro.message || ''));
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

/* ================================================================
   7. AUTENTICAÇÃO E GESTÃO DE CONTA
================================================================ */
async function verificarSessao() {
    try {
        const res = await fetch('/auth/me', { credentials: 'include' });
        if (!res.ok) {
            atualizarUIVisitante();
            return;
        }
        const data = await res.json();
        if (data.logado) atualizarUILogado(data.usuario);
        else atualizarUIVisitante();
    } catch {
        atualizarUIVisitante();
    }
}

function atualizarUIVisitante() {
    usuarioAtual = null;
    document.body.classList.add('visitante');
    document.body.classList.remove('logado');

    mostrarElemento('auth-buttons', 'flex');
    esconderElemento('sidebar-footer');
    definirTexto('historico-hint', 'Faça login para salvar conversas.');

    const lista = obterElemento('historico-lista');
    if (lista) {
        lista.innerHTML = '<p class="sidebar-hint">Faça login para salvar conversas.</p>';
    }
}

function atualizarUILogado(usuario) {
    usuarioAtual = usuario;
    document.body.classList.add('logado');
    document.body.classList.remove('visitante');

    esconderElemento('auth-buttons');
    mostrarElemento('sidebar-footer', 'block');
    definirTexto('user-nome-sidebar', usuario?.nome || 'Usuário');

    const topAvatar = obterElemento('topbar-profile-avatar');
    if (topAvatar && usuario?.avatar) topAvatar.src = usuario.avatar;

    carregarHistorico();
}

function mensagemErroAuth(msg, fallback = 'Erro inesperado.') {
    const texto = String(msg || '').toLowerCase();
    if (texto.includes('já cadastrado')) return 'Este e-mail já está cadastrado.';
    if (texto.includes('inválidas') || texto.includes('incorretos') || texto.includes('invalid')) {
        return 'E-mail ou senha inválidos.';
    }
    if (texto.includes('mínimo') || texto.includes('minimo')) {
        return 'Senha muito curta (mínimo 8 caracteres).';
    }
    return msg || fallback;
}

function mostrarErroTela(id, msg) {
    const el = obterElemento(id);
    if (el) el.textContent = String(msg || '');
}

async function realizarLogin() {
    const email = obterElemento('login-email')?.value.trim();
    const senha = obterElemento('login-senha')?.value;

    if (!email || !senha) {
        mostrarErroTela('login-erro', 'Preencha e-mail e senha.');
        return;
    }

    const btn = obterElemento('btn-login');
    const original = btn?.textContent || 'Entrar';
    if (btn) { btn.textContent = 'Entrando...'; btn.disabled = true; }

    fecharVoz();
    pararRespostaIA();

    try {
        const res = await fetch('/auth/login', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, senha })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            mostrarErroTela('login-erro', mensagemErroAuth(data.mensagem || data.erro, 'Falha no login.'));
            return;
        }
        fecharAuth();
        atualizarUILogado(data.usuario);
    } catch {
        mostrarErroTela('login-erro', 'Erro de conexão.');
    } finally {
        if (btn) { btn.textContent = original; btn.disabled = false; }
    }
}

async function realizarCadastro() {
    const nome = obterElemento('cad-nome')?.value.trim();
    const email = obterElemento('cad-email')?.value.trim();
    const senha = obterElemento('cad-senha')?.value;

    if (!nome || !email || !senha) {
        mostrarErroTela('cad-erro', 'Preencha todos os campos.');
        return;
    }

    const btn = obterElemento('btn-cadastrar');
    const original = btn?.textContent || 'Cadastrar';
    if (btn) { btn.textContent = 'Criando...'; btn.disabled = true; }

    fecharVoz();
    pararRespostaIA();

    try {
        const res = await fetch('/auth/registro', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, email, senha })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            mostrarErroTela('cad-erro', mensagemErroAuth(data.mensagem || data.erro, 'Falha no cadastro.'));
            return;
        }
        fecharAuth();
        atualizarUILogado(data.usuario);
    } catch {
        mostrarErroTela('cad-erro', 'Erro de conexão.');
    } finally {
        if (btn) { btn.textContent = original; btn.disabled = false; }
    }
}

async function realizarLogout() {
    fecharVoz();
    pararRespostaIA();
    try {
        await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {}
    atualizarUIVisitante();
    resetarChat();
}

async function enviarCodigoRecuperacao() {
    const email = obterElemento('esq-email')?.value.trim();
    if (!email) {
        mostrarErroTela('esq-erro', 'Digite seu e-mail.');
        return;
    }
    mostrarErroTela('esq-erro', '');
    try {
        const res = await fetch('/auth/esqueci-senha', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            mostrarErroTela('esq-erro', data.mensagem || 'Não foi possível enviar o código.');
            return;
        }
        emailRecuperacao = email;
        definirTexto('cod-label', `Código enviado para ${email}`);
        mostrarTela('tela-codigo');
    } catch {
        mostrarErroTela('esq-erro', 'Erro de conexão.');
    }
}

async function alterarSenha() {
    const codigo = obterElemento('cod-input')?.value.trim();
    const novaSenha = obterElemento('cod-nova-senha')?.value;
    if (!codigo || !novaSenha) {
        mostrarErroTela('cod-erro', 'Preencha o código e a nova senha.');
        return;
    }
    try {
        const res = await fetch('/auth/mudar-senha', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: emailRecuperacao, codigo, nova_senha: novaSenha })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            mostrarErroTela('cod-erro', data.mensagem || 'Código inválido.');
            return;
        }
        alert('Senha alterada! Faça login.');
        mostrarTela('tela-login');
    } catch {
        mostrarErroTela('cod-erro', 'Erro de conexão.');
    }
}

/* ================================================================
   8. HISTÓRICO DE CONVERSAS (SIDEBAR)
================================================================ */
async function carregarHistorico() {
    const lista = obterElemento('historico-lista');
    if (!lista || !usuarioAtual) return;

    try {
        const res = await fetch('/conversas', { credentials: 'include' });
        if (!res.ok) throw new Error('Falha ao carregar histórico.');
        const data = await res.json();
        const conversas = Array.isArray(data) ? data : (data.conversas || data.historico || []);
        renderizarHistorico(conversas);
    } catch {
        lista.innerHTML = '<p class="sidebar-hint">Nenhuma conversa salva ainda.</p>';
    }
}

function renderizarHistorico(conversas) {
    const lista = obterElemento('historico-lista');
    if (!lista) return;
    lista.innerHTML = '';

    if (!conversas.length) {
        lista.innerHTML = '<p class="sidebar-hint">Nenhuma conversa ainda.</p>';
        return;
    }

    const ordenadas = [...conversas].sort((a, b) => {
        const aFixada = Boolean(a.fixada ?? a.fixa ?? a.pinned);
        const bFixada = Boolean(b.fixada ?? b.fixa ?? b.pinned);
        if (aFixada !== bFixada) return bFixada - aFixada;
        return new Date(b.atualizado_em || b.updatedAt || 0) - new Date(a.atualizado_em || a.updatedAt || 0);
    });

    ordenadas.forEach(conversa => {
        const id = conversa.id ?? conversa._id;
        if (!id) return;
        const titulo = conversa.titulo || conversa.nome || 'Nova conversa';
        const fixada = Boolean(conversa.fixada ?? conversa.fixa ?? conversa.pinned);

        const item = document.createElement('div');
        item.className = 'historico-item';
        item.dataset.id = id;
        if (String(id) === String(idConversaAtiva)) item.classList.add('ativo');

        item.innerHTML = `
            <button type="button" class="historico-conversa" data-id="${escaparHTML(id)}">
                <span class="historico-titulo">${escaparHTML(titulo)}</span>
            </button>
            <button type="button" class="historico-menu-btn" aria-label="Opções" aria-expanded="false" data-menu-id="${escaparHTML(id)}">⋮</button>
            <div class="historico-acoes" data-acoes-id="${escaparHTML(id)}" style="display:none">
                <button type="button" data-acao="fixar" data-id="${escaparHTML(id)}">${fixada ? 'Desafixar' : 'Fixar'}</button>
                <button type="button" data-acao="renomear" data-id="${escaparHTML(id)}">Renomear</button>
                <button type="button" data-acao="excluir" data-id="${escaparHTML(id)}">Excluir</button>
            </div>
        `;
        lista.appendChild(item);
    });

    lista.querySelectorAll('.historico-conversa').forEach(btn => {
        btn.addEventListener('click', () => {
            fecharMenusHistorico();
            abrirConversa(btn.dataset.id);
        });
    });

    lista.querySelectorAll('.historico-menu-btn').forEach(btn => {
        btn.addEventListener('click', event => {
            event.stopPropagation();
            const id = btn.dataset.menuId;
            const abrir = btn.getAttribute('aria-expanded') !== 'true';
            fecharMenusHistorico();
            btn.setAttribute('aria-expanded', String(abrir));
            document.querySelectorAll('.historico-acoes').forEach(menu => {
                menu.style.display = (menu.dataset.acoesId === id && abrir) ? 'block' : 'none';
            });
        });
    });

    lista.querySelectorAll('[data-acao]').forEach(btn => {
        btn.addEventListener('click', () => {
            const acao = btn.dataset.acao;
            const id = btn.dataset.id;
            fecharMenusHistorico();
            if (acao === 'fixar') acaoFixar(id);
            if (acao === 'renomear') abrirRenomear(id);
            if (acao === 'excluir') abrirConfirmarExcluir(id);
        });
    });
}

function fecharMenusHistorico() {
    document.querySelectorAll('.historico-acoes').forEach(m => { m.style.display = 'none'; });
    document.querySelectorAll('.historico-menu-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
}

async function abrirConversa(id) {
    if (!id) return;
    try {
        const res = await fetch(`/conversas/${encodeURIComponent(id)}`, { credentials: 'include' });
        if (!res.ok) throw new Error();
        const data = await res.json();
        idConversaAtiva = data.conversa_id ?? data.id ?? id;
        renderizarMensagens(data.mensagens || data.messages || []);
        carregarHistorico();
    } catch {
        alert('Não foi possível abrir a conversa.');
    }
}

function renderizarMensagens(mensagens) {
    const container = obterElemento('chat-messages') || obterElemento('mensagens');
    if (!container) return;
    container.innerHTML = '';

    mensagens.forEach(m => {
        const papel = String(m.role || m.tipo || m.remetente || '').toLowerCase();
        const texto = m.content ?? m.conteudo ?? m.texto ?? m.mensagem ?? '';
        const tipo = (papel === 'user' || papel === 'usuario') ? 'usuario' : 'ia';
        const el = adicionarMensagemDOM(tipo, texto);
        if (tipo === 'ia' && el && typeof marked !== 'undefined') {
            const conteudoEl = el.querySelector('.mensagem-conteudo');
            if (conteudoEl) conteudoEl.innerHTML = sanitizarHTML(marked.parse(String(texto), { breaks: true }));
        }
    });
    container.scrollTop = container.scrollHeight;
}

function adicionarMensagemDOM(tipo, texto) {
    const container = obterElemento('chat-messages') || obterElemento('mensagens');
    if (!container) return null;

    const mensagem = document.createElement('div');
    mensagem.className = tipo === 'usuario' ? 'mensagem mensagem-usuario' : 'mensagem mensagem-ia';
    mensagem.dataset.role = tipo;

    const conteudo = document.createElement('div');
    conteudo.className = 'mensagem-conteudo';
    conteudo.textContent = String(texto ?? '');

    mensagem.appendChild(conteudo);
    container.appendChild(mensagem);
    container.scrollTop = container.scrollHeight;
    return mensagem;
}

function adicionarAnexoUsuarioDOM(anexo) {
    const container = obterElemento('chat-messages') || obterElemento('mensagens');
    if (!container || !anexo) return;

    const mensagem = document.createElement('div');
    mensagem.className = 'mensagem mensagem-usuario';
    mensagem.dataset.role = 'usuario';

    const conteudo = document.createElement('div');
    conteudo.className = 'mensagem-conteudo mensagem-anexo-conteudo';

    if (anexo.dataUrl && anexo.tipo === 'imagem') {
        const preview = document.createElement('img');
        preview.src = anexo.dataUrl;
        preview.alt = 'Imagem anexada';
        conteudo.appendChild(preview);
    } else if (anexo.dataUrl && anexo.tipo === 'video') {
        const preview = document.createElement('video');
        preview.src = anexo.dataUrl;
        preview.controls = true;
        preview.preload = 'metadata';
        conteudo.appendChild(preview);
    } else if (anexo.dataUrl && anexo.tipo === 'audio') {
        const preview = document.createElement('audio');
        preview.src = anexo.dataUrl;
        preview.controls = true;
        preview.preload = 'metadata';
        conteudo.appendChild(preview);
    } else {
        conteudo.textContent = `📎 ${anexo.nome || 'Arquivo anexado'}`;
    }

    mensagem.appendChild(conteudo);
    container.appendChild(mensagem);
    container.scrollTop = container.scrollHeight;
}

async function acaoFixar(id) {
    if (!id) return;
    try {
        await fetch(`/conversas/${encodeURIComponent(id)}/fixar`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });
        await carregarHistorico();
    } catch {}
}

function abrirRenomear(id) {
    idConversaRenomear = id;
    const input = obterElemento('renomear-input');
    if (input) input.value = '';
    mostrarTela('tela-renomear');
}

async function salvarRenomear() {
    if (!idConversaRenomear) return;
    const titulo = obterElemento('renomear-input')?.value?.trim();
    if (!titulo) {
        mostrarErroTela('renomear-erro', 'Digite um nome.');
        return;
    }
    try {
        const res = await fetch(`/conversas/${encodeURIComponent(idConversaRenomear)}`, {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ titulo })
        });
        if (!res.ok) throw new Error();
        idConversaRenomear = null;
        fecharAuth();
        await carregarHistorico();
    } catch {
        mostrarErroTela('renomear-erro', 'Não foi possível renomear a conversa.');
    }
}

function abrirConfirmarExcluir(id) {
    idConversaExcluir = id;
    mostrarTela('tela-confirmar');
}

async function confirmarExcluir() {
    if (!idConversaExcluir) return;
    try {
        await fetch(`/conversas/${encodeURIComponent(idConversaExcluir)}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        if (String(idConversaAtiva) === String(idConversaExcluir)) {
            idConversaAtiva = null;
            resetarChat();
        }
        idConversaExcluir = null;
        fecharAuth();
        await carregarHistorico();
    } catch {}
}

async function pesquisarConversas(termo) {
    const lista = obterElemento('historico-lista');
    if (!lista) return;
    const texto = String(termo || '').trim().toLowerCase();
    if (!texto) {
        await carregarHistorico();
        return;
    }
    lista.querySelectorAll('.historico-item').forEach(item => {
        const titulo = item.querySelector('.historico-titulo')?.textContent?.toLowerCase() || '';
        item.style.display = titulo.includes(texto) ? '' : 'none';
    });
}

/* ================================================================
   9. CHAT PRINCIPAL E STREAMING (SSE)
================================================================ */
function mostrarWelcome(forcar = false) {
    const container = obterElemento('chat-messages') || obterElemento('mensagens');
    if (!container) return;
    if (!forcar && container.children.length) return;

    container.innerHTML = `
        <div class="iana-welcome">
            <div class="iana-welcome-content">
                <h1>Olá! Eu sou a Iana.</h1>
                <p>Como posso ajudar você hoje?</p>
            </div>
        </div>
    `;
}

function removerWelcome() {
    document.querySelectorAll('.iana-welcome').forEach(el => el.remove());
}

function mostrarIndicadorDigitando() {
    removerIndicadorDigitando();
    const container = obterElemento('chat-messages') || obterElemento('mensagens');
    if (!container) return null;

    const elemento = document.createElement('div');
    elemento.id = 'iana-digitando';
    elemento.className = 'mensagem mensagem-ia mensagem-digitando';
    elemento.innerHTML = `
        <div class="mensagem-conteudo">
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
        </div>
    `;
    container.appendChild(elemento);
    container.scrollTop = container.scrollHeight;
    return elemento;
}

function removerIndicadorDigitando() {
    obterElemento('iana-digitando')?.remove();
}

async function processarEnvioIA(texto, opcoesAnexo = null, previewAnexo = null) {
    if (aguardandoResposta) return;
    const textoLimpo = String(texto || '').trim();
    if (!textoLimpo && !opcoesAnexo) return;

    const estadoEmocional = typeof window.detectarEstadoEmocional === 'function'
        ? window.detectarEstadoEmocional(textoLimpo)
        : 'normal';

    if (opcoesAnexo) {
        aguardandoResposta = true;
        atualizarBotoesChat(true);
        controller = new AbortController();

        removerWelcome();
        if (previewAnexo) adicionarAnexoUsuarioDOM(previewAnexo);
        adicionarMensagemDOM('usuario', textoLimpo);
        mostrarIndicadorDigitando();

        try {
            const payload = {
                mensagem: textoLimpo,
                conversa_id: idConversaAtiva,
                config_usuario: obterConfigSalva(),
                estadoEmocional,
                ...opcoesAnexo
            };

            const response = await fetch('/chat', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            const data = await response.json().catch(() => ({}));
            removerIndicadorDigitando();

            if (!response.ok) {
                throw new Error(data.mensagem || 'Não foi possível processar o anexo.');
            }

            const respostaTexto = data.resposta || 'Recebi o seu arquivo!';
            const elementoIA = adicionarMensagemDOM('ia', respostaTexto);
            const conteudoEl = elementoIA?.querySelector('.mensagem-conteudo');
            if (conteudoEl && typeof marked !== 'undefined') {
                conteudoEl.innerHTML = sanitizarHTML(marked.parse(respostaTexto, { breaks: true }));
            }

            if (data.conversa_id) idConversaAtiva = data.conversa_id;
            if (usuarioAtual) carregarHistorico();
            if (ttsNextResponse) {
                ttsNextResponse = false;
                falar(respostaTexto);
            }
        } catch (err) {
            removerIndicadorDigitando();
            if (err.name !== 'AbortError') {
                adicionarMensagemDOM('ia', err.message || 'Erro ao enviar anexo para a Iana.');
            }
        } finally {
            controller = null;
            aguardandoResposta = false;
            atualizarBotoesChat(false);
        }
        return;
    }

    return await processarEnvioIAStreaming(textoLimpo);
}

async function processarEnvioIAStreaming(texto) {
    const textoLimpo = String(texto || '').trim();
    if (!textoLimpo || aguardandoResposta) return;

    aguardandoResposta = true;
    atualizarBotoesChat(true);
    controller = new AbortController();

    removerWelcome();
    adicionarMensagemDOM('usuario', textoLimpo);

    const elementoIA = adicionarMensagemDOM('ia', '...');
    const conteudoEl = elementoIA.querySelector('.mensagem-conteudo');
    const container = obterElemento('chat-messages') || obterElemento('mensagens');

    let textoAcumulado = '';
    let bufferSSE = '';

    try {
        const params = new URLSearchParams({
            mensagem: textoLimpo,
            conversa_id: idConversaAtiva || '',
            config: JSON.stringify(obterConfigSalva())
        });

        const response = await fetch(`/chat/stream?${params.toString()}`, {
            credentials: 'include',
            signal: controller.signal
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.mensagem || `Erro HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            bufferSSE += decoder.decode(value, { stream: true });
            const blocos = bufferSSE.split('\n\n');
            bufferSSE = blocos.pop() || '';

            for (const bloco of blocos) {
                const linha = bloco.trim();
                if (!linha.startsWith('data: ')) continue;

                try {
                    const json = JSON.parse(linha.substring(6));
                    if (json.erro) {
                        textoAcumulado = json.erro;
                        conteudoEl.textContent = textoAcumulado;
                    }
                    if (json.chunk) {
                        textoAcumulado += json.chunk;
                        conteudoEl.textContent = textoAcumulado;
                        if (container) container.scrollTop = container.scrollHeight;
                    }
                    if (json.conversa_id) {
                        idConversaAtiva = json.conversa_id;
                    }
                } catch {}
            }
        }

        if (!textoAcumulado.trim()) {
            textoAcumulado = 'Não consegui gerar uma resposta agora. Tenta de novo?';
            conteudoEl.textContent = textoAcumulado;
        } else if (typeof marked !== 'undefined') {
            conteudoEl.innerHTML = sanitizarHTML(marked.parse(textoAcumulado, { breaks: true }));
        }

        if (usuarioAtual) carregarHistorico();
        if (ttsNextResponse) {
            ttsNextResponse = false;
            falar(textoAcumulado);
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            conteudoEl.textContent = textoAcumulado || '[Resposta interrompida pelo jogador.]';
        } else {
            conteudoEl.textContent = err.message || 'Ocorreu um erro ao gerar a resposta em tempo real.';
        }
    } finally {
        controller = null;
        aguardandoResposta = false;
        atualizarBotoesChat(false);
    }
}

function pararRespostaIA() {
    if (controller) {
        try { controller.abort(); } catch {}
    }
    controller = null;
    aguardandoResposta = false;
    removerIndicadorDigitando();
    atualizarBotoesChat(false);
}

function atualizarBotoesChat(processando) {
    const send = obterElemento('btn-send');
    const stop = obterElemento('btn-stop');
    if (send) send.style.display = processando ? 'none' : '';
    if (stop) stop.style.display = processando ? '' : 'none';
}

async function enviarMensagem() {
    const input = obterElemento('chat-input');
    if (!input || aguardandoResposta) return;
    const mensagem = input.value.trim();
    if (!mensagem) return;
    input.value = '';
    input.style.height = 'auto';
    await processarEnvioIA(mensagem);
}

function usarSugestao(texto) {
    const input = obterElemento('chat-input');
    if (!input) return;
    input.value = texto;
    enviarMensagem();
}

function resetarChat() {
    fecharVoz();
    pararRespostaIA();
    idConversaAtiva = null;
    ttsNextResponse = false;

    if (window.animacaoChat?.resetar) {
        try { window.animacaoChat.resetar(); } catch {}
    }

    const container = obterElemento('chat-messages') || obterElemento('mensagens');
    if (container) container.innerHTML = '';
    mostrarWelcome(true);

    document.querySelectorAll('.historico-item').forEach(item => item.classList.remove('ativo'));
}

async function enviarFeedback() {
    const input = obterElemento('feedback-input');
    const texto = input?.value?.trim();
    if (!texto) {
        mostrarErroTela('feedback-erro', 'Digite seu feedback.');
        return;
    }
    try {
        const res = await fetch('/feedback', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ feedback: texto, conversa_id: idConversaAtiva })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.mensagem || 'Falha ao enviar feedback.');
        if (input) input.value = '';
        fecharAuth();
        alert('Feedback enviado. Obrigado!');
    } catch (erro) {
        mostrarErroTela('feedback-erro', erro.message || 'Não foi possível enviar o feedback.');
    }
}

/* ================================================================
   10. SIDEBAR, DROPDOWN E VISÃO LOCAL
================================================================ */
function iniciarSidebar() {
    const sidebar = obterElemento('sidebar');
    const sidebarToggle = obterElemento('sidebar-toggle');
    if (!sidebar || !sidebarToggle) return;

    const mobile = window.matchMedia('(max-width: 768px)');
    const sidebarTop = sidebar.querySelector('.sidebar-top');
    const main = document.querySelector('.main');
    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-overlay';
    backdrop.setAttribute('aria-hidden', 'true');
    sidebar.before(backdrop);
    let desktopCollapsed = sidebar.classList.contains('collapsed');

    const atualizarSidebar = () => {
        const aberto = mobile.matches
            ? sidebar.classList.contains('mobile-open')
            : !sidebar.classList.contains('collapsed');
        sidebar.inert = mobile.matches && !aberto;
        backdrop.classList.toggle('ativo', mobile.matches && aberto);
        sidebarToggle.title = aberto ? 'Fechar menu' : 'Abrir menu';
        sidebarToggle.setAttribute('aria-label', sidebarToggle.title);
        sidebarToggle.setAttribute('aria-expanded', String(aberto));
    };

    const fecharMobile = () => {
        if (!mobile.matches || !sidebar.classList.contains('mobile-open')) return;
        sidebar.classList.remove('mobile-open');
        main?.prepend(sidebarToggle);
        fecharMenusHistorico();
        atualizarSidebar();
    };

    const ajustarTela = () => {
        if (mobile.matches) {
            if (!sidebar.classList.contains('mobile-open')) main?.prepend(sidebarToggle);
        } else {
            sidebarTop?.append(sidebarToggle);
        }
        sidebar.classList.remove('mobile-open');
        sidebar.classList.toggle('collapsed', !mobile.matches && desktopCollapsed);
        atualizarSidebar();
    };

    const alternarSidebar = () => {
        if (mobile.matches) {
            if (sidebar.classList.contains('mobile-open')) return fecharMobile();
            sidebar.classList.add('mobile-open');
            sidebarTop?.append(sidebarToggle);
        } else {
            desktopCollapsed = sidebar.classList.toggle('collapsed');
        }
        atualizarSidebar();
    };

    backdrop.addEventListener('click', fecharMobile);
    sidebar.addEventListener('click', event => {
        if (event.target.closest('.historico-conversa, #btn-novo-chat, a')) fecharMobile();
    });
    mobile.addEventListener('change', ajustarTela);
    ajustarTela();
    sidebarToggle.addEventListener('click', alternarSidebar);
}

function iniciarDropdownUsuario() {
    const btn = obterElemento('btn-user-menu');
    const dropdown = obterElemento('user-dropdown');
    if (!btn || !dropdown) return;

    btn.addEventListener('click', event => {
        event.stopPropagation();
        const aberto = dropdown.classList.toggle('aberto');
        dropdown.style.display = aberto ? 'flex' : 'none';
    });

    document.addEventListener('click', () => {
        dropdown.classList.remove('aberto');
        dropdown.style.display = 'none';
    });

    obterElemento('dd-config')?.addEventListener('click', () => {
        window.location.href = '/configuracoes';
    });

    obterElemento('dd-feedback')?.addEventListener('click', () => {
        dropdown.classList.remove('aberto');
        dropdown.style.display = 'none';
        mostrarTela('tela-feedback');
    });
}

async function chamarVisaoLocal(path, options = {}) {
    const response = await fetch(`${URL_VISAO_LOCAL}${path}`, {
        mode: 'cors',
        cache: 'no-store',
        ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Serviço de visão respondeu HTTP ${response.status}.`);
    return data;
}

async function iniciarVisaoChamada() {
    if (!emChamadaVoz || visaoChamadaAtiva) return;
    const iniciar = obterElemento('btn-voz-visao');
    const parar = obterElemento('btn-voz-visao-parar');
    const status = obterElemento('voz-visao-status');
    if (!navigator.mediaDevices?.getDisplayMedia) {
        if (status) status.textContent = 'Este navegador não permite compartilhar a tela.';
        return;
    }

    if (iniciar) iniciar.disabled = true;
    if (status) status.textContent = 'Conectando ao YOLO local…';
    try {
        visaoChamadaStream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 5, max: 10 } },
            audio: false
        });
        if (!emChamadaVoz) {
            visaoChamadaStream.getTracks().forEach(t => t.stop());
            visaoChamadaStream = null;
            return;
        }
        const track = visaoChamadaStream.getVideoTracks()[0];
        if (track) track.addEventListener('ended', pararVisaoChamada, { once: true });

        const localStatus = await chamarVisaoLocal('/api/status');
        visaoChamadaToken = localStatus.token;
        if (!localStatus.ready) {
            await chamarVisaoLocal('/api/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Iana-Vision': visaoChamadaToken },
                body: '{}'
            });
        }

        const preview = obterElemento('voz-visao-preview');
        const previewVideo = obterElemento('voz-visao-video');
        visaoChamadaOverlay = obterElemento('voz-visao-overlay');
        if (!preview || !previewVideo || !visaoChamadaOverlay) {
            throw new Error('A prévia de visão não está disponível.');
        }
        visaoChamadaVideo = previewVideo;
        visaoChamadaVideo.srcObject = visaoChamadaStream;
        visaoChamadaVideo.muted = true;
        await visaoChamadaVideo.play();
        visaoChamadaCanvas = document.createElement('canvas');
        visaoChamadaAtiva = true;
        preview.hidden = false;
        if (iniciar) iniciar.hidden = true;
        if (parar) parar.hidden = false;
        if (status) status.textContent = 'Tela compartilhada · análise local ativa.';
    } catch (error) {
        await pararVisaoChamada();
        if (status) status.textContent = error?.message || 'Erro ao iniciar visão.';
    } finally {
        if (iniciar && !visaoChamadaAtiva) iniciar.disabled = false;
    }
}

async function pararVisaoChamada() {
    visaoChamadaAtiva = false;
    visaoChamadaStream?.getTracks().forEach(t => t.stop());
    visaoChamadaStream = null;
    if (visaoChamadaVideo) visaoChamadaVideo.srcObject = null;
    visaoChamadaVideo = null;
    visaoChamadaCanvas = null;
    visaoChamadaToken = '';

    const preview = obterElemento('voz-visao-preview');
    if (preview) preview.hidden = true;
    const iniciar = obterElemento('btn-voz-visao');
    const parar = obterElemento('btn-voz-visao-parar');
    if (iniciar) { iniciar.hidden = false; iniciar.disabled = false; }
    if (parar) parar.hidden = true;
}

/* ================================================================
   11. REGISTO DE TODOS OS BOTÕES E INICIALIZAÇÃO
================================================================ */
function iniciarEventosAuth() {
    obterElemento('btn-entrar')?.addEventListener('click', () => mostrarTela('tela-login'));
    obterElemento('btn-registrar')?.addEventListener('click', () => mostrarTela('tela-cadastro'));
    obterElemento('btn-login')?.addEventListener('click', realizarLogin);
    obterElemento('btn-cadastrar')?.addEventListener('click', realizarCadastro);
    obterElemento('btn-enviar-cod')?.addEventListener('click', enviarCodigoRecuperacao);
    obterElemento('btn-mudar-senha')?.addEventListener('click', alterarSenha);
    obterElemento('dd-logout')?.addEventListener('click', realizarLogout);
}

function iniciarEventosChat() {
    obterElemento('btn-novo-chat')?.addEventListener('click', resetarChat);
    obterElemento('btn-send')?.addEventListener('click', enviarMensagem);
    obterElemento('btn-stop')?.addEventListener('click', pararRespostaIA);

    const input = obterElemento('chat-input');
    if (input) {
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                enviarMensagem();
            }
        });
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
        });
    }
}

function iniciarEventosVoz() {
    obterElemento('btn-voz-call')?.addEventListener('click', abrirVoz);
    obterElemento('btn-voz-encerrar')?.addEventListener('click', fecharVoz);
    obterElemento('btn-voz-mute')?.addEventListener('click', toggleMuteVoz);
    obterElemento('btn-voz-visao')?.addEventListener('click', iniciarVisaoChamada);
    obterElemento('btn-voz-visao-parar')?.addEventListener('click', pararVisaoChamada);
}

function iniciarEventosCamera() {
    obterElemento('btn-camera-fechar')?.addEventListener('click', fecharCamera);
    obterElemento('btn-camera-capturar')?.addEventListener('click', capturarFoto);
    obterElemento('btn-camera-cancelar')?.addEventListener('click', fecharCamera);
    obterElemento('overlay-camera')?.addEventListener('click', e => {
        if (e.target.id === 'overlay-camera') fecharCamera();
    });
    obterElemento('overlay-auth')?.addEventListener('click', e => {
        if (e.target.id === 'overlay-auth') fecharAuth();
    });
}

function iniciarEventosHistorico() {
    obterElemento('btn-buscar')?.addEventListener('click', () => mostrarTela('tela-pesquisa'));
    obterElemento('pesquisa-input')?.addEventListener('input', e => pesquisarConversas(e.target.value));
    obterElemento('btn-salvar-rename')?.addEventListener('click', salvarRenomear);
    obterElemento('btn-confirmar-excluir')?.addEventListener('click', confirmarExcluir);
    obterElemento('btn-fb-enviar')?.addEventListener('click', enviarFeedback);

    ['login-email', 'login-senha'].forEach(id => {
        obterElemento(id)?.addEventListener('keydown', e => {
            if (e.key === 'Enter') realizarLogin();
        });
    });
    ['cad-nome', 'cad-email', 'cad-senha'].forEach(id => {
        obterElemento(id)?.addEventListener('keydown', e => {
            if (e.key === 'Enter') realizarCadastro();
        });
    });
}

function iniciarEventosGlobais() {
    document.addEventListener('click', event => {
        if (!event.target.closest('.historico-acoes, .historico-menu-btn')) {
            fecharMenusHistorico();
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            fecharMenusHistorico();
            const auth = obterElemento('overlay-auth');
            if (auth && auth.style.display !== 'none') fecharAuth();
        }
    });
}

async function inicializarApp() {
    if (chatInicializado) return;
    chatInicializado = true;

    if (typeof speechSynthesis !== 'undefined') {
        speechSynthesis.onvoiceschanged = () => {
            ttsVoice = null;
            escolherVozTTS();
        };
    }

    iniciarSidebar();
    iniciarDropdownUsuario();
    iniciarEventosAuth();
    iniciarEventosChat();
    iniciarEventosVoz();
    iniciarEventosCamera();
    iniciarEventosHistorico();
    iniciarEventosGlobais();
    iniciarMenuUpload();
    iniciarUpload();
    iniciarGravacaoAudio();

    mostrarWelcome(true);
    await verificarSessao();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inicializarApp, { once: true });
} else {
    inicializarApp();
}

window.IANA = {
    enviarMensagem,
    processarEnvioIA,
    processarEnvioIAStreaming,
    pararRespostaIA,
    abrirVoz,
    fecharVoz,
    toggleMuteVoz,
    abrirCamera,
    fecharCamera,
    capturarFoto,
    resetarChat,
    carregarHistorico,
    abrirConversa,
    acaoFixar,
    abrirRenomear,
    salvarRenomear,
    abrirConfirmarExcluir,
    confirmarExcluir,
    enviarFeedback,
    mostrarTela,
    fecharAuth,
    realizarLogin,
    realizarCadastro,
    realizarLogout,
    pesquisarConversas,
    usarSugestao
};

Object.assign(window, window.IANA);