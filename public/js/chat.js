/* ================================================================
   IANA — chat.js — reescrito e otimizado
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

/* ── TTS (TEXT-TO-SPEECH) ─────────────────────────────────────── */
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

/* ── MODAL CHAMADA DE VOZ ─────────────────────────────────────── */
function abrirVoz() {
    const overlay = document.getElementById('overlay-voz');
    if (overlay) overlay.style.display = 'flex';
    iniciarReconhecimentoVoz();
}

function fecharVoz() {
    const overlay = document.getElementById('overlay-voz');
    if (overlay) overlay.style.display = 'none';
    if (window._recognitionVoz) { 
        try { window._recognitionVoz.stop(); } catch (e) { } 
    }
    if (streamVoz) { 
        streamVoz.getTracks().forEach(t => t.stop()); 
        streamVoz = null; 
    }
}

function iniciarReconhecimentoVoz() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const statusEl = document.getElementById('voz-status');
    const transcriptEl = document.getElementById('voz-transcript');
    
    if (!SpeechRecognition) {
        if (statusEl) statusEl.textContent = 'Reconhecimento de voz não suportado neste navegador.';
        return;
    }
    
    const rec = new SpeechRecognition();
    rec.lang = 'pt-BR';
    rec.continuous = true;
    rec.interimResults = true;
    window._recognitionVoz = rec;

    rec.onresult = (e) => {
        let texto = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            texto += e.results[i][0].transcript;
        }
        if (transcriptEl) transcriptEl.textContent = texto;
        if (e.results[e.results.length - 1].isFinal && texto.trim()) {
            if (statusEl) statusEl.textContent = 'Processando...';
            ttsNextResponse = true;
            processarEnvioIA(texto.trim()).then(() => {
                if (statusEl) statusEl.textContent = 'Fale sua pergunta';
                if (transcriptEl) transcriptEl.textContent = '';
            });
        }
    };
    
    rec.onerror = () => { 
        if (statusEl) statusEl.textContent = 'Erro ao ouvir. Tente novamente.'; 
    };
    
    rec.start();
}

function toggleMuteVoz() {
    const btn = document.getElementById('btn-voz-mute');
    if (window._recognitionVoz) {
        try { window._recognitionVoz.stop(); } catch (e) { }
        window._recognitionVoz = null;
        if (btn) btn.textContent = '🔇';
    } else {
        iniciarReconhecimentoVoz();
        if (btn) btn.textContent = '🎙️';
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

            item.innerHTML = `
                <span class="chat-titulo">${tituloOriginal}</span>
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
                const menu = item.querySelector('.chat-options-menu');
                document.querySelectorAll('.chat-options-menu').forEach(m => { 
                    if (m !== menu) m.classList.remove('ativo'); 
                });
                menu.classList.toggle('ativo');
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
    btn.innerHTML = '📋';
    btn.addEventListener('click', () => {
        const texto = getTexto();
        navigator.clipboard?.writeText(texto).then(() => {
            const original = btn.innerHTML;
            btn.innerHTML = '✅';
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
    btn.innerHTML = '✏️';
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
    wrap.className = 'user-msg-wrap';

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
    container.className = 'iana-response-container';

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
        falar(texto); 
        ttsNextResponse = false; 
    }
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

    adicionarBolhaUsuario(conteudo);
    mostrarTypingIndicator();

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
            if (usuarioAtual) carregarHistorico();
        }

        esconderTypingIndicator();
        adicionarRespostaIA(data.resposta);

    } catch (e) {
        esconderTypingIndicator();
        if (e.name !== 'AbortError') {
            adicionarRespostaIA('Desculpe, não consegui processar sua solicitação no momento.');
            console.error('Erro no envio:', e);
        }
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
        const body = {
            _subject: `[Iana Feedback] ${assunto}`,
            Assunto: assunto,
            Mensagem: texto,
            Autorizou: autoriza ? 'Sim' : 'Não',
            _template: 'box',
            _captcha: 'false'
        };
        const res = await fetch('https://formsubmit.co/ajax/SEU_EMAIL_AQUI', { // Substitua pelo seu email válido se for usar em prod
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(body)
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