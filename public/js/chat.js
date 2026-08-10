/* ================================================================
   IANA — chat.js
   Versão corrigida
   - Upload real de imagens
   - Câmera envia imagem ao backend
   - Imagem não usa innerHTML com data URL
   - Correção do fluxo de anexos
   - Correção do botão fechar chamada
   - Melhor controle de reconhecimento de voz
   - Melhor controle de streams
   - Sanitização do histórico
   - Configuração enviada ao backend
   ================================================================ */

'use strict';

/* ────────────────────────────────────────────────────────────────
   ESTADO GLOBAL
   ──────────────────────────────────────────────────────────────── */

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

/* Visualização real do microfone */
let emChamadaVoz = false;
let audioCtxVoz = null;
let analyserVoz = null;
let streamAudioVozBars = null;
let rafVozId = null;


/* ────────────────────────────────────────────────────────────────
   TELAS
   ──────────────────────────────────────────────────────────────── */

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


/* ────────────────────────────────────────────────────────────────
   UTILITÁRIOS
   ──────────────────────────────────────────────────────────────── */

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


function sanitizarHTML(html) {
    if (typeof DOMPurify !== 'undefined') {
        return DOMPurify.sanitize(html);
    }

    return String(html ?? '');
}


/*
 * Escapa texto antes de colocá-lo dentro de innerHTML.
 */
function escaparHTML(texto) {
    const div = document.createElement('div');
    div.textContent = String(texto ?? '');
    return div.innerHTML;
}


/*
 * Converte File -> Data URL.
 */
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


/*
 * Verifica se o navegador suporta getUserMedia.
 */
function possuiMediaDevices() {
    return Boolean(
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function'
    );
}


/* ────────────────────────────────────────────────────────────────
   CONFIGURAÇÕES
   ──────────────────────────────────────────────────────────────── */

const CONFIG_KEY = 'iana_config';


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

    if (c.personalidade?.length) {
        linhas.push(
            `Estilo de personalidade: ${c.personalidade.join(', ')}.`
        );
    }

    if (c.foco?.length) {
        linhas.push(
            `Foco principal (priorize esses assuntos): ${c.foco.join(', ')}.`
        );
    }

    if (c.plataforma?.length) {
        linhas.push(
            `Plataforma do usuário: ${c.plataforma.join(', ')}.`
        );
    }

    if (c.voz?.length) {
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
            'NÃO precisa adaptar o tom ao humor do usuário.'
        );
    }

    if (c.criatividade === false) {
        comportamentos.push(
            'NÃO invente/crie conteúdo quando não souber a resposta — diga que não sabe.'
        );
    }

    if (c.contexto === false) {
        comportamentos.push(
            'NÃO dependa do contexto de mensagens anteriores.'
        );
    }

    if (comportamentos.length) {
        linhas.push(comportamentos.join(' '));
    }

    return linhas.join('\n');
}


/* ────────────────────────────────────────────────────────────────
   TTS
   ──────────────────────────────────────────────────────────────── */

function getVoicesTTS() {
    return typeof speechSynthesis !== 'undefined'
        ? speechSynthesis.getVoices()
        : [];
}


function escolherVozTTS() {
    if (ttsVoice) {
        return ttsVoice;
    }

    const voices = getVoicesTTS();

    if (!voices.length) {
        return null;
    }

    const preferida = voices.find(
        voice =>
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
    try {
        if (
            !ttsEnabled ||
            typeof speechSynthesis === 'undefined' ||
            !texto
        ) {
            return;
        }

        const overlay = document.getElementById('overlay-voz');

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

        utterance.onstart = () => {
            if (
                overlay &&
                overlay.style.display !== 'none'
            ) {
                atualizarEstadoVoz(
                    'falando',
                    'Iana está falando...'
                );
            }
        };

        utterance.onend = () => {
            if (
                overlay &&
                overlay.style.display !== 'none'
            ) {
                atualizarEstadoVoz(
                    'ouvindo',
                    'Fale sua pergunta'
                );
            }
        };

        speechSynthesis.cancel();
        speechSynthesis.speak(utterance);

    } catch (e) {
        console.warn('TTS falhou:', e);
    }
}


/* ────────────────────────────────────────────────────────────────
   AUTENTICAÇÃO
   ──────────────────────────────────────────────────────────────── */

function mostrarTela(id) {
    const overlay = document.getElementById('overlay-auth');

    if (!overlay) {
        return;
    }

    TELAS.forEach(tela => {
        const elemento = document.getElementById(tela);

        if (elemento) {
            elemento.style.display =
                tela === id ? 'block' : 'none';
        }
    });

    overlay.style.display = 'flex';
}


function fecharAuth() {
    const overlay = document.getElementById('overlay-auth');

    if (overlay) {
        overlay.style.display = 'none';
    }
}


/* ────────────────────────────────────────────────────────────────
   CÂMERA
   ──────────────────────────────────────────────────────────────── */

async function abrirCamera() {
    const overlay = document.getElementById('overlay-camera');
    const preview = document.getElementById('camera-preview');

    if (!overlay || !preview) {
        return;
    }

    if (!possuiMediaDevices()) {
        alert('Seu navegador não suporta acesso à câmera.');
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

    } catch (e) {
        console.error('Câmera:', e);

        alert(
            'Não foi possível acessar a câmera: ' +
            (e.message || 'permissão negada.')
        );
    }
}


function fecharCamera() {
    const overlay = document.getElementById('overlay-camera');
    const preview = document.getElementById('camera-preview');

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


/*
 * Captura a câmera e envia a imagem REAL para /chat/stream.
 */
async function capturarFoto() {
    const preview = document.getElementById('camera-preview');

    if (
        !preview ||
        !preview.videoWidth ||
        !preview.videoHeight
    ) {
        alert('A câmera ainda não está pronta.');
        return;
    }

    try {
        const canvas = document.createElement('canvas');

        canvas.width = preview.videoWidth;
        canvas.height = preview.videoHeight;

        const ctx = canvas.getContext('2d');

        if (!ctx) {
            throw new Error(
                'Não foi possível criar o contexto da imagem.'
            );
        }

        ctx.drawImage(
            preview,
            0,
            0,
            canvas.width,
            canvas.height
        );

        const dataUrl = canvas.toDataURL(
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

    } catch (e) {
        console.error('Captura da câmera:', e);

        alert(
            'Não foi possível capturar a foto.'
        );
    }
}


/* ────────────────────────────────────────────────────────────────
   CHAMADA DE VOZ
   ──────────────────────────────────────────────────────────────── */

function atualizarEstadoVoz(estado, texto) {
    const overlay = document.getElementById('overlay-voz');
    const status = document.getElementById('voz-status');

    if (!overlay) {
        return;
    }

    overlay.classList.remove(
        'iana-voz-ouvindo',
        'iana-voz-processando',
        'iana-voz-falando'
    );

    if (estado === 'ouvindo') {
        overlay.classList.add('iana-voz-ouvindo');
    }

    if (estado === 'processando') {
        overlay.classList.add('iana-voz-processando');
    }

    if (estado === 'falando') {
        overlay.classList.add('iana-voz-falando');
    }

    if (status && texto) {
        status.textContent = texto;
    }
}


function abrirVoz() {
    const overlay = document.getElementById('overlay-voz');

    if (!overlay) {
        return;
    }

    overlay.style.display = 'flex';

    emChamadaVoz = true;

    atualizarEstadoVoz(
        'ouvindo',
        'Fale sua pergunta'
    );

    iniciarVisualizacaoAudio();
    iniciarReconhecimentoVoz();
}


function fecharVoz() {
    const overlay = document.getElementById('overlay-voz');

    if (overlay) {
        overlay.style.display = 'none';

        overlay.classList.remove(
            'iana-voz-ouvindo',
            'iana-voz-processando',
            'iana-voz-falando'
        );
    }

    if (window._recognitionVoz) {
        try {
            window._recognitionVoz.stop();
        } catch {}

        window._recognitionVoz = null;
    }

    if (streamVoz) {
        streamVoz
            .getTracks()
            .forEach(track => track.stop());

        streamVoz = null;
    }

    if (
        typeof speechSynthesis !== 'undefined'
    ) {
        speechSynthesis.cancel();
    }

    pararVisualizacaoAudio();

    emChamadaVoz = false;

    const transcript = document.getElementById(
        'voz-transcript'
    );

    if (transcript) {
        transcript.textContent = '';
    }

    const mute = document.getElementById(
        'btn-voz-mute'
    );

    if (mute) {
        mute.classList.remove('mutado');
        mute.textContent = '🎙️';
    }

    window.IanaHUD?.setEstado?.('ocioso');
}


/* ────────────────────────────────────────────────────────────────
   VISUALIZAÇÃO DO MICROFONE
   ──────────────────────────────────────────────────────────────── */

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

        audioCtxVoz = new AudioContextClass();

        const source =
            audioCtxVoz.createMediaStreamSource(
                streamAudioVozBars
            );

        analyserVoz =
            audioCtxVoz.createAnalyser();

        analyserVoz.fftSize = 32;

        source.connect(analyserVoz);

        if (
            audioCtxVoz.state === 'suspended'
        ) {
            await audioCtxVoz.resume();
        }

        loopVisualizacaoAudio();

    } catch (e) {
        console.warn(
            'Visualização do microfone indisponível:',
            e.message
        );
    }
}


function loopVisualizacaoAudio() {
    if (!analyserVoz) {
        return;
    }

    const dados = new Uint8Array(
        analyserVoz.frequencyBinCount
    );

    analyserVoz.getByteFrequencyData(dados);

    const media =
        dados.reduce(
            (total, valor) => total + valor,
            0
        ) / dados.length;

    const nivel = Math.min(
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


/* ────────────────────────────────────────────────────────────────
   SPEECH RECOGNITION
   ──────────────────────────────────────────────────────────────── */

function iniciarReconhecimentoVoz() {
    const SpeechRecognition =
        window.SpeechRecognition ||
        window.webkitSpeechRecognition;

    const statusEl =
        document.getElementById('voz-status');

    const transcriptEl =
        document.getElementById('voz-transcript');

    if (!SpeechRecognition) {
        if (statusEl) {
            statusEl.textContent =
                'Reconhecimento de voz não suportado neste navegador.';
        }

        return;
    }

    if (window._recognitionVoz) {
        try {
            window._recognitionVoz.stop();
        } catch {}
    }

    const rec = new SpeechRecognition();

    rec.lang = 'pt-BR';
    rec.continuous = true;
    rec.interimResults = true;

    window._recognitionVoz = rec;

    rec.onstart = () => {
        atualizarEstadoVoz(
            'ouvindo',
            'Fale sua pergunta'
        );
    };

    rec.onresult = event => {
        let texto = '';

        for (
            let i = event.resultIndex;
            i < event.results.length;
            i++
        ) {
            texto +=
                event.results[i][0].transcript;
        }

        if (transcriptEl) {
            transcriptEl.textContent = texto;
        }

        const ultimoResultado =
            event.results[
                event.results.length - 1
            ];

        if (
            ultimoResultado?.isFinal &&
            texto.trim()
        ) {
            atualizarEstadoVoz(
                'processando',
                'Processando...'
            );

            ttsNextResponse = true;

            processarEnvioIA(
                texto.trim()
            ).then(() => {
                if (!emChamadaVoz) {
                    return;
                }

                atualizarEstadoVoz(
                    'ouvindo',
                    'Fale sua pergunta'
                );

                if (transcriptEl) {
                    transcriptEl.textContent = '';
                }
            });
        }
    };

    rec.onerror = event => {
        console.warn(
            'SpeechRecognition:',
            event.error
        );

        if (!emChamadaVoz) {
            return;
        }

        if (
            event.error === 'not-allowed' ||
            event.error === 'service-not-allowed'
        ) {
            atualizarEstadoVoz(
                'ocioso',
                'Permissão de microfone negada.'
            );

            return;
        }

        atualizarEstadoVoz(
            'ouvindo',
            'Erro ao ouvir. Tente novamente.'
        );
    };

    rec.onend = () => {
        /*
         * O reconhecimento pode encerrar sozinho.
         * Reiniciamos somente enquanto a chamada estiver aberta
         * e o usuário não estiver mutado.
         */
        if (
            emChamadaVoz &&
            !window._vozMutado
        ) {
            setTimeout(() => {
                if (
                    emChamadaVoz &&
                    !window._recognitionVoz
                ) {
                    iniciarReconhecimentoVoz();
                }
            }, 300);
        }
    };

    try {
        rec.start();
    } catch (e) {
        console.warn(
            'Não foi possível iniciar reconhecimento:',
            e.message
        );
    }
}


function toggleMuteVoz() {
    const btn =
        document.getElementById(
            'btn-voz-mute'
        );

    if (window._recognitionVoz) {
        try {
            window._recognitionVoz.stop();
        } catch {}

        window._recognitionVoz = null;
        window._vozMutado = true;

        if (btn) {
            btn.textContent = '🔇';
            btn.classList.add('mutado');
        }

        atualizarEstadoVoz(
            'ocioso',
            'Microfone desativado'
        );

    } else {
        window._vozMutado = false;

        iniciarReconhecimentoVoz();

        if (btn) {
            btn.textContent = '🎙️';
            btn.classList.remove('mutado');
        }
    }
}


/* ────────────────────────────────────────────────────────────────
   MENU DE UPLOAD
   ──────────────────────────────────────────────────────────────── */

function iniciarMenuUpload() {
    const btnMais =
        document.getElementById('btn-mais');

    const menu =
        document.getElementById('upload-menu');

    const fileInput =
        document.getElementById('file-input');

    if (!btnMais || !menu) {
        return;
    }

    btnMais.addEventListener('click', event => {
        event.stopPropagation();

        const rect =
            btnMais.getBoundingClientRect();

        const aberto =
            menu.style.display === 'flex';

        if (!aberto) {
            menu.style.display = 'flex';

            /*
             * Mede depois de exibir.
             */
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
                top = rect.bottom + 8;
            }

            menu.style.left =
                `${Math.max(8, left)}px`;

            menu.style.top =
                `${Math.max(8, top)}px`;

        } else {
            menu.style.display = 'none';
        }
    });

    document.addEventListener('click', () => {
        menu.style.display = 'none';
    });

    menu.addEventListener(
        'click',
        event => event.stopPropagation()
    );


    document
        .getElementById('up-foto')
        ?.addEventListener(
            'click',
            () => {
                menu.style.display = 'none';
                abrirCamera();
            }
        );


    document
        .getElementById('up-imagem')
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


    document
        .getElementById('up-arquivo')
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


    document
        .getElementById('up-audio')
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


    document
        .getElementById('up-tela')
        ?.addEventListener(
            'click',
            () => {
                menu.style.display = 'none';
                compartilharTela();
            }
        );
}


/* ────────────────────────────────────────────────────────────────
   UPLOAD DE ARQUIVOS
   ──────────────────────────────────────────────────────────────── */

function iniciarUpload() {
    const fileInput =
        document.getElementById('file-input');

    if (!fileInput) {
        return;
    }

    fileInput.addEventListener(
        'change',
        async () => {
            const file =
                fileInput.files?.[0];

            if (!file) {
                return;
            }

            try {
                /*
                 * IMAGEM
                 */
                if (
                    file.type.startsWith('image/')
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


                /*
                 * ÁUDIO
                 *
                 * Ainda não é transcrito aqui.
                 * O backend precisa de um endpoint de
                 * transcrição para transformar o áudio
                 * em texto.
                 */
                if (
                    file.type.startsWith('audio/')
                ) {
                    const dataUrl = await arquivoParaDataURL(file);
                    await processarEnvioIA(
                        `[Usuário enviou um áudio: ${file.name}]`,
                        {
                            tipo: 'audio',
                            audio: dataUrl,
                            nome: file.name,
                            mimeType: file.type
                        }
                    );

                    return;
                }


                /*
                 * TXT
                 *
                 * Para TXT conseguimos ler o conteúdo
                 * diretamente no navegador.
                 */
                if (
                    file.type === 'text/plain' ||
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


                /*
                 * PDF/DOC/DOCX
                 *
                 * Apenas informamos que o arquivo
                 * foi selecionado. Para interpretação
                 * real, o backend precisa fazer parsing.
                 */
                await processarEnvioIA(
                    `[Usuário enviou um arquivo: ${file.name}]`,
                    {
                        tipo: 'arquivo',
                        nome: file.name,
                        mimeType: file.type
                    }
                );

            } catch (e) {
                console.error(
                    'Erro no upload:',
                    e
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


/* ────────────────────────────────────────────────────────────────
   COMPARTILHAMENTO DE TELA
   ──────────────────────────────────────────────────────────────── */

async function compartilharTela() {
    if (
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getDisplayMedia !==
            'function'
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

        /*
         * Quando o usuário clica em "Parar compartilhamento"
         * no navegador.
         */
        track?.addEventListener(
            'ended',
            () => {
                window._telaCompartilhada = false;
            }
        );

        window._telaCompartilhada = true;

        /*
         * Atualmente o navegador não envia automaticamente
         * o frame da tela para o Gemini.
         *
         * Aqui apenas registramos que a tela foi compartilhada.
         */
        await processarEnvioIA(
            '[Usuário compartilhou a tela.]'
        );

    } catch (e) {
        if (
            e.name !== 'NotAllowedError'
        ) {
            console.error(
                'Compartilhamento de tela:',
                e
            );

            alert(
                'Erro ao compartilhar tela: ' +
                e.message
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


/* ────────────────────────────────────────────────────────────────
   GRAVAÇÃO DE ÁUDIO
   ──────────────────────────────────────────────────────────────── */

function iniciarGravacaoAudio() {
    const btn =
        document.getElementById('btn-mic');

    if (!btn) {
        return;
    }

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
                        await navigator.mediaDevices
                            .getUserMedia({
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

                            console.log(
                                'Áudio gravado:',
                                blob
                            );

                            try {
                                const arquivo = new File(
                                    [blob],
                                    'gravacao.webm',
                                    { type: mimeType }
                                );
                                const dataUrl = await arquivoParaDataURL(arquivo);
                                await processarEnvioIA(
                                    '[Usuário enviou um áudio gravado.]',
                                    {
                                        tipo: 'audio',
                                        audio: dataUrl,
                                        nome: 'gravacao.webm',
                                        mimeType
                                    }
                                );
                            } catch (e) {
                                console.error('Envio do áudio gravado:', e);
                                alert('Não foi possível enviar o áudio.');
                            }
                        };


                    mediaRecorderAudio.start();

                    gravandoAudio = true;

                    btn.classList.add(
                        'gravando'
                    );

                    btn.title =
                        'Parar gravação';

                } catch (e) {
                    console.error(
                        'Microfone:',
                        e
                    );

                    alert(
                        'Não foi possível acessar o microfone: ' +
                        e.message
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


/* ────────────────────────────────────────────────────────────────
   SESSÃO
   ──────────────────────────────────────────────────────────────── */

async function verificarSessao() {
    try {
        const res =
            await fetch(
                '/auth/me',
                {
                    credentials: 'include'
                }
            );

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
        document.getElementById(
            'auth-buttons'
        );

    const footer =
        document.getElementById(
            'sidebar-footer'
        );

    if (authButtons) {
        authButtons.style.display = 'flex';
    }

    if (footer) {
        footer.style.display = 'none';
    }

    const hint =
        document.getElementById(
            'historico-hint'
        );

    if (hint) {
        hint.textContent =
            'Faça login para salvar conversas.';
    }

    const lista =
        document.getElementById(
            'historico-lista'
        );

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
        document.getElementById(
            'auth-buttons'
        );

    const footer =
        document.getElementById(
            'sidebar-footer'
        );

    if (authButtons) {
        authButtons.style.display = 'none';
    }

    if (footer) {
        footer.style.display = 'block';
    }

    const nomeEl =
        document.getElementById(
            'user-nome-sidebar'
        );

    if (nomeEl) {
        nomeEl.textContent =
            usuario.nome;
    }

    const topAvatar =
        document.getElementById(
            'topbar-profile-avatar'
        );

    if (
        topAvatar &&
        usuario.avatar
    ) {
        topAvatar.src =
            usuario.avatar;
    }

    carregarHistorico();
}


/* ────────────────────────────────────────────────────────────────
   AUTH
   ──────────────────────────────────────────────────────────────── */

function mensagemErroAuth(
    msg,
    fallback = 'Erro inesperado.'
) {
    const texto =
        String(msg || '').toLowerCase();

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
        )
    ) {
        return 'E-mail ou senha inválidos.';
    }

    if (
        texto.includes(
            'mínima'
        )
    ) {
        return 'Senha muito curta (mínimo 8 caracteres).';
    }

    return msg || fallback;
}


function mostrarErroTela(id, msg) {
    const el =
        document.getElementById(id);

    if (el) {
        el.textContent = msg;
    }
}


async function realizarLogin() {
    const email =
        document.getElementById(
            'login-email'
        )?.value.trim();

    const senha =
        document.getElementById(
            'login-senha'
        )?.value;

    if (!email || !senha) {
        mostrarErroTela(
            'login-erro',
            'Preencha e-mail e senha.'
        );

        return;
    }

    const btn =
        document.getElementById(
            'btn-login'
        );

    const orig =
        btn?.textContent || 'Entrar';

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
        } else {
            fecharAuth();

            atualizarUILogado(
                data.usuario
            );
        }

    } catch {
        mostrarErroTela(
            'login-erro',
            'Erro de conexão.'
        );

    } finally {
        if (btn) {
            btn.textContent = orig;
            btn.disabled = false;
        }
    }
}


async function realizarCadastro() {
    const nome =
        document.getElementById(
            'cad-nome'
        )?.value.trim();

    const email =
        document.getElementById(
            'cad-email'
        )?.value.trim();

    const senha =
        document.getElementById(
            'cad-senha'
        )?.value;

    if (!nome || !email || !senha) {
        mostrarErroTela(
            'cad-erro',
            'Preencha todos os campos.'
        );

        return;
    }

    const btn =
        document.getElementById(
            'btn-cadastrar'
        );

    const orig =
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
        } else {
            fecharAuth();

            atualizarUILogado(
                data.usuario
            );
        }

    } catch {
        mostrarErroTela(
            'cad-erro',
            'Erro de conexão.'
        );

    } finally {
        if (btn) {
            btn.textContent = orig;
            btn.disabled = false;
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
    } catch (e) {
        console.warn(
            'Logout falhou:',
            e
        );
    }

    atualizarUIVisitante();
    resetarChat();
}


async function enviarCodigoRecuperacao() {
    const email =
        document.getElementById(
            'esq-email'
        )?.value.trim();

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
        } else {
            emailRecuperacao =
                email;

            const label =
                document.getElementById(
                    'cod-label'
                );

            if (label) {
                label.textContent =
                    `Código enviado para ${email}`;
            }

            mostrarTela(
                'tela-codigo'
            );
        }

    } catch {
        mostrarErroTela(
            'esq-erro',
            'Erro de conexão.'
        );
    }
}


async function alterarSenha() {
    const codigo =
        document.getElementById(
            'cod-input'
        )?.value.trim();

    const novaSenha =
        document.getElementById(
            'cod-nova-senha'
        )?.value;

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
        } else {
            alert(
                '✅ Senha alterada! Faça login.'
            );

            mostrarTela(
                'tela-login'
            );
        }

    } catch {
        mostrarErroTela(
            'cod-erro',
            'Erro de conexão.'
        );
    }
}


/* ────────────────────────────────────────────────────────────────
   HISTÓRICO
   ──────────────────────────────────────────────────────────────── */

async function carregarHistorico() {
    const container =
        document.getElementById(
            'historico-lista'
        );

    if (!container) {
        return;
    }

    try {
        const res =
            await fetch(
                '/chat/conversas',
                {
                    credentials: 'include'
                }
            );

        if (!res.ok) {
            container.innerHTML =
                '<p class="sidebar-hint">Erro ao carregar o histórico.</p>';

            return;
        }

        const { conversas } =
            await res.json();

        container.innerHTML = '';

        if (!conversas?.length) {
            container.innerHTML =
                '<p class="sidebar-hint">Nenhum chat salvo ainda.</p>';

            return;
        }

        conversas.forEach(c => {
            const item =
                document.createElement(
                    'div'
                );

            item.className =
                `chat-item ${
                    idConversaAtiva ===
                    c.id_conversa
                        ? 'active'
                        : ''
                } ${
                    c.fixada
                        ? 'fixada'
                        : ''
                }`;

            const tituloOriginal =
                c.titulo ||
                'Conversa';

            /*
             * CORREÇÃO XSS:
             * Não colocamos o título diretamente
             * no innerHTML.
             */
            const titulo =
                document.createElement(
                    'span'
                );

            titulo.className =
                'chat-titulo';

            titulo.textContent =
                tituloOriginal;

            item.appendChild(
                titulo
            );


            const wrapper =
                document.createElement(
                    'div'
                );

            wrapper.className =
                'chat-options-wrapper';


            const options =
                document.createElement(
                    'button'
                );

            options.type = 'button';
            options.className =
                'btn-chat-options';

            options.textContent =
                '⋮';


            const menu =
                document.createElement(
                    'div'
                );

            menu.className =
                'chat-options-menu';


            const fixar =
                document.createElement(
                    'button'
                );

            fixar.type = 'button';
            fixar.className =
                'chat-option-btn';

            fixar.dataset.acao =
                'fixar';

            fixar.textContent =
                c.fixada
                    ? 'Desafixar'
                    : 'Fixar';


            const renomear =
                document.createElement(
                    'button'
                );

            renomear.type = 'button';
            renomear.className =
                'chat-option-btn';

            renomear.dataset.acao =
                'renomear';

            renomear.textContent =
                'Renomear';


            const excluir =
                document.createElement(
                    'button'
                );

            excluir.type = 'button';
            excluir.className =
                'chat-option-btn excluir';

            excluir.dataset.acao =
                'excluir';

            excluir.textContent =
                'Excluir';


            menu.appendChild(fixar);
            menu.appendChild(renomear);
            menu.appendChild(excluir);

            wrapper.appendChild(
                options
            );

            wrapper.appendChild(
                menu
            );

            item.appendChild(
                wrapper
            );


            titulo.addEventListener(
                'click',
                () => {
                    ativarConversa(
                        c.id_conversa,
                        tituloOriginal
                    );
                }
            );


            options.addEventListener(
                'click',
                event => {
                    event.stopPropagation();

                    fecharChatOptionsMenu();

                    menu.classList.add(
                        'ativo'
                    );

                    posicionarChatOptionsMenu(
                        options,
                        menu
                    );
                }
            );


            fixar.addEventListener(
                'click',
                event => {
                    event.stopPropagation();

                    acaoFixar(
                        c.id_conversa,
                        !c.fixada
                    );
                }
            );


            renomear.addEventListener(
                'click',
                event => {
                    event.stopPropagation();

                    acaoRenomear(
                        c.id_conversa,
                        tituloOriginal
                    );
                }
            );


            excluir.addEventListener(
                'click',
                event => {
                    event.stopPropagation();

                    acaoExcluir(
                        c.id_conversa
                    );
                }
            );


            container.appendChild(
                item
            );
        });

    } catch (e) {
        console.error(
            'Histórico:',
            e
        );
    }
}


function fecharChatOptionsMenu() {
    document
        .querySelectorAll(
            '.chat-options-menu'
        )
        .forEach(menu => {
            menu.classList.remove(
                'ativo'
            );
        });
}


function posicionarChatOptionsMenu(
    btn,
    menu
) {
    const rect =
        btn.getBoundingClientRect();

    const largura =
        menu.offsetWidth || 150;

    const altura =
        menu.offsetHeight || 120;

    let left =
        rect.right + 8;

    if (
        left + largura >
        window.innerWidth - 8
    ) {
        left =
            rect.left -
            largura -
            8;
    }

    let top =
        rect.top +
        rect.height / 2 -
        altura / 2;

    top =
        Math.max(
            8,
            Math.min(
                top,
                window.innerHeight -
                    altura -
                    8
            )
        );

    menu.style.position =
        'fixed';

    menu.style.left =
        `${left}px`;

    menu.style.top =
        `${top}px`;
}


async function acaoFixar(
    id,
    fixar
) {
    fecharChatOptionsMenu();

    try {
        await fetch(
            `/chat/conversas/${encodeURIComponent(id)}/fixar`,
            {
                method: 'PATCH',
                credentials: 'include',
                headers: {
                    'Content-Type':
                        'application/json'
                },
                body: JSON.stringify({
                    fixada: fixar
                })
            }
        );

        await carregarHistorico();

    } catch (e) {
        console.error(
            'Erro ao fixar:',
            e
        );
    }
}


function acaoRenomear(
    id,
    tituloAtual
) {
    fecharChatOptionsMenu();

    idConversaRenomear =
        id;

    const input =
        document.getElementById(
            'rename-input'
        );

    if (input) {
        input.value =
            tituloAtual;
    }

    mostrarTela(
        'tela-renomear'
    );
}


async function salvarRenomear() {
    const novo =
        document.getElementById(
            'rename-input'
        )?.value.trim();

    if (
        !novo ||
        !idConversaRenomear
    ) {
        fecharAuth();
        return;
    }

    try {
        const res =
            await fetch(
                `/chat/conversas/${encodeURIComponent(idConversaRenomear)}`,
                {
                    method: 'PUT',
                    credentials: 'include',
                    headers: {
                        'Content-Type':
                            'application/json'
                    },
                    body: JSON.stringify({
                        novoTitulo:
                            novo
                    })
                }
            );

        if (!res.ok) {
            throw new Error(
                'Não foi possível renomear.'
            );
        }

        fecharAuth();

        await carregarHistorico();

    } catch (e) {
        console.error(
            'Renomear:',
            e
        );

        alert(
            'Não foi possível renomear a conversa.'
        );
    }
}


function acaoExcluir(id) {
    fecharChatOptionsMenu();

    idConversaExcluir =
        id;

    mostrarTela(
        'tela-confirmar'
    );
}


async function confirmarExcluir() {
    if (!idConversaExcluir) {
        fecharAuth();
        return;
    }

    try {
        const res =
            await fetch(
                `/chat/conversas/${encodeURIComponent(idConversaExcluir)}`,
                {
                    method: 'DELETE',
                    credentials: 'include'
                }
            );

        if (!res.ok) {
            throw new Error(
                'Erro ao excluir.'
            );
        }

        fecharAuth();

        if (
            idConversaAtiva ===
            idConversaExcluir
        ) {
            resetarChat();
        } else {
            await carregarHistorico();
        }

    } catch (e) {
        console.error(
            'Excluir:',
            e
        );

        alert(
            'Não foi possível excluir a conversa.'
        );

    } finally {
        idConversaExcluir =
            null;
    }
}


async function pesquisarConversas(
    termo
) {
    const resultados =
        document.getElementById(
            'pesquisa-resultados'
        );

    if (!resultados) {
        return;
    }

    resultados.innerHTML = '';

    if (!termo.trim()) {
        return;
    }

    try {
        const res =
            await fetch(
                '/chat/conversas',
                {
                    credentials:
                        'include'
                }
            );

        const { conversas } =
            await res.json();

        const busca =
            termo
                .toLowerCase()
                .trim();

        const encontrados =
            (conversas || [])
                .filter(
                    c =>
                        c.titulo
                            ?.toLowerCase()
                            .includes(
                                busca
                            )
                );

        if (!encontrados.length) {
            resultados.innerHTML =
                '<p class="sidebar-hint">Nenhuma conversa encontrada.</p>';

            return;
        }

        encontrados.forEach(
            c => {
                const item =
                    document.createElement(
                        'div'
                    );

                item.className =
                    'chat-item';

                item.textContent =
                    c.titulo ||
                    'Sem título';

                item.addEventListener(
                    'click',
                    () => {
                        ativarConversa(
                            c.id_conversa,
                            c.titulo
                        );

                        fecharAuth();
                    }
                );

                resultados.appendChild(
                    item
                );
            }
        );

    } catch (e) {
        console.error(
            'Pesquisa:',
            e
        );
    }
}


/* ────────────────────────────────────────────────────────────────
   MENSAGENS
   ──────────────────────────────────────────────────────────────── */

function mostrarWelcome(
    mostrar
) {
    const welcome =
        document.getElementById(
            'welcome'
        );

    const chatbox =
        document.getElementById(
            'chatbox'
        );

    if (welcome) {
        welcome.style.display =
            mostrar
                ? 'flex'
                : 'none';
    }

    if (chatbox) {
        chatbox.classList.toggle(
            'has-messages',
            !mostrar
        );

        chatbox.dataset.view =
            mostrar
                ? 'welcome'
                : 'conversation';
    }

    atualizarTituloConversa(
        mostrar
            ? 'Novo chat'
            : null
    );
}


function atualizarTituloConversa(
    titulo
) {
    const el =
        document.getElementById(
            'conversation-title'
        );

    if (el) {
        el.textContent =
            titulo ||
            (
                idConversaAtiva
                    ? 'Conversa'
                    : 'Novo chat'
            );
    }
}


function criarBotaoCopiar(
    getTexto
) {
    const btn =
        document.createElement(
            'button'
        );

    btn.type = 'button';
    btn.className =
        'msg-action-btn';

    btn.title =
        'Copiar';

    btn.textContent =
        '📋';

    btn.addEventListener(
        'click',
        async () => {
            const texto =
                getTexto();

            try {
                await navigator
                    .clipboard
                    ?.writeText(
                        texto
                    );

                const original =
                    btn.textContent;

                btn.textContent =
                    '✅';

                setTimeout(
                    () => {
                        btn.textContent =
                            original;
                    },
                    1200
                );

            } catch {}
        }
    );

    return btn;
}


function criarBotaoEditar(
    texto
) {
    const btn =
        document.createElement(
            'button'
        );

    btn.type = 'button';
    btn.className =
        'msg-action-btn';

    btn.title =
        'Editar mensagem';

    btn.textContent =
        '✏️';

    btn.addEventListener(
        'click',
        () => {
            const input =
                document.getElementById(
                    'chat-input'
                );

            if (!input) {
                return;
            }

            input.value =
                texto;

            input.focus();

            input.style.height =
                'auto';

            input.style.height =
                input.scrollHeight +
                'px';
        }
    );

    return btn;
}


function configurarExpandir(
    bubble,
    linhaAcoes
) {
    if (!bubble) {
        return;
    }

    requestAnimationFrame(
        () => {
            bubble.classList.add(
                'msg-clamped'
            );

            const ultrapassou =
                bubble.scrollHeight >
                bubble.clientHeight +
                1;

            if (!ultrapassou) {
                bubble.classList.remove(
                    'msg-clamped'
                );

                return;
            }

            const btn =
                document.createElement(
                    'button'
                );

            btn.type = 'button';
            btn.className =
                'msg-expand-btn';

            btn.textContent =
                '▼ Expandir';

            let expandido =
                false;

            btn.addEventListener(
                'click',
                () => {
                    expandido =
                        !expandido;

                    bubble.classList.toggle(
                        'msg-clamped',
                        !expandido
                    );

                    btn.textContent =
                        expandido
                            ? '▲ Recolher'
                            : '▼ Expandir';
                }
            );

            linhaAcoes.appendChild(
                btn
            );
        }
    );
}


function adicionarBolhaUsuario(
    texto
) {
    const msgs =
        document.getElementById(
            'msgs'
        );

    if (!msgs) {
        return;
    }

    mostrarWelcome(false);

    const wrap =
        document.createElement(
            'div'
        );

    wrap.className =
        'user-msg-wrap nova-mensagem';


    const bubble =
        document.createElement(
            'div'
        );

    bubble.className =
        'user-msg-bubble';

    bubble.textContent =
        texto;

    wrap.appendChild(
        bubble
    );


    const acoes =
        document.createElement(
            'div'
        );

    acoes.className =
        'msg-actions user-actions';

    acoes.appendChild(
        criarBotaoEditar(
            texto
        )
    );

    acoes.appendChild(
        criarBotaoCopiar(
            () => texto
        )
    );

    wrap.appendChild(
        acoes
    );

    msgs.appendChild(
        wrap
    );

    configurarExpandir(
        bubble,
        acoes
    );

    scrollParaFim();

    if (emChamadaVoz) {
        adicionarNaFeedVoz(
            'user',
            texto
        );
    }
}


/*
 * CORREÇÃO:
 *
 * Não usamos:
 *
 * wrap.innerHTML = `<img src="${dataUrl}">`
 *
 * Criamos o elemento IMG diretamente.
 */
function adicionarImagemUsuario(
    dataUrl,
    nomeArquivo = 'imagem'
) {
    const msgs =
        document.getElementById(
            'msgs'
        );

    if (
        !msgs ||
        typeof dataUrl !== 'string' ||
        !dataUrl.startsWith(
            'data:image/'
        )
    ) {
        return;
    }

    mostrarWelcome(false);

    const wrap =
        document.createElement(
            'div'
        );

    wrap.className =
        'user-image-wrap nova-mensagem';


    const img =
        document.createElement(
            'img'
        );

    img.className =
        'user-image';

    img.src =
        dataUrl;

    img.alt =
        nomeArquivo;

    img.loading =
        'lazy';

    img.decoding =
        'async';


    wrap.appendChild(
        img
    );

    msgs.appendChild(
        wrap
    );

    scrollParaFim();
}


function adicionarRespostaIA(
    texto
) {
    const msgs =
        document.getElementById(
            'msgs'
        );

    if (!msgs) {
        return;
    }

    const container =
        document.createElement(
            'div'
        );

    container.className =
        'iana-response-container nova-mensagem';


    const av =
        document.createElement(
            'img'
        );

    av.src =
        '/img/iana-avatar.png';

    av.className =
        'iana-avatar-img';

    av.alt =
        'Iana';

    container.appendChild(
        av
    );


    const wrapConteudo =
        document.createElement(
            'div'
        );

    wrapConteudo.style.cssText =
        'display:flex;flex-direction:column;flex:1;min-width:0;';


    const bubble =
        document.createElement(
            'div'
        );

    bubble.className =
        'iana-message-bubble';


    const textoSeguro =
        String(
            texto ??
            ''
        );

    const html =
        typeof marked !== 'undefined'
            ? marked.parse(
                textoSeguro
            )
            : textoSeguro.replace(
                /\n/g,
                '<br>'
            );

    bubble.innerHTML =
        sanitizarHTML(
            html
        );

    wrapConteudo.appendChild(
        bubble
    );


    const acoes =
        document.createElement(
            'div'
        );

    acoes.className =
        'msg-actions';

    acoes.appendChild(
        criarBotaoCopiar(
            () =>
                bubble.innerText ||
                bubble.textContent ||
                ''
        )
    );

    wrapConteudo.appendChild(
        acoes
    );

    container.appendChild(
        wrapConteudo
    );

    msgs.appendChild(
        container
    );

    configurarExpandir(
        bubble,
        acoes
    );

    scrollParaFim();


    if (ttsNextResponse) {
        falar(texto);

        ttsNextResponse =
            false;
    }


    if (emChamadaVoz) {
        adicionarNaFeedVoz(
            'iana',
            texto
        );
    }
}


function scrollParaFim() {
    const chatbox =
        document.getElementById(
            'chatbox'
        );

    if (chatbox) {
        chatbox.scrollTop =
            chatbox.scrollHeight;
    }
}


/* ────────────────────────────────────────────────────────────────
   FEED DA CHAMADA
   ──────────────────────────────────────────────────────────────── */

function limparFeedVoz() {
    const feed =
        document.getElementById(
            'voz-feed'
        );

    if (feed) {
        feed.innerHTML = '';
    }

    const interim =
        document.getElementById(
            'voz-interim'
        );

    if (interim) {
        interim.textContent = '';
    }
}


function adicionarNaFeedVoz(
    tipo,
    texto
) {
    const feed =
        document.getElementById(
            'voz-feed'
        );

    if (
        !feed ||
        !texto?.trim()
    ) {
        return;
    }

    const bolha =
        document.createElement(
            'div'
        );

    bolha.className =
        `voz-feed-msg ${
            tipo === 'user'
                ? 'voz-feed-user'
                : 'voz-feed-iana'
        }`;

    bolha.textContent =
        texto;

    feed.appendChild(
        bolha
    );

    feed.scrollTop =
        feed.scrollHeight;
}


function mostrarTypingIndicator() {
    const msgs =
        document.getElementById(
            'msgs'
        );

    if (!msgs) {
        return;
    }

    esconderTypingIndicator();

    const typing =
        document.createElement(
            'div'
        );

    typing.id =
        'typing-indicator';

    typing.className =
        'iana-response-container';


    const avatar =
        document.createElement(
            'img'
        );

    avatar.src =
        '/img/iana-avatar.png';

    avatar.className =
        'iana-avatar-img';

    avatar.alt =
        'Iana';


    const bubble =
        document.createElement(
            'div'
        );

    bubble.className =
        'thinking-bubble';


    for (
        let i = 0;
        i < 3;
        i++
    ) {
        const dot =
            document.createElement(
                'span'
            );

        dot.className =
            'dot';

        bubble.appendChild(
            dot
        );
    }

    typing.appendChild(
        avatar
    );

    typing.appendChild(
        bubble
    );

    msgs.appendChild(
        typing
    );

    scrollParaFim();
}


function esconderTypingIndicator() {
    document
        .getElementById(
            'typing-indicator'
        )
        ?.remove();
}


/* ────────────────────────────────────────────────────────────────
   ENVIO
   ──────────────────────────────────────────────────────────────── */

function usarSugestao(
    texto
) {
    const input =
        document.getElementById(
            'chat-input'
        );

    if (input) {
        input.value =
            texto;
    }

    enviarMensagem();
}


async function enviarMensagem() {
    const input =
        document.getElementById(
            'chat-input'
        );

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


/*
 * FUNÇÃO PRINCIPAL
 *
 * anexo pode ser:
 *
 * {
 *   tipo: 'imagem',
 *   imagem: 'data:image/jpeg;base64,...',
 *   nome: 'foto.jpg',
 *   mimeType: 'image/jpeg'
 * }
 */
async function processarEnvioIA(
    conteudo,
    anexo = null
) {
    if (
        typeof conteudo !== 'string' ||
        !conteudo.trim()
    ) {
        return;
    }

    if (aguardandoResposta) {
        return;
    }

    aguardandoResposta =
        true;

    adicionarBolhaUsuario(
        conteudo
    );

    mostrarTypingIndicator();


    const sendBtn =
        document.getElementById(
            'btn-send'
        );

    const stopBtn =
        document.getElementById(
            'btn-stop'
        );

    const input =
        document.getElementById(
            'chat-input'
        );


    if (sendBtn) {
        sendBtn.style.display =
            'none';
    }

    if (stopBtn) {
        stopBtn.style.display =
            'flex';
    }

    if (input) {
        input.disabled =
            true;

        input.placeholder =
            'Iana está pensando...';
    }


    controller =
        new AbortController();


    try {
        const payload = {
            mensagem:
                conteudo,

            idConversa:
                idConversaAtiva,

            configPrompt:
                montarConfigPrompt(),

            estadoEmocional:
                typeof detectarEstadoEmocional ===
                'function'
                    ? detectarEstadoEmocional(
                        conteudo
                    )
                    : undefined
        };


        /*
         * ANEXO DE IMAGEM
         */
        if (
            anexo?.tipo ===
            'imagem'
        ) {
            payload.imagem =
                anexo.imagem;

            payload.nomeArquivo =
                anexo.nome ||
                'imagem.jpg';

            payload.mimeType =
                anexo.mimeType ||
                'image/jpeg';
        }

        if (
            anexo?.tipo ===
            'audio'
        ) {
            payload.audio =
                anexo.audio;

            payload.nomeArquivo =
                anexo.nome ||
                'audio.webm';

            payload.mimeType =
                anexo.mimeType ||
                'audio/webm';
        }


        const res =
            await fetch(
                '/chat/stream',
                {
                    method: 'POST',

                    credentials:
                        'include',

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
            const erroData =
                await res
                    .json()
                    .catch(
                        () => ({})
                    );

            throw new Error(
                erroData.erro ||
                'Erro na comunicação com o servidor.'
            );
        }


        const data =
            await res.json();


        if (
            data.idConversa &&
            !idConversaAtiva
        ) {
            idConversaAtiva =
                data.idConversa;

            atualizarTituloConversa(
                conteudo.length >
                    40
                    ? conteudo.slice(
                        0,
                        40
                    ) + '...'
                    : conteudo
            );
        }


        esconderTypingIndicator();


        adicionarRespostaIA(
            data.resposta ||
            'Não consegui gerar uma resposta.'
        );


        if (usuarioAtual) {
            carregarHistorico();
        }


    } catch (e) {

        esconderTypingIndicator();

        if (
            e.name !==
            'AbortError'
        ) {
            console.error(
                'Erro no envio:',
                e
            );

            adicionarRespostaIA(
                'Desculpe, não consegui processar sua solicitação no momento.'
            );
        }

    } finally {

        aguardandoResposta =
            false;

        if (sendBtn) {
            sendBtn.style.display =
                'flex';
        }

        if (stopBtn) {
            stopBtn.style.display =
                'none';
        }

        if (input) {
            input.disabled =
                false;

            input.placeholder =
                'Peça à Iana...';

            input.focus();
        }
    }
}


function pararRespostaIA() {
    try {
        controller.abort();
    } catch {}

    aguardandoResposta =
        false;

    esconderTypingIndicator();

    const sendBtn =
        document.getElementById(
            'btn-send'
        );

    const stopBtn =
        document.getElementById(
            'btn-stop'
        );

    const input =
        document.getElementById(
            'chat-input'
        );

    if (sendBtn) {
        sendBtn.style.display =
            'flex';
    }

    if (stopBtn) {
        stopBtn.style.display =
            'none';
    }

    if (input) {
        input.disabled =
            false;

        input.placeholder =
            'Peça à Iana...';

        input.focus();
    }
}


/* ────────────────────────────────────────────────────────────────
   CONVERSAS
   ──────────────────────────────────────────────────────────────── */

async function ativarConversa(
    id,
    titulo
) {
    idConversaAtiva =
        id;

    atualizarTituloConversa(
        titulo ||
        'Conversa'
    );

    await carregarHistorico();

    const msgs =
        document.getElementById(
            'msgs'
        );

    if (!msgs) {
        return;
    }

    msgs.innerHTML =
        '';

    mostrarWelcome(
        false
    );

    try {
        const res =
            await fetch(
                `/chat/historico/${encodeURIComponent(id)}`,
                {
                    credentials:
                        'include'
                }
            );

        if (!res.ok) {
            msgs.innerHTML =
                '<p class="sidebar-hint">Não consegui carregar esta conversa.</p>';

            return;
        }

        const { mensagens } =
            await res.json();


        if (!mensagens?.length) {
            msgs.innerHTML =
                '<p class="sidebar-hint">Esta conversa ainda não tem mensagens.</p>';

        } else {

            mensagens.forEach(
                mensagem => {
                    if (
                        mensagem.tipo_sender ===
                        'usuario'
                    ) {
                        adicionarBolhaUsuario(
                            mensagem.conteudo
                        );
                    } else {
                        adicionarRespostaIA(
                            mensagem.conteudo
                        );
                    }
                }
            );
        }

        scrollParaFim();

    } catch (e) {
        console.error(
            'Erro ao carregar histórico:',
            e
        );
    }
}


function resetarChat() {
    idConversaAtiva =
        null;

    atualizarTituloConversa(
        'Novo chat'
    );

    const msgs =
        document.getElementById(
            'msgs'
        );

    if (msgs) {
        msgs.innerHTML =
            '';
    }

    mostrarWelcome(
        true
    );

    esconderTypingIndicator();

    if (
        typeof window.IanaHUD !==
        'undefined'
    ) {
        window.IanaHUD.setEstado?.(
            'ocioso'
        );
    }

    if (usuarioAtual) {
        carregarHistorico();
    }
}


/* ────────────────────────────────────────────────────────────────
   FEEDBACK
   ──────────────────────────────────────────────────────────────── */

async function enviarFeedback() {
    const assunto =
        document.getElementById(
            'fb-assunto'
        )?.value.trim();

    const texto =
        document.getElementById(
            'fb-texto'
        )?.value.trim();

    const autoriza =
        document.getElementById(
            'fb-autoriza'
        )?.checked;

    const btn =
        document.getElementById(
            'btn-fb-enviar'
        );

    if (!assunto) {
        alert(
            'Preencha o assunto.'
        );

        return;
    }

    if (!texto) {
        alert(
            'Descreva seu feedback.'
        );

        return;
    }

    if (!autoriza) {
        alert(
            'Marque a autorização de uso.'
        );

        return;
    }

    const original =
        btn?.textContent ||
        'Enviar';

    if (btn) {
        btn.textContent =
            'Enviando...';

        btn.disabled =
            true;
    }

    try {
        const res =
            await fetch(
                '/feedback',
                {
                    method: 'POST',

                    credentials:
                        'include',

                    headers: {
                        'Content-Type':
                            'application/json'
                    },

                    body:
                        JSON.stringify({
                            assunto,
                            texto,
                            autorizou:
                                autoriza
                        })
                }
            );

        if (!res.ok) {
            throw new Error(
                'Erro ao enviar feedback.'
            );
        }

        alert(
            '✅ Feedback enviado! Obrigado.'
        );

        fecharAuth();

        document.getElementById(
            'fb-assunto'
        ).value = '';

        document.getElementById(
            'fb-texto'
        ).value = '';

        document.getElementById(
            'fb-autoriza'
        ).checked = false;

    } catch (e) {
        console.error(
            'Feedback:',
            e
        );

        alert(
            'Erro ao enviar feedback.'
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


/* ────────────────────────────────────────────────────────────────
   INICIALIZAÇÃO
   ──────────────────────────────────────────────────────────────── */

document.addEventListener(
    'DOMContentLoaded',
    () => {

        verificarSessao();

        mostrarWelcome(
            true
        );

        iniciarMenuUpload();

        iniciarUpload();

        iniciarGravacaoAudio();


        /*
         * SIDEBAR
         */
        const sidebar =
            document.getElementById(
                'sidebar'
            );

        const topbarMenu =
            document.getElementById(
                'topbar-menu-toggle'
            );

        const sidebarToggle =
            document.getElementById(
                'sidebar-toggle'
            );


        function alternarSidebar() {
            if (!sidebar) {
                return;
            }

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
        }


        sidebarToggle
            ?.addEventListener(
                'click',
                alternarSidebar
            );

        topbarMenu
            ?.addEventListener(
                'click',
                alternarSidebar
            );


        document
            .getElementById(
                'btn-novo-chat'
            )
            ?.addEventListener(
                'click',
                resetarChat
            );


        document
            .getElementById(
                'btn-buscar'
            )
            ?.addEventListener(
                'click',
                () =>
                    mostrarTela(
                        'tela-pesquisa'
                    )
            );


        /*
         * MENU USUÁRIO
         */
        const btnMenu =
            document.getElementById(
                'btn-user-menu'
            );

        const dropdown =
            document.getElementById(
                'user-dropdown'
            );


        btnMenu?.addEventListener(
            'click',
            event => {
                event.stopPropagation();

                dropdown?.classList.toggle(
                    'aberto'
                );
            }
        );


        /*
         * MENU PERFIL TOPO
         */
        const topProfileBtn =
            document.getElementById(
                'topbar-profile-btn'
            );

        const topProfileDropdown =
            document.getElementById(
                'topbar-profile-dropdown'
            );


        topProfileBtn
            ?.addEventListener(
                'click',
                event => {
                    event.stopPropagation();

                    topProfileDropdown
                        ?.classList.toggle(
                            'aberto'
                        );
                }
            );


        document.addEventListener(
            'click',
            () => {
                dropdown
                    ?.classList.remove(
                        'aberto'
                    );

                topProfileDropdown
                    ?.classList.remove(
                        'aberto'
                    );

                fecharChatOptionsMenu();
            }
        );


        /*
         * MENU DROPDOWN
         */
        document
            .getElementById(
                'dd-config'
            )
            ?.addEventListener(
                'click',
                () => {
                    window.location.href =
                        '/configuracoes';
                }
            );


        document
            .getElementById(
                'dd-feedback'
            )
            ?.addEventListener(
                'click',
                () => {
                    dropdown
                        ?.classList.remove(
                            'aberto'
                        );

                    mostrarTela(
                        'tela-feedback'
                    );
                }
            );


        document
            .getElementById(
                'dd-logout'
            )
            ?.addEventListener(
                'click',
                realizarLogout
            );


        document
            .getElementById(
                'top-dd-config'
            )
            ?.addEventListener(
                'click',
                () => {
                    topProfileDropdown
                        ?.classList.remove(
                            'aberto'
                        );

                    window.location.href =
                        '/configuracoes';
                }
            );


        document
            .getElementById(
                'top-dd-feedback'
            )
            ?.addEventListener(
                'click',
                () => {
                    topProfileDropdown
                        ?.classList.remove(
                            'aberto'
                        );

                    mostrarTela(
                        'tela-feedback'
                    );
                }
            );


        document
            .getElementById(
                'top-dd-logout'
            )
            ?.addEventListener(
                'click',
                () => {
                    topProfileDropdown
                        ?.classList.remove(
                            'aberto'
                        );

                    realizarLogout();
                }
            );


        document
            .getElementById(
                'top-dd-login'
            )
            ?.addEventListener(
                'click',
                () => {
                    topProfileDropdown
                        ?.classList.remove(
                            'aberto'
                        );

                    mostrarTela(
                        'tela-login'
                    );
                }
            );


        document
            .getElementById(
                'top-dd-register'
            )
            ?.addEventListener(
                'click',
                () => {
                    topProfileDropdown
                        ?.classList.remove(
                            'aberto'
                        );

                    mostrarTela(
                        'tela-cadastro'
                    );
                }
            );


        /*
         * LOGIN / REGISTRO
         */
        document
            .getElementById(
                'btn-entrar'
            )
            ?.addEventListener(
                'click',
                () =>
                    mostrarTela(
                        'tela-login'
                    )
            );


        document
            .getElementById(
                'btn-registrar'
            )
            ?.addEventListener(
                'click',
                () =>
                    mostrarTela(
                        'tela-cadastro'
                    )
            );


        /*
         * OVERLAY AUTH
         */
        document
            .getElementById(
                'overlay-auth'
            )
            ?.addEventListener(
                'click',
                event => {
                    if (
                        event.target.id ===
                        'overlay-auth'
                    ) {
                        fecharAuth();
                    }
                }
            );


        /*
         * BOTÕES AUTH
         */
        document
            .getElementById(
                'btn-login'
            )
            ?.addEventListener(
                'click',
                realizarLogin
            );


        document
            .getElementById(
                'btn-cadastrar'
            )
            ?.addEventListener(
                'click',
                realizarCadastro
            );


        document
            .getElementById(
                'btn-enviar-cod'
            )
            ?.addEventListener(
                'click',
                enviarCodigoRecuperacao
            );


        document
            .getElementById(
                'btn-mudar-senha'
            )
            ?.addEventListener(
                'click',
                alterarSenha
            );


        document
            .getElementById(
                'btn-salvar-rename'
            )
            ?.addEventListener(
                'click',
                salvarRenomear
            );


        document
            .getElementById(
                'btn-confirmar-excluir'
            )
            ?.addEventListener(
                'click',
                confirmarExcluir
            );


        document
            .getElementById(
                'btn-fb-enviar'
            )
            ?.addEventListener(
                'click',
                enviarFeedback
            );


        document
            .getElementById(
                'login-senha'
            )
            ?.addEventListener(
                'keydown',
                event => {
                    if (
                        event.key ===
                        'Enter'
                    ) {
                        realizarLogin();
                    }
                }
            );


        document
            .getElementById(
                'cad-senha'
            )
            ?.addEventListener(
                'keydown',
                event => {
                    if (
                        event.key ===
                        'Enter'
                    ) {
                        realizarCadastro();
                    }
                }
            );


        document
            .getElementById(
                'pesquisa-input'
            )
            ?.addEventListener(
                'input',
                event =>
                    pesquisarConversas(
                        event.target.value
                    )
            );


        /*
         * VOZ
         */
        document
            .getElementById(
                'btn-voz-call'
            )
            ?.addEventListener(
                'click',
                abrirVoz
            );


        /*
         * Botão interno.
         */
        document
            .getElementById(
                'btn-voz-encerrar'
            )
            ?.addEventListener(
                'click',
                fecharVoz
            );


        /*
         * Botão X do overlay.
         */
        document
            .getElementById(
                'btn-voz-fechar'
            )
            ?.addEventListener(
                'click',
                fecharVoz
            );


        document
            .getElementById(
                'btn-voz-mute'
            )
            ?.addEventListener(
                'click',
                toggleMuteVoz
            );


        /*
         * CÂMERA
         */
        document
            .getElementById(
                'btn-capturar-foto'
            )
            ?.addEventListener(
                'click',
                capturarFoto
            );


        /*
         * ENVIO
         */
        document
            .getElementById(
                'btn-send'
            )
            ?.addEventListener(
                'click',
                enviarMensagem
            );


        document
            .getElementById(
                'btn-stop'
            )
            ?.addEventListener(
                'click',
                pararRespostaIA
            );


        const textarea =
            document.getElementById(
                'chat-input'
            );


        textarea?.addEventListener(
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


        textarea?.addEventListener(
            'input',
            function () {
                this.style.height =
                    'auto';

                this.style.height =
                    this.scrollHeight +
                    'px';
            }
        );


        /*
         * MENU DE HISTÓRICO
         */
        document
            .getElementById(
                'historico-lista'
            )
            ?.addEventListener(
                'scroll',
                fecharChatOptionsMenu,
                {
                    passive: true
                }
            );


        window.addEventListener(
            'resize',
            fecharChatOptionsMenu
        );
    }
);


/* ────────────────────────────────────────────────────────────────
   GLOBAIS PARA HTML INLINE
   ──────────────────────────────────────────────────────────────── */

window.mostrarTela =
    mostrarTela;

window.fecharAuth =
    fecharAuth;

window.fecharCamera =
    fecharCamera;

window.usarSugestao =
    usarSugestao;

window.abrirVoz =
    abrirVoz;

window.fecharVoz =
    fecharVoz;

window.capturarFoto =
    capturarFoto;