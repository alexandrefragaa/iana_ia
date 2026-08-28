/* ================================================================
   IANA — chat.js
   Versão completa
   Frontend + Auth + Chat + Histórico + Upload + Voice Mode
   ElevenLabs permanece exclusivamente no BACKEND/Render ENV
================================================================ */

'use strict';

/* ================================================================
   ESTADO GLOBAL
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

/* ---------------- Socket de voz ---------------- */

let vozSocket = null;
let vozSocketConectando = false;

let audioCtxEleven = null;
let audioNextPlaybackTime = 0;
let audioSourcesEleven = new Set();
let audioPcmResto = new Uint8Array(0);

/* ---------------- Voice Mode ---------------- */

let vozProcessando = false;
let vozFalando = false;
let vozInicializando = false;

let emChamadaVoz = false;

let mediaRecorderAudio = null;
let audioChunks = [];
let gravandoAudio = false;

/* ---------------- Câmera ---------------- */

let streamCamera = null;

/* ---------------- Visualização do microfone ---------------- */

let audioCtxVoz = null;
let analyserVoz = null;
let streamAudioVozBars = null;
let rafVozId = null;

/* ---------------- Controle de inicialização ---------------- */

let chatInicializado = false;
let uploadInicializado = false;
let menuUploadInicializado = false;
let gravacaoInicializada = false;


/* ================================================================
   CONFIGURAÇÃO
================================================================ */

const CONFIG_KEY = 'iana_config';

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
   UTILITÁRIOS
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

        reader.onerror = () => {
            reject(new Error('Não foi possível ler o arquivo.'));
        };

        reader.readAsDataURL(file);
    });
}


function obterElemento(id) {
    return document.getElementById(id);
}


function definirTexto(id, texto) {
    const el = obterElemento(id);

    if (el) {
        el.textContent = String(texto ?? '');
    }
}


function mostrarElemento(id, display = 'block') {
    const el = obterElemento(id);

    if (el) {
        el.style.display = display;
    }
}


function esconderElemento(id) {
    const el = obterElemento(id);

    if (el) {
        el.style.display = 'none';
    }
}


function obterConfigSalva() {
    try {
        return JSON.parse(
            localStorage.getItem(CONFIG_KEY)
        ) || {};
    } catch {
        return {};
    }
}


function montarConfigPrompt() {
    const c = obterConfigSalva();

    if (!Object.keys(c).length) {
        return '';
    }

    const linhas = [];

    if (Array.isArray(c.personalidade) && c.personalidade.length) {
        linhas.push(
            `Estilo de personalidade: ${c.personalidade.join(', ')}.`
        );
    }

    if (Array.isArray(c.foco) && c.foco.length) {
        linhas.push(
            `Foco principal: ${c.foco.join(', ')}.`
        );
    }

    if (Array.isArray(c.plataforma) && c.plataforma.length) {
        linhas.push(
            `Plataforma do usuário: ${c.plataforma.join(', ')}.`
        );
    }

    if (Array.isArray(c.voz) && c.voz.length) {
        linhas.push(
            `Estilo de escrita/voz: ${c.voz.join(', ')}.`
        );
    }

    if (c.tamanho) {
        linhas.push(
            `Tamanho preferido das respostas: ${c.tamanho}.`
        );
    }

    if (c.emojis) {
        linhas.push(
            `Uso de emojis: ${c.emojis}.`
        );
    }

    if (c.instrucoes) {
        linhas.push(
            `Instruções específicas do usuário: ${c.instrucoes}`
        );
    }

    if (c.sobreVoce) {
        linhas.push(
            `Sobre o usuário: ${c.sobreVoce}`
        );
    }

    const comportamentos = [];

    if (c.perguntas === false) {
        comportamentos.push(
            'NÃO termine a resposta com uma pergunta.'
        );
    }

    if (c.humor === false) {
        comportamentos.push(
            'NÃO adapte obrigatoriamente o tom ao humor do usuário.'
        );
    }

    if (c.criatividade === false) {
        comportamentos.push(
            'NÃO invente informações quando não souber a resposta.'
        );
    }

    if (c.contexto === false) {
        comportamentos.push(
            'NÃO dependa de mensagens anteriores quando isso não for necessário.'
        );
    }

    if (comportamentos.length) {
        linhas.push(comportamentos.join(' '));
    }

    return linhas.join('\n');
}


/* ================================================================
   TTS DO NAVEGADOR
================================================================ */

function getVoicesTTS() {
    if (typeof speechSynthesis === 'undefined') {
        return [];
    }

    return speechSynthesis.getVoices();
}


function escolherVozTTS() {
    if (ttsVoice) {
        return ttsVoice;
    }

    const voices = getVoicesTTS();

    if (!voices.length) {
        return null;
    }

    const preferida = voices.find(voice =>
        /pt-BR|pt/i.test(voice.lang) &&
        /female|maria|luciana|fernanda/i.test(voice.name)
    );

    ttsVoice =
        preferida ||
        voices.find(voice => /pt-BR|pt/i.test(voice.lang)) ||
        voices[0];

    return ttsVoice;
}


function falar(texto) {
    if (emChamadaVoz) {
        return Promise.resolve();
    }

    return new Promise(resolve => {
        try {
            if (
                !ttsEnabled ||
                typeof speechSynthesis === 'undefined' ||
                !texto
            ) {
                resolve();
                return;
            }

            const utterance = new SpeechSynthesisUtterance(
                String(texto).replace(/\n/g, ' ')
            );

            utterance.lang = 'pt-BR';

            const voz = escolherVozTTS();

            if (voz) {
                utterance.voice = voz;
            }

            utterance.rate = 1;
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


/* ================================================================
   ELEVENLABS / AUDIO RECEBIDO DO BACKEND
================================================================ */

/*
   IMPORTANTE:

   A API KEY do ElevenLabs NÃO fica neste arquivo.

   O frontend recebe somente o áudio processado pelo backend.

   O backend pode emitir:

       socket.emit('voz:audio-resposta', {
           audio: 'BASE64_PCM'
       });

   O áudio esperado nesta implementação é:

       PCM
       mono
       signed Int16
       24000 Hz
*/

function pararAudioEleven() {
    for (const source of audioSourcesEleven) {
        try {
            source.stop();
        } catch {}
    }

    audioSourcesEleven.clear();

    audioPcmResto = new Uint8Array(0);
    audioNextPlaybackTime = 0;
    vozFalando = false;
}


function obterAudioContextEleven() {
    const AudioContextClass =
        window.AudioContext ||
        window.webkitAudioContext;

    if (!AudioContextClass) {
        return null;
    }

    if (!audioCtxEleven) {
        audioCtxEleven = new AudioContextClass({
            sampleRate: 24000
        });
    }

    return audioCtxEleven;
}


async function garantirAudioElevenAtivo() {
    const ctx = obterAudioContextEleven();

    if (!ctx) {
        return null;
    }

    if (ctx.state === 'suspended') {
        try {
            await ctx.resume();
        } catch {}
    }

    return ctx;
}


function tocarAudioEleven(base64) {
    if (!emChamadaVoz || !base64) {
        return;
    }

    const ctx = obterAudioContextEleven();

    if (!ctx) {
        return;
    }

    if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
    }

    let binario;

    try {
        binario = atob(base64);
    } catch {
        console.warn('[IANA VOZ] Áudio Base64 inválido.');
        return;
    }

    let bytes = new Uint8Array(binario.length);

    for (let i = 0; i < binario.length; i++) {
        bytes[i] = binario.charCodeAt(i);
    }

    /*
       Se o chunk anterior terminou em byte ímpar,
       junta com o próximo.
    */

    if (audioPcmResto.length) {
        const combinado = new Uint8Array(
            audioPcmResto.length + bytes.length
        );

        combinado.set(audioPcmResto, 0);
        combinado.set(bytes, audioPcmResto.length);

        bytes = combinado;

        audioPcmResto = new Uint8Array(0);
    }

    if (bytes.length % 2 !== 0) {
        audioPcmResto = bytes.slice(bytes.length - 1);
        bytes = bytes.slice(0, -1);
    }

    if (!bytes.length) {
        return;
    }

    /*
       PCM Int16 little-endian.
    */

    const samples = new Int16Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / 2
    );

    const buffer = ctx.createBuffer(
        1,
        samples.length,
        24000
    );

    const data = buffer.getChannelData(0);

    for (let i = 0; i < samples.length; i++) {
        data[i] = samples[i] / 32768;
    }

    const source = ctx.createBufferSource();

    source.buffer = buffer;
    source.connect(ctx.destination);

    const agora = ctx.currentTime;

    const quando = Math.max(
        agora + 0.02,
        audioNextPlaybackTime
    );

    audioNextPlaybackTime =
        quando + buffer.duration;

    audioSourcesEleven.add(source);

    source.onended = () => {
        audioSourcesEleven.delete(source);
    };

    source.start(quando);

    vozFalando = true;

    atualizarEstadoVoz(
        'falando',
        'Iana está falando...'
    );
}


/* ================================================================
   SOCKET DE VOZ
================================================================ */

function garantirSocketVoz() {
    if (vozSocket?.connected) {
        return vozSocket;
    }

    if (typeof io !== 'function') {
        atualizarEstadoVoz(
            'processando',
            'Socket de voz indisponível.'
        );

        return null;
    }

    if (vozSocketConectando) {
        return vozSocket;
    }

    vozSocketConectando = true;

    try {
        vozSocket = io({
            transports: ['websocket', 'polling'],
            withCredentials: true
        });
    } catch (erro) {
        vozSocketConectando = false;

        console.error(
            '[IANA VOZ] Socket:',
            erro
        );

        return null;
    }

    vozSocket.on('connect', async () => {
        vozSocketConectando = false;

        console.log(
            '[IANA VOZ] Socket conectado:',
            vozSocket.id
        );

        await garantirAudioElevenAtivo();

        try {
            vozSocket.emit('voz:iniciar');
        } catch (erro) {
            console.error(
                '[IANA VOZ] voz:iniciar:',
                erro
            );
        }
    });


    vozSocket.on('voz:pronto', () => {
        if (
            emChamadaVoz &&
            !vozFalando &&
            !vozProcessando &&
            !window._vozMutado
        ) {
            atualizarEstadoVoz(
                'ouvindo',
                'Fale com a Iana'
            );

            if (!window._recognitionVoz) {
                iniciarReconhecimentoVoz();
            }
        }
    });


    vozSocket.on('voz:transcricao-iana', dados => {
        const texto = dados?.texto;

        if (typeof texto !== 'string') {
            return;
        }

        const el = obterElemento('voz-transcript');

        if (el) {
            el.textContent = texto;
        }
    });


    vozSocket.on('voz:audio-resposta', dados => {
        tocarAudioEleven(dados?.audio);
    });


    vozSocket.on('voz:fala-finalizada', () => {
        verificarFimAudioVoz();
    });


    vozSocket.on('voz:interrompido', () => {
        pararAudioEleven();

        vozFalando = false;
        vozProcessando = false;

        if (
            emChamadaVoz &&
            !window._vozMutado
        ) {
            atualizarEstadoVoz(
                'ouvindo',
                'Fale com a Iana'
            );

            iniciarReconhecimentoVoz();
        }
    });


    vozSocket.on('voz:erro', dados => {
        console.error(
            '[IANA VOZ]',
            dados?.mensagem || 'Erro desconhecido'
        );

        pararAudioEleven();

        vozFalando = false;
        vozProcessando = false;

        if (emChamadaVoz) {
            atualizarEstadoVoz(
                'processando',
                dados?.mensagem ||
                'Erro no sistema de voz.'
            );
        }
    });


    vozSocket.on('disconnect', motivo => {
        vozSocketConectando = false;

        console.warn(
            '[IANA VOZ] Socket desconectado:',
            motivo
        );

        if (emChamadaVoz) {
            pararReconhecimentoVoz();

            atualizarEstadoVoz(
                'processando',
                'Reconectando a Iana...'
            );
        }
    });


    vozSocket.on('connect_error', erro => {
        vozSocketConectando = false;

        console.error(
            '[IANA VOZ] Falha de conexão:',
            erro?.message || erro
        );

        if (emChamadaVoz) {
            atualizarEstadoVoz(
                'processando',
                'Não foi possível conectar à voz.'
            );
        }
    });

    return vozSocket;
}


function verificarFimAudioVoz() {
    const verificar = () => {
        if (!emChamadaVoz) {
            return;
        }

        if (window._vozMutado) {
            return;
        }

        if (audioSourcesEleven.size === 0) {
            vozFalando = false;
            vozProcessando = false;

            atualizarEstadoVoz(
                'ouvindo',
                'Fale com a Iana'
            );

            if (!window._recognitionVoz) {
                iniciarReconhecimentoVoz();
            }

            return;
        }

        setTimeout(verificar, 100);
    };

    setTimeout(verificar, 100);
}


/* ================================================================
   TELAS / AUTENTICAÇÃO
================================================================ */

function mostrarTela(id) {
    const overlay = obterElemento('overlay-auth');

    if (!overlay) {
        return;
    }

    TELAS.forEach(tela => {
        const elemento = obterElemento(tela);

        if (!elemento) {
            return;
        }

        elemento.style.display =
            tela === id
                ? 'block'
                : 'none';
    });

    overlay.style.display = 'flex';
}


function fecharAuth() {
    const overlay = obterElemento('overlay-auth');

    if (overlay) {
        overlay.style.display = 'none';
    }
}


/* ================================================================
   CÂMERA
================================================================ */

async function abrirCamera() {
    const overlay = obterElemento('overlay-camera');
    const preview = obterElemento('camera-preview');

    if (!overlay || !preview) {
        return;
    }

    if (!possuiMediaDevices()) {
        alert(
            'Seu navegador não suporta acesso à câmera.'
        );
        return;
    }

    try {
        if (streamCamera) {
            streamCamera
                .getTracks()
                .forEach(track => track.stop());
        }

        streamCamera =
            await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'user'
                },
                audio: false
            });

        preview.srcObject = streamCamera;

        try {
            await preview.play();
        } catch {}

        overlay.style.display = 'flex';

    } catch (erro) {
        console.error(
            '[IANA CÂMERA]',
            erro
        );

        alert(
            'Não foi possível acessar a câmera: ' +
            (erro.message || 'permissão negada.')
        );
    }
}


function fecharCamera() {
    const overlay = obterElemento('overlay-camera');
    const preview = obterElemento('camera-preview');

    if (streamCamera) {
        streamCamera
            .getTracks()
            .forEach(track => track.stop());

        streamCamera = null;
    }

    if (preview) {
        preview.srcObject = null;
    }

    if (overlay) {
        overlay.style.display = 'none';
    }
}


async function capturarFoto() {
    const preview = obterElemento('camera-preview');

    if (
        !preview ||
        !preview.videoWidth ||
        !preview.videoHeight
    ) {
        alert(
            'A câmera ainda não está pronta.'
        );
        return;
    }

    try {
        const canvas =
            document.createElement('canvas');

        canvas.width = preview.videoWidth;
        canvas.height = preview.videoHeight;

        const ctx =
            canvas.getContext('2d');

        if (!ctx) {
            throw new Error(
                'Não foi possível criar a imagem.'
            );
        }

        ctx.drawImage(
            preview,
            0,
            0,
            canvas.width,
            canvas.height
        );

        const dataUrl =
            canvas.toDataURL(
                'image/jpeg',
                0.90
            );

        adicionarImagemUsuario(
            dataUrl,
            'foto-camera.jpg'
        );

        fecharCamera();

        await processarEnvioIA(
            '[Usuário enviou uma foto capturada pela câmera.]',
            {
                tipo: 'imagem',
                imagem: dataUrl,
                nome: 'foto-camera.jpg',
                mimeType: 'image/jpeg'
            }
        );

    } catch (erro) {
        console.error(
            '[IANA CÂMERA]',
            erro
        );

        alert(
            'Não foi possível capturar a foto.'
        );
    }
}


/* ================================================================
   VOICE MODE
================================================================ */

function atualizarEstadoVoz(estado, texto) {
    const overlay = obterElemento('overlay-voz');
    const status = obterElemento('voz-status');

    if (!overlay) {
        return;
    }

    overlay.classList.remove(
        'iana-voz-ouvindo',
        'iana-voz-processando',
        'iana-voz-falando'
    );

    if (estado === 'ouvindo') {
        overlay.classList.add(
            'iana-voz-ouvindo'
        );
    }

    if (estado === 'processando') {
        overlay.classList.add(
            'iana-voz-processando'
        );
    }

    if (estado === 'falando') {
        overlay.classList.add(
            'iana-voz-falando'
        );
    }

    if (status && texto) {
        status.textContent = texto;
    }

    if (window.IanaHUD?.setEstado) {
        try {
            window.IanaHUD.setEstado(estado);
        } catch {}
    }
}


async function abrirVoz() {
    const overlay = obterElemento('overlay-voz');

    if (!overlay) {
        return;
    }

    overlay.style.display = 'flex';

    emChamadaVoz = true;
    vozProcessando = false;
    vozFalando = false;
    vozInicializando = false;

    window._vozMutado = false;

    limparFeedVoz();

    definirTexto(
        'voz-transcript',
        ''
    );

    definirTexto(
        'voz-interim',
        ''
    );

    atualizarEstadoVoz(
        'ouvindo',
        'Fale com a Iana'
    );

    try {
        await garantirAudioElevenAtivo();
    } catch {}

    iniciarVisualizacaoAudio();

    const socket = garantirSocketVoz();

    if (!socket) {
        atualizarEstadoVoz(
            'processando',
            'Não foi possível iniciar a voz.'
        );
        return;
    }

    if (socket.connected) {
        iniciarReconhecimentoVoz();
    }
}


function fecharVoz() {
    const overlay = obterElemento('overlay-voz');

    emChamadaVoz = false;
    vozProcessando = false;
    vozFalando = false;
    vozInicializando = false;

    ttsNextResponse = false;

    window._vozMutado = false;

    pararReconhecimentoVoz();

    if (overlay) {
        overlay.style.display = 'none';

        overlay.classList.remove(
            'iana-voz-ouvindo',
            'iana-voz-processando',
            'iana-voz-falando'
        );
    }

    if (typeof speechSynthesis !== 'undefined') {
        speechSynthesis.cancel();
    }

    if (vozSocket) {
        try {
            vozSocket.emit('voz:encerrar');
        } catch {}

        try {
            vozSocket.disconnect();
        } catch {}

        vozSocket = null;
    }

    vozSocketConectando = false;

    pararAudioEleven();

    if (audioCtxEleven) {
        audioCtxEleven
            .close()
            .catch(() => {});

        audioCtxEleven = null;
    }

    pararVisualizacaoAudio();

    definirTexto(
        'voz-transcript',
        ''
    );

    definirTexto(
        'voz-interim',
        ''
    );

    const mute = obterElemento(
        'btn-voz-mute'
    );

    if (mute) {
        mute.classList.remove('mutado');
        mute.textContent = '🎙️';
    }

    if (window.IanaHUD?.setEstado) {
        try {
            window.IanaHUD.setEstado('ocioso');
        } catch {}
    }
}


/* ================================================================
   VISUALIZAÇÃO DO MICROFONE
================================================================ */

async function iniciarVisualizacaoAudio() {
    if (!possuiMediaDevices()) {
        return;
    }

    try {
        pararVisualizacaoAudio();

        streamAudioVozBars =
            await navigator.mediaDevices.getUserMedia({
                audio: true
            });

        const AudioContextClass =
            window.AudioContext ||
            window.webkitAudioContext;

        if (!AudioContextClass) {
            return;
        }

        audioCtxVoz =
            new AudioContextClass();

        const source =
            audioCtxVoz.createMediaStreamSource(
                streamAudioVozBars
            );

        analyserVoz =
            audioCtxVoz.createAnalyser();

        analyserVoz.fftSize = 32;

        source.connect(analyserVoz);

        if (audioCtxVoz.state === 'suspended') {
            await audioCtxVoz.resume();
        }

        loopVisualizacaoAudio();

    } catch (erro) {
        console.warn(
            '[IANA MICROFONE]',
            erro?.message || erro
        );
    }
}


function loopVisualizacaoAudio() {
    if (!analyserVoz) {
        return;
    }

    const dados =
        new Uint8Array(
            analyserVoz.frequencyBinCount
        );

    analyserVoz.getByteFrequencyData(
        dados
    );

    const media =
        dados.length
            ? dados.reduce(
                (total, valor) =>
                    total + valor,
                0
            ) / dados.length
            : 0;

    const nivel =
        Math.min(
            1,
            media / 90
        );

    document
        .querySelectorAll('.jarvis-bars')
        .forEach(bars => {
            bars.style.setProperty(
                '--nivel',
                nivel.toFixed(2)
            );
        });

    rafVozId =
        requestAnimationFrame(
            loopVisualizacaoAudio
        );
}


function pararVisualizacaoAudio() {
    if (rafVozId) {
        cancelAnimationFrame(rafVozId);
    }

    rafVozId = null;

    if (streamAudioVozBars) {
        streamAudioVozBars
            .getTracks()
            .forEach(track => track.stop());

        streamAudioVozBars = null;
    }

    if (audioCtxVoz) {
        audioCtxVoz
            .close()
            .catch(() => {});

        audioCtxVoz = null;
    }

    analyserVoz = null;
}


/* ================================================================
   SPEECH RECOGNITION
================================================================ */

function pararReconhecimentoVoz() {
    const rec =
        window._recognitionVoz;

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
    const SpeechRecognition =
        window.SpeechRecognition ||
        window.webkitSpeechRecognition;

    if (
        !emChamadaVoz ||
        window._vozMutado ||
        vozFalando ||
        vozProcessando
    ) {
        return;
    }

    if (!SpeechRecognition) {
        atualizarEstadoVoz(
            'processando',
            'Reconhecimento de voz não é suportado neste navegador.'
        );
        return;
    }

    if (
        window._recognitionVoz ||
        vozInicializando
    ) {
        return;
    }

    vozInicializando = true;

    const transcriptEl =
        obterElemento('voz-transcript');

    const interimEl =
        obterElemento('voz-interim');

    const rec =
        new SpeechRecognition();

    rec.lang = 'pt-BR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    window._recognitionVoz = rec;


    rec.onstart = () => {
        vozInicializando = false;

        if (
            emChamadaVoz &&
            !vozFalando &&
            !vozProcessando
        ) {
            atualizarEstadoVoz(
                'ouvindo',
                'Fale sua pergunta'
            );
        }
    };


    rec.onresult = event => {
        let textoFinal = '';
        let textoInterim = '';

        for (
            let i = event.resultIndex;
            i < event.results.length;
            i++
        ) {
            const resultado =
                event.results[i];

            const texto =
                resultado[0]?.transcript || '';

            if (resultado.isFinal) {
                textoFinal += texto;
            } else {
                textoInterim += texto;
            }
        }

        if (transcriptEl) {
            transcriptEl.textContent =
                textoInterim ||
                textoFinal;
        }

        if (interimEl) {
            interimEl.textContent =
                textoInterim;
        }

        if (
            !textoFinal.trim() ||
            vozProcessando ||
            vozFalando
        ) {
            return;
        }

        const texto =
            textoFinal.trim();

        vozProcessando = true;

        if (interimEl) {
            interimEl.textContent = '';
        }

        atualizarEstadoVoz(
            'processando',
            'Iana está pensando...'
        );

        pararReconhecimentoVoz();

        const socket =
            garantirSocketVoz();

        if (!socket) {
            vozProcessando = false;

            atualizarEstadoVoz(
                'processando',
                'Socket de voz indisponível.'
            );

            return;
        }

        const enviar = () => {
            if (
                emChamadaVoz &&
                !window._vozMutado &&
                socket.connected
            ) {
                socket.emit(
                    'voz:texto',
                    texto
                );
            }
        };

        if (socket.connected) {
            enviar();
        } else {
            socket.once(
                'connect',
                enviar
            );
        }
    };


    rec.onerror = event => {
        vozInicializando = false;

        console.warn(
            '[IANA SPEECH]',
            event?.error
        );

        if (!emChamadaVoz) {
            return;
        }

        window._recognitionVoz = null;

        if (
            event.error === 'not-allowed' ||
            event.error === 'service-not-allowed'
        ) {
            atualizarEstadoVoz(
                'processando',
                'Permissão de microfone negada.'
            );
            return;
        }

        if (
            !vozProcessando &&
            !vozFalando &&
            !window._vozMutado
        ) {
            atualizarEstadoVoz(
                'ouvindo',
                'Reconectando ao microfone...'
            );
        }
    };


    rec.onend = () => {
        vozInicializando = false;

        if (
            window._recognitionVoz === rec
        ) {
            window._recognitionVoz = null;
        }

        if (
            emChamadaVoz &&
            !window._vozMutado &&
            !vozFalando &&
            !vozProcessando
        ) {
            setTimeout(() => {
                if (
                    emChamadaVoz &&
                    !window._vozMutado &&
                    !vozFalando &&
                    !vozProcessando &&
                    !window._recognitionVoz
                ) {
                    iniciarReconhecimentoVoz();
                }
            }, 300);
        }
    };


    try {
        rec.start();
    } catch (erro) {
        vozInicializando = false;
        window._recognitionVoz = null;

        console.warn(
            '[IANA SPEECH]',
            erro?.message || erro
        );
    }
}


function toggleMuteVoz() {
    const btn =
        obterElemento('btn-voz-mute');

    const atualmenteMutado =
        Boolean(window._vozMutado);

    if (!atualmenteMutado) {
        pararReconhecimentoVoz();

        window._vozMutado = true;

        btn?.classList.add('mutado');

        if (btn) {
            btn.textContent = '🔇';
        }

        atualizarEstadoVoz(
            'processando',
            'Microfone desativado'
        );

        return;
    }

    window._vozMutado = false;

    btn?.classList.remove('mutado');

    if (btn) {
        btn.textContent = '🎙️';
    }

    if (
        emChamadaVoz &&
        !vozFalando &&
        !vozProcessando
    ) {
        atualizarEstadoVoz(
            'ouvindo',
            'Fale com a Iana'
        );

        iniciarReconhecimentoVoz();
    }
}


/* ================================================================
   FEED DO VOICE MODE
================================================================ */

function limparFeedVoz() {
    const transcript =
        obterElemento('voz-transcript');

    const interim =
        obterElemento('voz-interim');

    if (transcript) {
        transcript.textContent = '';
    }

    if (interim) {
        interim.textContent = '';
    }
}


/* ================================================================
   UPLOAD
================================================================ */

function iniciarMenuUpload() {
    if (menuUploadInicializado) {
        return;
    }

    const btnMais =
        obterElemento('btn-mais');

    const menu =
        obterElemento('upload-menu');

    const fileInput =
        obterElemento('file-input');

    if (!btnMais || !menu) {
        return;
    }

    menuUploadInicializado = true;

    btnMais.addEventListener(
        'click',
        event => {
            event.stopPropagation();

            const rect =
                btnMais.getBoundingClientRect();

            const aberto =
                menu.style.display === 'flex';

            if (!aberto) {
                menu.style.display = 'flex';

                const altura =
                    menu.offsetHeight || 200;

                let left = rect.left;
                let top =
                    rect.top -
                    altura -
                    8;

                if (
                    left + menu.offsetWidth >
                    window.innerWidth - 8
                ) {
                    left =
                        window.innerWidth -
                        menu.offsetWidth -
                        8;
                }

                if (top < 8) {
                    top =
                        rect.bottom + 8;
                }

                menu.style.left =
                    `${Math.max(8, left)}px`;

                menu.style.top =
                    `${Math.max(8, top)}px`;

            } else {
                menu.style.display = 'none';
            }
        }
    );


    document.addEventListener(
        'click',
        () => {
            menu.style.display = 'none';
        }
    );


    menu.addEventListener(
        'click',
        event => {
            event.stopPropagation();
        }
    );


    obterElemento('up-foto')
        ?.addEventListener(
            'click',
            () => {
                menu.style.display = 'none';
                abrirCamera();
            }
        );


    obterElemento('up-imagem')
        ?.addEventListener(
            'click',
            () => {
                menu.style.display = 'none';

                if (fileInput) {
                    fileInput.accept =
                        'image/*';

                    fileInput.click();
                }
            }
        );


    obterElemento('up-arquivo')
        ?.addEventListener(
            'click',
            () => {
                menu.style.display = 'none';

                if (fileInput) {
                    fileInput.accept =
                        '.pdf,.txt,.doc,.docx';

                    fileInput.click();
                }
            }
        );


    obterElemento('up-audio')
        ?.addEventListener(
            'click',
            () => {
                menu.style.display = 'none';

                if (fileInput) {
                    fileInput.accept =
                        'audio/*';

                    fileInput.click();
                }
            }
        );


    obterElemento('up-tela')
        ?.addEventListener(
            'click',
            () => {
                menu.style.display = 'none';

                compartilharTela();
            }
        );
}


function iniciarUpload() {
    if (uploadInicializado) {
        return;
    }

    const fileInput =
        obterElemento('file-input');

    if (!fileInput) {
        return;
    }

    uploadInicializado = true;

    fileInput.addEventListener(
        'change',
        async () => {
            const file =
                fileInput.files?.[0];

            if (!file) {
                return;
            }

            try {
                if (
                    file.type.startsWith(
                        'image/'
                    )
                ) {
                    const dataUrl =
                        await arquivoParaDataURL(
                            file
                        );

                    adicionarImagemUsuario(
                        dataUrl,
                        file.name
                    );

                    await processarEnvioIA(
                        `[Usuário enviou uma imagem: ${file.name}]`,
                        {
                            tipo: 'imagem',
                            imagem: dataUrl,
                            nome: file.name,
                            mimeType: file.type
                        }
                    );

                    return;
                }


                if (
                    file.type.startsWith(
                        'audio/'
                    )
                ) {
                    await processarEnvioIA(
                        `[Usuário enviou um áudio: ${file.name}]`,
                        {
                            tipo: 'audio',
                            nome: file.name,
                            mimeType: file.type
                        }
                    );

                    return;
                }


                if (
                    file.type ===
                    'text/plain' ||
                    file.name
                        .toLowerCase()
                        .endsWith('.txt')
                ) {
                    const texto =
                        await file.text();

                    const limitado =
                        texto.slice(0, 12000);

                    await processarEnvioIA(
                        `[Usuário enviou o arquivo "${file.name}".]\n\nConteúdo:\n${limitado}`,
                        {
                            tipo: 'arquivo',
                            nome: file.name,
                            mimeType: file.type
                        }
                    );

                    return;
                }


                await processarEnvioIA(
                    `[Usuário enviou um arquivo: ${file.name}]`,
                    {
                        tipo: 'arquivo',
                        nome: file.name,
                        mimeType: file.type
                    }
                );

            } catch (erro) {
                console.error(
                    '[IANA UPLOAD]',
                    erro
                );

                alert(
                    'Não foi possível processar o arquivo.'
                );

            } finally {
                fileInput.value = '';
            }
        }
    );
}


/* ================================================================
   COMPARTILHAMENTO DE TELA
================================================================ */

async function compartilharTela() {
    if (
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getDisplayMedia !== 'function'
    ) {
        alert(
            'Seu navegador não suporta compartilhamento de tela.'
        );
        return;
    }

    let stream = null;

    try {
        stream =
            await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: false
            });

        const track =
            stream.getVideoTracks()[0];

        if (track) {
            track.addEventListener(
                'ended',
                () => {
                    window._telaCompartilhada = false;
                }
            );
        }

        window._telaCompartilhada = true;

        /*
           Atualmente enviamos somente a informação
           de que a tela foi compartilhada.

           Para enviar uma captura real ao backend,
           seria necessário capturar um frame do stream.
        */

        await processarEnvioIA(
            '[Usuário compartilhou a tela.]'
        );

    } catch (erro) {
        if (
            erro?.name !== 'NotAllowedError'
        ) {
            console.error(
                '[IANA TELA]',
                erro
            );

            alert(
                'Erro ao compartilhar tela: ' +
                (erro.message || '')
            );
        }

    } finally {
        if (stream) {
            stream
                .getTracks()
                .forEach(track => track.stop());
        }

        window._telaCompartilhada = false;
    }
}


/* ================================================================
   GRAVAÇÃO DE ÁUDIO
================================================================ */

function iniciarGravacaoAudio() {
    if (gravacaoInicializada) {
        return;
    }

    const btn =
        obterElemento('btn-mic');

    if (!btn) {
        return;
    }

    gravacaoInicializada = true;

    btn.addEventListener(
        'click',
        async () => {
            if (!gravandoAudio) {
                try {
                    if (!possuiMediaDevices()) {
                        throw new Error(
                            'Seu navegador não suporta microfone.'
                        );
                    }

                    const stream =
                        await navigator.mediaDevices.getUserMedia({
                            audio: true
                        });

                    const mimeType =
                        MediaRecorder.isTypeSupported(
                            'audio/webm;codecs=opus'
                        )
                            ? 'audio/webm;codecs=opus'
                            : 'audio/webm';

                    mediaRecorderAudio =
                        new MediaRecorder(
                            stream,
                            { mimeType }
                        );

                    audioChunks = [];

                    mediaRecorderAudio.ondataavailable =
                        event => {
                            if (
                                event.data &&
                                event.data.size > 0
                            ) {
                                audioChunks.push(
                                    event.data
                                );
                            }
                        };


                    mediaRecorderAudio.onstop =
                        async () => {
                            stream
                                .getTracks()
                                .forEach(
                                    track =>
                                        track.stop()
                                );

                            const blob =
                                new Blob(
                                    audioChunks,
                                    {
                                        type: mimeType
                                    }
                                );

                            audioChunks = [];

                            /*
                               Cria DataURL para que o áudio
                               possa ser enviado ao backend.
                            */

                            try {
                                const dataUrl =
                                    await blobParaDataURL(
                                        blob
                                    );

                                await processarEnvioIA(
                                    '[Usuário enviou um áudio gravado.]',
                                    {
                                        tipo: 'audio',
                                        audio: dataUrl,
                                        nome: 'gravacao.webm',
                                        mimeType
                                    }
                                );
                            } catch (erro) {
                                console.error(
                                    '[IANA ÁUDIO]',
                                    erro
                                );
                            }
                        };


                    mediaRecorderAudio.start();

                    gravandoAudio = true;

                    btn.classList.add(
                        'gravando'
                    );

                    btn.title =
                        'Parar gravação';

                } catch (erro) {
                    console.error(
                        '[IANA MICROFONE]',
                        erro
                    );

                    alert(
                        'Não foi possível acessar o microfone: ' +
                        (erro.message || '')
                    );
                }

            } else {
                if (
                    mediaRecorderAudio &&
                    mediaRecorderAudio.state !==
                    'inactive'
                ) {
                    mediaRecorderAudio.stop();
                }

                gravandoAudio = false;

                btn.classList.remove(
                    'gravando'
                );

                btn.title =
                    'Gravar áudio';
            }
        }
    );
}


function blobParaDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader =
            new FileReader();

        reader.onload =
            () => resolve(reader.result);

        reader.onerror =
            () => reject(
                new Error(
                    'Não foi possível ler o áudio.'
                )
            );

        reader.readAsDataURL(blob);
    });
}


/* ================================================================
   AUTENTICAÇÃO
================================================================ */

async function verificarSessao() {
    try {
        const res =
            await fetch(
                '/auth/me',
                {
                    credentials: 'include'
                }
            );

        if (!res.ok) {
            atualizarUIVisitante();
            return;
        }

        const data =
            await res.json();

        if (data.logado) {
            atualizarUILogado(
                data.usuario
            );
        } else {
            atualizarUIVisitante();
        }

    } catch {
        atualizarUIVisitante();
    }
}


function atualizarUIVisitante() {
    usuarioAtual = null;

    document.body.classList.add(
        'visitante'
    );

    document.body.classList.remove(
        'logado'
    );

    const authButtons =
        obterElemento('auth-buttons');

    const footer =
        obterElemento('sidebar-footer');

    if (authButtons) {
        authButtons.style.display =
            'flex';
    }

    if (footer) {
        footer.style.display =
            'none';
    }

    definirTexto(
        'historico-hint',
        'Faça login para salvar conversas.'
    );

    const lista =
        obterElemento('historico-lista');

    if (lista) {
        lista.innerHTML =
            '<p class="sidebar-hint">Faça login para salvar conversas.</p>';
    }
}


function atualizarUILogado(usuario) {
    usuarioAtual = usuario;

    document.body.classList.add(
        'logado'
    );

    document.body.classList.remove(
        'visitante'
    );

    const authButtons =
        obterElemento('auth-buttons');

    const footer =
        obterElemento('sidebar-footer');

    if (authButtons) {
        authButtons.style.display =
            'none';
    }

    if (footer) {
        footer.style.display =
            'block';
    }

    definirTexto(
        'user-nome-sidebar',
        usuario?.nome || 'Usuário'
    );

    const topAvatar =
        obterElemento(
            'topbar-profile-avatar'
        );

    if (
        topAvatar &&
        usuario?.avatar
    ) {
        topAvatar.src =
            usuario.avatar;
    }

    carregarHistorico();
}


function mensagemErroAuth(
    msg,
    fallback = 'Erro inesperado.'
) {
    const texto =
        String(msg || '')
            .toLowerCase();

    if (
        texto.includes(
            'já cadastrado'
        )
    ) {
        return 'Este e-mail já está cadastrado.';
    }

    if (
        texto.includes(
            'inválidas'
        ) ||
        texto.includes(
            'invalid'
        )
    ) {
        return 'E-mail ou senha inválidos.';
    }

    if (
        texto.includes(
            'mínima'
        ) ||
        texto.includes(
            'minimo'
        )
    ) {
        return 'Senha muito curta (mínimo 8 caracteres).';
    }

    return msg || fallback;
}


function mostrarErroTela(id, msg) {
    const el =
        obterElemento(id);

    if (el) {
        el.textContent =
            String(msg || '');
    }
}


async function realizarLogin() {
    const email =
        obterElemento('login-email')
            ?.value
            .trim();

    const senha =
        obterElemento('login-senha')
            ?.value;

    if (!email || !senha) {
        mostrarErroTela(
            'login-erro',
            'Preencha e-mail e senha.'
        );
        return;
    }

    const btn =
        obterElemento('btn-login');

    const original =
        btn?.textContent ||
        'Entrar';

    if (btn) {
        btn.textContent =
            'Entrando...';

        btn.disabled = true;
    }

    try {
        const res =
            await fetch(
                '/auth/login',
                {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type':
                            'application/json'
                    },
                    body: JSON.stringify({
                        email,
                        senha
                    })
                }
            );

        const data =
            await res.json();

        if (!res.ok) {
            mostrarErroTela(
                'login-erro',
                mensagemErroAuth(
                    data.erro,
                    'Falha no login.'
                )
            );

            return;
        }

        fecharAuth();

        atualizarUILogado(
            data.usuario
        );

    } catch {
        mostrarErroTela(
            'login-erro',
            'Erro de conexão.'
        );

    } finally {
        if (btn) {
            btn.textContent =
                original;

            btn.disabled =
                false;
        }
    }
}


async function realizarCadastro() {
    const nome =
        obterElemento('cad-nome')
            ?.value
            .trim();

    const email =
        obterElemento('cad-email')
            ?.value
            .trim();

    const senha =
        obterElemento('cad-senha')
            ?.value;

    if (!nome || !email || !senha) {
        mostrarErroTela(
            'cad-erro',
            'Preencha todos os campos.'
        );
        return;
    }

    const btn =
        obterElemento('btn-cadastrar');

    const original =
        btn?.textContent ||
        'Cadastrar';

    if (btn) {
        btn.textContent =
            'Criando...';

        btn.disabled = true;
    }

    try {
        const res =
            await fetch(
                '/auth/registro',
                {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type':
                            'application/json'
                    },
                    body: JSON.stringify({
                        nome,
                        email,
                        senha
                    })
                }
            );

        const data =
            await res.json();

        if (!res.ok) {
            mostrarErroTela(
                'cad-erro',
                mensagemErroAuth(
                    data.erro,
                    'Falha no cadastro.'
                )
            );

            return;
        }

        fecharAuth();

        atualizarUILogado(
            data.usuario
        );

    } catch {
        mostrarErroTela(
            'cad-erro',
            'Erro de conexão.'
        );

    } finally {
        if (btn) {
            btn.textContent =
                original;

            btn.disabled =
                false;
        }
    }
}


async function realizarLogout() {
    try {
        await fetch(
            '/auth/logout',
            {
                method: 'POST',
                credentials: 'include'
            }
        );
    } catch {}

    atualizarUIVisitante();

    resetarChat();
}


async function enviarCodigoRecuperacao() {
    const email =
        obterElemento('esq-email')
            ?.value
            .trim();

    if (!email) {
        mostrarErroTela(
            'esq-erro',
            'Digite seu e-mail.'
        );
        return;
    }

    mostrarErroTela(
        'esq-erro',
        ''
    );

    try {
        const res =
            await fetch(
                '/auth/esqueci-senha',
                {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type':
                            'application/json'
                    },
                    body: JSON.stringify({
                        email
                    })
                }
            );

        const data =
            await res.json();

        if (!res.ok) {
            mostrarErroTela(
                'esq-erro',
                mensagemErroAuth(
                    data.erro,
                    'Não foi possível enviar o código.'
                )
            );

            return;
        }

        emailRecuperacao =
            email;

        definirTexto(
            'cod-label',
            `Código enviado para ${email}`
        );

        mostrarTela(
            'tela-codigo'
        );

    } catch {
        mostrarErroTela(
            'esq-erro',
            'Erro de conexão.'
        );
    }
}


async function alterarSenha() {
    const codigo =
        obterElemento('cod-input')
            ?.value
            .trim();

    const novaSenha =
        obterElemento('cod-nova-senha')
            ?.value;

    if (!codigo || !novaSenha) {
        mostrarErroTela(
            'cod-erro',
            'Preencha o código e a nova senha.'
        );
        return;
    }

    try {
        const res =
            await fetch(
                '/auth/mudar-senha',
                {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type':
                            'application/json'
                    },
                    body: JSON.stringify({
                        email:
                            emailRecuperacao,
                        codigo,
                        nova_senha:
                            novaSenha
                    })
                }
            );

        const data =
            await res.json();

        if (!res.ok) {
            mostrarErroTela(
                'cod-erro',
                mensagemErroAuth(
                    data.erro,
                    'Código inválido.'
                )
            );

            return;
        }

        alert(
            'Senha alterada! Faça login.'
        );

        mostrarTela(
            'tela-login'
        );

    } catch {
        mostrarErroTela(
            'cod-erro',
            'Erro de conexão.'
        );
    }
}


/* ================================================================
   HISTÓRICO
================================================================ */

async function carregarHistorico() {
    const lista =
        obterElemento('historico-lista');

    if (!lista || !usuarioAtual) {
        return;
    }

    lista.innerHTML =
        '<p class="sidebar-hint">Carregando conversas...</p>';

    try {
        const res =
            await fetch(
                '/conversas',
                {
                    credentials: 'include'
                }
            );

        if (!res.ok) {
            throw new Error(
                'Falha ao carregar histórico.'
            );
        }

        const data =
            await res.json();

        const conversas =
            Array.isArray(data)
                ? data
                : (
                    data.conversas ||
                    data.historico ||
                    []
                );

        renderizarHistorico(
            conversas
        );

    } catch (erro) {
        console.error(
            '[IANA HISTÓRICO]',
            erro
        );

        lista.innerHTML =
            '<p class="sidebar-hint">Não foi possível carregar as conversas.</p>';
    }
}


function renderizarHistorico(conversas) {
    const lista =
        obterElemento('historico-lista');

    if (!lista) {
        return;
    }

    lista.innerHTML = '';

    if (!conversas.length) {
        lista.innerHTML =
            '<p class="sidebar-hint">Nenhuma conversa ainda.</p>';

        return;
    }

    const ordenadas =
        [...conversas].sort(
            (a, b) => {
                const aFixada =
                    Boolean(
                        a.fixada ??
                        a.fixa ??
                        a.pinned
                    );

                const bFixada =
                    Boolean(
                        b.fixada ??
                        b.fixa ??
                        b.pinned
                    );

                if (
                    aFixada !==
                    bFixada
                ) {
                    return bFixada - aFixada;
                }

                return (
                    new Date(
                        b.updatedAt ||
                        b.updated_at ||
                        b.data ||
                        0
                    ) -
                    new Date(
                        a.updatedAt ||
                        a.updated_at ||
                        a.data ||
                        0
                    )
                );
            }
        );

    ordenadas.forEach(conversa => {
        const id =
            conversa.id ??
            conversa._id;

        if (!id) {
            return;
        }

        const titulo =
            conversa.titulo ||
            conversa.nome ||
            conversa.title ||
            'Nova conversa';

        const fixada =
            Boolean(
                conversa.fixada ??
                conversa.fixa ??
                conversa.pinned
            );

        const item =
            document.createElement('div');

        item.className =
            'historico-item';

        item.dataset.id =
            id;

        if (
            String(id) ===
            String(idConversaAtiva)
        ) {
            item.classList.add(
                'ativo'
            );
        }

        item.innerHTML = `
            <button
                type="button"
                class="historico-conversa"
                data-id="${escaparHTML(id)}"
            >
                <span class="historico-titulo">
                    ${escaparHTML(titulo)}
                </span>
            </button>

            <button
                type="button"
                class="historico-menu-btn"
                aria-label="Opções"
                data-menu-id="${escaparHTML(id)}"
            >
                ⋮
            </button>

            <div
                class="historico-acoes"
                data-acoes-id="${escaparHTML(id)}"
                style="display:none"
            >
                <button
                    type="button"
                    data-acao="fixar"
                    data-id="${escaparHTML(id)}"
                >
                    ${fixada ? 'Desafixar' : 'Fixar'}
                </button>

                <button
                    type="button"
                    data-acao="renomear"
                    data-id="${escaparHTML(id)}"
                >
                    Renomear
                </button>

                <button
                    type="button"
                    data-acao="excluir"
                    data-id="${escaparHTML(id)}"
                >
                    Excluir
                </button>
            </div>
        `;

        lista.appendChild(item);
    });


    lista
        .querySelectorAll(
            '.historico-conversa'
        )
        .forEach(btn => {
            btn.addEventListener(
                'click',
                () => {
                    abrirConversa(
                        btn.dataset.id
                    );
                }
            );
        });


    lista
        .querySelectorAll(
            '.historico-menu-btn'
        )
        .forEach(btn => {
            btn.addEventListener(
                'click',
                event => {
                    event.stopPropagation();

                    const id =
                        btn.dataset.menuId;

                    document
                        .querySelectorAll(
                            '.historico-acoes'
                        )
                        .forEach(menu => {
                            if (
                                menu.dataset.acoesId ===
                                id
                            ) {
                                menu.style.display =
                                    menu.style.display ===
                                    'block'
                                        ? 'none'
                                        : 'block';
                            } else {
                                menu.style.display =
                                    'none';
                            }
                        });
                }
            );
        });


    lista
        .querySelectorAll(
            '[data-acao]'
        )
        .forEach(btn => {
            btn.addEventListener(
                'click',
                () => {
                    const acao =
                        btn.dataset.acao;

                    const id =
                        btn.dataset.id;

                    if (acao === 'fixar') {
                        acaoFixar(id);
                    }

                    if (acao === 'renomear') {
                        abrirRenomear(id);
                    }

                    if (acao === 'excluir') {
                        abrirConfirmarExcluir(id);
                    }
                }
            );
        });
}


async function abrirConversa(id) {
    if (!id) {
        return;
    }

    try {
        const res =
            await fetch(
                `/conversas/${encodeURIComponent(id)}`,
                {
                    credentials: 'include'
                }
            );

        if (!res.ok) {
            throw new Error(
                'Não foi possível abrir a conversa.'
            );
        }

        const data =
            await res.json();

        idConversaAtiva =
            data.id ??
            data._id ??
            id;

        renderizarMensagens(
            data.mensagens ||
            data.messages ||
            []
        );

        carregarHistorico();

    } catch (erro) {
        console.error(
            '[IANA CONVERSA]',
            erro
        );

        alert(
            'Não foi possível abrir a conversa.'
        );
    }
}


function renderizarMensagens(mensagens) {
    const container =
        obterElemento('chat-messages') ||
        obterElemento('mensagens');

    if (!container) {
        return;
    }

    container.innerHTML = '';

    mensagens.forEach(mensagem => {
        const papel =
            mensagem.role ||
            mensagem.tipo ||
            mensagem.remetente;

        const texto =
            mensagem.content ??
            mensagem.conteudo ??
            mensagem.texto ??
            '';

        if (
            papel === 'user' ||
            papel === 'usuario'
        ) {
            adicionarMensagemDOM(
                'usuario',
                texto
            );
        } else {
            adicionarMensagemDOM(
                'ia',
                texto
            );
        }
    });

    container.scrollTop =
        container.scrollHeight;
}


function adicionarMensagemDOM(
    tipo,
    texto
) {
    const container =
        obterElemento('chat-messages') ||
        obterElemento('mensagens');

    if (!container) {
        return null;
    }

    const mensagem =
        document.createElement('div');

    mensagem.className =
        tipo === 'usuario'
            ? 'mensagem mensagem-usuario'
            : 'mensagem mensagem-ia';

    mensagem.dataset.role =
        tipo;

    const conteudo =
        document.createElement('div');

    conteudo.className =
        'mensagem-conteudo';

    conteudo.textContent =
        String(texto ?? '');

    mensagem.appendChild(
        conteudo
    );

    container.appendChild(
        mensagem
    );

    container.scrollTop =
        container.scrollHeight;

    return mensagem;
}


function adicionarImagemUsuario(
    dataUrl,
    nome
) {
    const container =
        obterElemento('chat-messages') ||
        obterElemento('mensagens');

    if (!container) {
        return;
    }

    const mensagem =
        document.createElement('div');

    mensagem.className =
        'mensagem mensagem-usuario';

    mensagem.innerHTML = `
        <div class="mensagem-conteudo">
            <img
                src="${escaparHTML(dataUrl)}"
                alt="${escaparHTML(nome || 'Imagem enviada')}"
                style="max-width:320px;max-height:320px;border-radius:12px;object-fit:contain"
            >
        </div>
    `;

    container.appendChild(
        mensagem
    );

    container.scrollTop =
        container.scrollHeight;
}


/* ================================================================
   FIXAR / RENOMEAR / EXCLUIR
================================================================ */

async function acaoFixar(id) {
    if (!id) {
        return;
    }

    try {
        const res =
            await fetch(
                `/conversas/${encodeURIComponent(id)}/fixar`,
                {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type':
                            'application/json'
                    }
                }
            );

        if (!res.ok) {
            throw new Error(
                'Falha ao fixar conversa.'
            );
        }

        await carregarHistorico();

    } catch (erro) {
        console.error(
            '[IANA FIXAR]',
            erro
        );

        alert(
            'Não foi possível alterar a conversa.'
        );
    }
}


function abrirRenomear(id) {
    idConversaRenomear =
        id;

    const input =
        obterElemento(
            'renomear-input'
        );

    if (input) {
        input.value = '';
    }

    mostrarTela(
        'tela-renomear'
    );
}


async function salvarRenomear() {
    if (!idConversaRenomear) {
        return;
    }

    const input =
        obterElemento(
            'renomear-input'
        );

    const titulo =
        input?.value
            ?.trim();

    if (!titulo) {
        mostrarErroTela(
            'renomear-erro',
            'Digite um nome.'
        );

        return;
    }

    try {
        const res =
            await fetch(
                `/conversas/${encodeURIComponent(idConversaRenomear)}`,
                {
                    method: 'PATCH',
                    credentials: 'include',
                    headers: {
                        'Content-Type':
                            'application/json'
                    },
                    body: JSON.stringify({
                        titulo
                    })
                }
            );

        if (!res.ok) {
            throw new Error(
                'Falha ao renomear.'
            );
        }

        idConversaRenomear =
            null;

        fecharAuth();

        await carregarHistorico();

    } catch (erro) {
        console.error(
            '[IANA RENOMEAR]',
            erro
        );

        mostrarErroTela(
            'renomear-erro',
            'Não foi possível renomear a conversa.'
        );
    }
}


function abrirConfirmarExcluir(id) {
    idConversaExcluir =
        id;

    mostrarTela(
        'tela-confirmar'
    );
}


async function confirmarExcluir() {
    if (!idConversaExcluir) {
        return;
    }

    try {
        const res =
            await fetch(
                `/conversas/${encodeURIComponent(idConversaExcluir)}`,
                {
                    method: 'DELETE',
                    credentials: 'include'
                }
            );

        if (!res.ok) {
            throw new Error(
                'Falha ao excluir.'
            );
        }

        if (
            String(idConversaAtiva) ===
            String(idConversaExcluir)
        ) {
            idConversaAtiva =
                null;

            resetarChat();
        }

        idConversaExcluir =
            null;

        fecharAuth();

        await carregarHistorico();

    } catch (erro) {
        console.error(
            '[IANA EXCLUIR]',
            erro
        );

        alert(
            'Não foi possível excluir a conversa.'
        );
    }
}


/* ================================================================
   PESQUISA
================================================================ */

async function pesquisarConversas(termo) {
    const lista =
        obterElemento('historico-lista');

    if (!lista) {
        return;
    }

    const texto =
        String(termo || '')
            .trim()
            .toLowerCase();

    if (!texto) {
        await carregarHistorico();
        return;
    }

    const itens =
        Array.from(
            lista.querySelectorAll(
                '.historico-item'
            )
        );

    itens.forEach(item => {
        const titulo =
            item
                .querySelector(
                    '.historico-titulo'
                )
                ?.textContent
                ?.toLowerCase() || '';

        item.style.display =
            titulo.includes(texto)
                ? ''
                : 'none';
    });
}


/* ================================================================
   CHAT
================================================================ */

function mostrarWelcome(
    forcar = false
) {
    const container =
        obterElemento('chat-messages') ||
        obterElemento('mensagens');

    if (!container) {
        return;
    }

    if (
        !forcar &&
        container.children.length
    ) {
        return;
    }

    container.innerHTML = `
        <div class="iana-welcome">
            <div class="iana-welcome-content">
                <h1>Olá! Eu sou a Iana.</h1>
                <p>Como posso ajudar você hoje?</p>
            </div>
        </div>
    `;
}


function mostrarIndicadorDigitando() {
    removerIndicadorDigitando();

    const container =
        obterElemento('chat-messages') ||
        obterElemento('mensagens');

    if (!container) {
        return null;
    }

    const elemento =
        document.createElement('div');

    elemento.id =
        'iana-digitando';

    elemento.className =
        'mensagem mensagem-ia mensagem-digitando';

    elemento.innerHTML = `
        <div class="mensagem-conteudo">
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
        </div>
    `;

    container.appendChild(
        elemento
    );

    container.scrollTop =
        container.scrollHeight;

    return elemento;
}


function removerIndicadorDigitando() {
    obterElemento(
        'iana-digitando'
    )?.remove();
}


function atualizarMensagemIA(
    elemento,
    texto
) {
    if (!elemento) {
        return;
    }

    const conteudo =
        elemento.querySelector(
            '.mensagem-conteudo'
        );

    if (conteudo) {
        conteudo.textContent =
            String(texto ?? '');
    }
}


async function processarEnvioIA(
    mensagem,
    anexo = null
) {
    if (
        aguardandoResposta &&
        !emChamadaVoz
    ) {
        return;
    }

    const texto =
        String(mensagem || '')
            .trim();

    if (!texto && !anexo) {
        return;
    }

    if (!emChamadaVoz) {
        aguardandoResposta =
            true;

        atualizarBotoesChat(
            true
        );

        adicionarMensagemDOM(
            'usuario',
            texto
        );

        removerWelcome();

        mostrarIndicadorDigitando();
    }

    controller =
        new AbortController();

    try {
        const configPrompt =
            montarConfigPrompt();

        const payload = {
            mensagem: texto,
            message: texto,
            conversa_id:
                idConversaAtiva,
            id_conversa:
                idConversaAtiva,
            config:
                configPrompt,
            configuracao:
                configPrompt,
            // FIX: features.js expõe detectarEstadoEmocional() mas
            // ninguém chamava — o servidor tinha só o fallback dele
            // (detectarHumor), sem o estado "frustrado" que só o
            // features.js detecta.
            estadoEmocional:
                typeof detectarEstadoEmocional === 'function'
                    ? detectarEstadoEmocional(texto)
                    : undefined
        };

        if (anexo) {
            Object.assign(
                payload,
                anexo
            );
        }

        const res =
            await fetch(
                '/chat',
                {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type':
                            'application/json'
                    },
                    body:
                        JSON.stringify(
                            payload
                        ),
                    signal:
                        controller.signal
                }
            );

        if (!res.ok) {
            let erro = null;

            try {
                erro =
                    await res.json();
            } catch {}

            throw new Error(
                erro?.erro ||
                erro?.error ||
                `Erro HTTP ${res.status}`
            );
        }

        /*
           O backend pode retornar JSON.
        */

        const contentType =
            res.headers.get(
                'content-type'
            ) || '';

        if (
            contentType.includes(
                'application/json'
            )
        ) {
            const data =
                await res.json();

            const resposta =
                data.resposta ??
                data.response ??
                data.mensagem ??
                data.content ??
                '';

            if (data.conversa_id) {
                idConversaAtiva =
                    data.conversa_id;
            }

            if (data.id_conversa) {
                idConversaAtiva =
                    data.id_conversa;
            }

            if (emChamadaVoz) {
                finalizarRespostaVoz(
                    resposta
                );

                return;
            }

            removerIndicadorDigitando();

            const mensagemIA =
                adicionarMensagemDOM(
                    'ia',
                    resposta
                );

            if (
                ttsNextResponse &&
                resposta
            ) {
                ttsNextResponse =
                    false;

                await falar(
                    resposta
                );
            }

            if (data.conversa) {
                idConversaAtiva =
                    data.conversa.id ??
                    data.conversa._id ??
                    idConversaAtiva;
            }

            if (usuarioAtual) {
                carregarHistorico();
            }

            return;
        }

        /*
           Fallback para resposta em texto.
        */

        const resposta =
            await res.text();

        if (emChamadaVoz) {
            finalizarRespostaVoz(
                resposta
            );

            return;
        }

        removerIndicadorDigitando();

        adicionarMensagemDOM(
            'ia',
            resposta
        );

        if (
            ttsNextResponse &&
            resposta
        ) {
            ttsNextResponse =
                false;

            await falar(
                resposta
            );
        }

    } catch (erro) {
        if (
            erro?.name ===
            'AbortError'
        ) {
            return;
        }

        console.error(
            '[IANA CHAT]',
            erro
        );

        removerIndicadorDigitando();

        if (emChamadaVoz) {
            finalizarRespostaVoz(
                'Não consegui processar sua solicitação.'
            );
        } else {
            adicionarMensagemDOM(
                'ia',
                'Não foi possível processar sua mensagem. Tente novamente.'
            );
        }

    } finally {
        if (!emChamadaVoz) {
            aguardandoResposta =
                false;

            atualizarBotoesChat(
                false
            );

            controller =
                null;
        }
    }
}


function finalizarRespostaVoz(
    resposta
) {
    vozProcessando =
        false;

    if (
        typeof resposta ===
        'string' &&
        resposta.trim()
    ) {
        definirTexto(
            'voz-transcript',
            resposta
        );
    }

    atualizarEstadoVoz(
        'falando',
        'Iana está falando...'
    );
}


function pararRespostaIA() {
    if (controller) {
        try {
            controller.abort();
        } catch {}
    }

    controller =
        null;

    aguardandoResposta =
        false;

    removerIndicadorDigitando();

    atualizarBotoesChat(
        false
    );
}


function atualizarBotoesChat(
    processando
) {
    const send =
        obterElemento('btn-send');

    const stop =
        obterElemento('btn-stop');

    if (send) {
        send.style.display =
            processando
                ? 'none'
                : '';
    }

    if (stop) {
        stop.style.display =
            processando
                ? ''
                : 'none';
    }
}


function removerWelcome() {
    document
        .querySelectorAll(
            '.iana-welcome'
        )
        .forEach(el =>
            el.remove()
        );
}


async function enviarMensagem() {
    const input =
        obterElemento('chat-input');

    if (
        !input ||
        aguardandoResposta
    ) {
        return;
    }

    const mensagem =
        input.value.trim();

    if (!mensagem) {
        return;
    }

    input.value = '';

    input.style.height =
        'auto';

    await processarEnvioIA(
        mensagem
    );
}


function usarSugestao(texto) {
    const input =
        obterElemento('chat-input');

    if (!input) {
        return;
    }

    input.value =
        texto;

    enviarMensagem();
}


function resetarChat() {
    pararRespostaIA();

    idConversaAtiva =
        null;

    ttsNextResponse =
        false;

    const container =
        obterElemento('chat-messages') ||
        obterElemento('mensagens');

    if (container) {
        container.innerHTML =
            '';
    }

    mostrarWelcome(
        true
    );

    document
        .querySelectorAll(
            '.historico-item'
        )
        .forEach(item =>
            item.classList.remove(
                'ativo'
            )
        );
}


/* ================================================================
   FEEDBACK
================================================================ */

async function enviarFeedback() {
    const input =
        obterElemento(
            'feedback-input'
        );

    const texto =
        input?.value?.trim();

    if (!texto) {
        mostrarErroTela(
            'feedback-erro',
            'Digite seu feedback.'
        );

        return;
    }

    try {
        const res =
            await fetch(
                '/feedback',
                {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type':
                            'application/json'
                    },
                    body: JSON.stringify({
                        feedback:
                            texto,
                        conversa_id:
                            idConversaAtiva
                    })
                }
            );

        if (!res.ok) {
            throw new Error(
                'Falha ao enviar feedback.'
            );
        }

        if (input) {
            input.value = '';
        }

        fecharAuth();

        alert(
            'Feedback enviado. Obrigado!'
        );

    } catch (erro) {
        console.error(
            '[IANA FEEDBACK]',
            erro
        );

        mostrarErroTela(
            'feedback-erro',
            'Não foi possível enviar o feedback.'
        );
    }
}


/* ================================================================
   SIDEBAR
================================================================ */

function iniciarSidebar() {
    const sidebar =
        obterElemento('sidebar');

    const topbarMenu =
        obterElemento(
            'topbar-menu-toggle'
        );

    const sidebarToggle =
        obterElemento(
            'sidebar-toggle'
        );

    if (!sidebar) {
        return;
    }

    const alternarSidebar =
        () => {
            const fechado =
                sidebar.classList.toggle(
                    'collapsed'
                );

            if (topbarMenu) {
                topbarMenu.title =
                    fechado
                        ? 'Abrir menu'
                        : 'Fechar menu';

                topbarMenu.setAttribute(
                    'aria-label',
                    fechado
                        ? 'Abrir menu'
                        : 'Fechar menu'
                );
            }
        };

    sidebarToggle?.addEventListener(
        'click',
        alternarSidebar
    );

    topbarMenu?.addEventListener(
        'click',
        alternarSidebar
    );
}


/* ================================================================
   DROPDOWN DO USUÁRIO
================================================================ */

function iniciarDropdownUsuario() {
    const btn =
        obterElemento(
            'btn-user-menu'
        );

    const dropdown =
        obterElemento(
            'user-dropdown'
        );

    if (!btn || !dropdown) {
        return;
    }

    btn.addEventListener(
        'click',
        event => {
            event.stopPropagation();

            dropdown.style.display =
                dropdown.style.display ===
                'block'
                    ? 'none'
                    : 'block';
        }
    );

    document.addEventListener(
        'click',
        () => {
            dropdown.style.display =
                'none';
        }
    );
}


/* ================================================================
   EVENTOS DE AUTH
================================================================ */

function iniciarEventosAuth() {
    obterElemento(
        'btn-entrar'
    )?.addEventListener(
        'click',
        () =>
            mostrarTela(
                'tela-login'
            )
    );

    obterElemento(
        'btn-registrar'
    )?.addEventListener(
        'click',
        () =>
            mostrarTela(
                'tela-cadastro'
            )
    );

    obterElemento(
        'btn-login'
    )?.addEventListener(
        'click',
        realizarLogin
    );

    obterElemento(
        'btn-cadastrar'
    )?.addEventListener(
        'click',
        realizarCadastro
    );

    obterElemento(
        'btn-enviar-cod'
    )?.addEventListener(
        'click',
        enviarCodigoRecuperacao
    );

    obterElemento(
        'btn-mudar-senha'
    )?.addEventListener(
        'click',
        alterarSenha
    );

    obterElemento(
        'dd-logout'
    )?.addEventListener(
        'click',
        realizarLogout
    );
}


/* ================================================================
   EVENTOS DO CHAT
================================================================ */

function iniciarEventosChat() {
    obterElemento(
        'btn-novo-chat'
    )?.addEventListener(
        'click',
        resetarChat
    );

    obterElemento(
        'btn-send'
    )?.addEventListener(
        'click',
        enviarMensagem
    );

    obterElemento(
        'btn-stop'
    )?.addEventListener(
        'click',
        pararRespostaIA
    );

    const input =
        obterElemento(
            'chat-input'
        );

    if (input) {
        input.addEventListener(
            'keydown',
            event => {
                if (
                    event.key ===
                        'Enter' &&
                    !event.shiftKey
                ) {
                    event.preventDefault();

                    enviarMensagem();
                }
            }
        );

        input.addEventListener(
            'input',
            () => {
                input.style.height =
                    'auto';

                input.style.height =
                    `${Math.min(
                        input.scrollHeight,
                        200
                    )}px`;
            }
        );
    }
}


/* ================================================================
   EVENTOS DE VOZ
================================================================ */

function iniciarEventosVoz() {
    obterElemento(
        'btn-voz-call'
    )?.addEventListener(
        'click',
        abrirVoz
    );

    obterElemento(
        'btn-voz-encerrar'
    )?.addEventListener(
        'click',
        fecharVoz
    );

    obterElemento(
        'btn-voz-mute'
    )?.addEventListener(
        'click',
        toggleMuteVoz
    );
}


/* ================================================================
   EVENTOS DE CÂMERA
================================================================ */

function iniciarEventosCamera() {
    obterElemento(
        'btn-camera-fechar'
    )?.addEventListener(
        'click',
        fecharCamera
    );

    obterElemento(
        'btn-camera-capturar'
    )?.addEventListener(
        'click',
        capturarFoto
    );
}


/* ================================================================
   EVENTOS DE HISTÓRICO
================================================================ */

function iniciarEventosHistorico() {
    obterElemento(
        'btn-buscar'
    )?.addEventListener(
        'click',
        () =>
            mostrarTela(
                'tela-pesquisa'
            )
    );

    obterElemento(
        'pesquisa-input'
    )?.addEventListener(
        'input',
        event => {
            pesquisarConversas(
                event.target.value
            );
        }
    );


    obterElemento(
        'btn-salvar-rename'
    )?.addEventListener(
        'click',
        salvarRenomear
    );


    obterElemento(
        'btn-confirmar-excluir'
    )?.addEventListener(
        'click',
        confirmarExcluir
    );


    obterElemento(
        'btn-fb-enviar'
    )?.addEventListener(
        'click',
        enviarFeedback
    );
}


/* ================================================================
   TECLAS GLOBAIS
================================================================ */

function iniciarEventosGlobais() {
    document.addEventListener(
        'keydown',
        event => {
            if (
                event.key ===
                'Escape'
            ) {
                const auth =
                    obterElemento(
                        'overlay-auth'
                    );

                if (
                    auth &&
                    auth.style.display !==
                        'none'
                ) {
                    fecharAuth();
                }
            }
        }
    );
}


/* ================================================================
   INICIALIZAÇÃO
================================================================ */

document.addEventListener(
    'DOMContentLoaded',
    async () => {
        if (chatInicializado) {
            return;
        }

        chatInicializado =
            true;

        /*
           TTS do navegador pode carregar
           as vozes de forma assíncrona.
        */

        if (
            typeof speechSynthesis !==
            'undefined'
        ) {
            speechSynthesis.onvoiceschanged =
                () => {
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
);


/* ================================================================
   LIMPEZA AO SAIR DA PÁGINA
================================================================ */

window.addEventListener(
    'beforeunload',
    () => {
        try {
            pararReconhecimentoVoz();
        } catch {}

        try {
            pararVisualizacaoAudio();
        } catch {}

        try {
            pararAudioEleven();
        } catch {}

        try {
            if (streamCamera) {
                streamCamera
                    .getTracks()
                    .forEach(
                        track =>
                            track.stop()
                    );
            }
        } catch {}

        try {
            if (typeof speechSynthesis !== 'undefined') {
                speechSynthesis.cancel();
            }
        } catch {}
    }
);


/* ================================================================
   API GLOBAL
   Permite que outros scripts/HTML chamem funções.
================================================================ */

window.IANA = {
    enviarMensagem,
    processarEnvioIA,
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


/* ================================================================
   FIM — IANA chat.js
================================================================ */