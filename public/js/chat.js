let aguardandoResposta = false;
let conversas = [];
let idConversaAtiva = null;
let usuarioLogado = null;

const welcomeScreen    = document.querySelector('.welcome-container');
const chatBox          = document.getElementById('chat-box');
const userInput        = document.getElementById('user-input');
const sendBtn          = document.getElementById('send-btn');
const historyContainer = document.getElementById('history-container');
const userGreeting     = document.getElementById('user-greeting');

// ── INICIALIZAÇÃO ─────────────────────────────────────────────────────────────
async function init() {
    const res  = await fetch('/auth/me', { credentials: 'include' });
    const data = await res.json();

    if (data.logado) {
        usuarioLogado = data.usuario;
        atualizarHeaderLogado();
        carregarHistorico();
    }
    // Se não logado, só mostra a tela normal — sem forçar modal
}

// ── HEADER ────────────────────────────────────────────────────────────────────
function atualizarHeaderLogado() {
    document.querySelector('.btn-login').style.display  = 'none';
    document.querySelector('.btn-signup').style.display = 'none';

    const header = document.querySelector('.user-auth');
    if (!document.getElementById('btn-logout')) {
        const btnLogout = document.createElement('button');
        btnLogout.id        = 'btn-logout';
        btnLogout.className = 'btn-login';
        btnLogout.textContent = `Sair (${usuarioLogado.nome})`;
        btnLogout.onclick   = logout;
        header.appendChild(btnLogout);
    }

    // Saudação dinâmica na tela de boas vindas
    if (userGreeting) {
        const frases = [
            `Fala, ${usuarioLogado.nome}! 👋 Pronto pra dominar algum jogo hoje?`,
            `${usuarioLogado.nome}! De volta à arena 🎮 No que posso te ajudar?`,
            `Ei, ${usuarioLogado.nome}! 🕹️ Qual conquista a gente vai desbloquear hoje?`,
            `Oi, ${usuarioLogado.nome}! ✨ Qual desafio você trouxe pra mim?`
        ];
        userGreeting.textContent = frases[Math.floor(Math.random() * frases.length)];
    }
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
async function login(email, senha) {
    const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, senha })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.erro);
    usuarioLogado = data.usuario;
    fecharModal();
    atualizarHeaderLogado();
    carregarHistorico();
}

async function registro(nome, email, senha) {
    const res = await fetch('/auth/registro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ nome, email, senha })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.erro);
    usuarioLogado = data.usuario;
    fecharModal();
    atualizarHeaderLogado();
    carregarHistorico();
}

async function logout() {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    usuarioLogado = null;
    conversas     = [];
    idConversaAtiva = null;

    // Volta os botões do header
    document.querySelector('.btn-login').style.display  = '';
    document.querySelector('.btn-signup').style.display = '';
    const btnLogout = document.getElementById('btn-logout');
    if (btnLogout) btnLogout.remove();

    // Limpa histórico lateral e chat
    historyContainer.innerHTML = '';
    chatBox.innerHTML = '';
    chatBox.style.display = 'none';
    if (welcomeScreen) welcomeScreen.style.display = 'flex';
    if (userGreeting) userGreeting.textContent = 'Conheça a Iana, sua assistente de IA para jogos';
}

function loginGoogle() {
    window.location.href = '/auth/google';
}

// ── MODAIS ────────────────────────────────────────────────────────────────────
const inputStyle = `
    width:100%; padding:10px; margin-bottom:12px; background:#151515;
    border:1px solid #333; color:white; border-radius:8px;
    font-size:14px; box-sizing:border-box; outline:none;
`;
const btnPrimaryStyle = `
    width:100%; padding:11px; background:#a855f7; color:white;
    border:none; border-radius:8px; cursor:pointer; font-size:15px; font-weight:600;
`;
const btnGoogleStyle = `
    width:100%; padding:10px; background:#fff; color:#333;
    border:none; border-radius:8px; cursor:pointer; font-size:14px;
    display:flex; align-items:center; justify-content:center; gap:10px; font-weight:500;
`;

function mostrarModal(tipo) {
    let modal = document.getElementById('modal-auth');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'modal-auth';
        modal.style.cssText = `
            display:flex; position:fixed; top:0; left:0; width:100%; height:100%;
            background:rgba(0,0,0,0.85); justify-content:center; align-items:center; z-index:2000;
        `;
        document.body.appendChild(modal);
    }

    const isLogin = tipo === 'login';
    modal.innerHTML = `
        <div style="background:#1e1f20; padding:30px; border-radius:12px; width:340px; color:white; border:1px solid #333;">
            <h2 style="margin-bottom:20px; text-align:center;">${isLogin ? '👾 Entrar' : '🎮 Criar conta'}</h2>

            ${!isLogin ? `<input id="auth-nome" type="text" placeholder="Seu nome" style="${inputStyle}">` : ''}
            <input id="auth-email" type="email" placeholder="Email" style="${inputStyle}">
            <input id="auth-senha" type="password" placeholder="Senha" style="${inputStyle}">

            <p id="auth-erro" style="color:#f87171; font-size:13px; min-height:18px; margin-bottom:8px;"></p>

            <button onclick="${isLogin ? 'submitLogin()' : 'submitRegistro()'}" style="${btnPrimaryStyle}">
                ${isLogin ? 'Entrar' : 'Criar conta'}
            </button>

            <div style="display:flex; align-items:center; gap:10px; margin:15px 0;">
                <hr style="flex:1; border-color:#333;">
                <span style="color:#666; font-size:12px;">ou</span>
                <hr style="flex:1; border-color:#333;">
            </div>

            <button onclick="loginGoogle()" style="${btnGoogleStyle}">
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" style="width:18px;">
                Continuar com Google
            </button>

            <p style="text-align:center; margin-top:15px; font-size:13px; color:#aaa;">
                ${isLogin
                    ? `Não tem conta? <span onclick="mostrarModal('registro')" style="color:#a855f7; cursor:pointer;">Criar conta</span>`
                    : `Já tem conta? <span onclick="mostrarModal('login')" style="color:#a855f7; cursor:pointer;">Entrar</span>`
                }
            </p>

            <p style="text-align:center; margin-top:8px;">
                <span onclick="fecharModal()" style="color:#666; font-size:12px; cursor:pointer;">Continuar sem login</span>
            </p>
        </div>
    `;

    modal.style.display = 'flex';
}

function fecharModal() {
    const modal = document.getElementById('modal-auth');
    if (modal) modal.style.display = 'none';
}

async function submitLogin() {
    const email = document.getElementById('auth-email').value.trim();
    const senha = document.getElementById('auth-senha').value;
    try {
        await login(email, senha);
    } catch (e) {
        document.getElementById('auth-erro').textContent = e.message;
    }
}

async function submitRegistro() {
    const nome  = document.getElementById('auth-nome').value.trim();
    const email = document.getElementById('auth-email').value.trim();
    const senha = document.getElementById('auth-senha').value;
    try {
        await registro(nome, email, senha);
    } catch (e) {
        document.getElementById('auth-erro').textContent = e.message;
    }
}

// ── CONVERSAS ─────────────────────────────────────────────────────────────────
function abrirNovaConversa() {
    idConversaAtiva = 'chat_' + Date.now();
    chatBox.innerHTML = '';
    chatBox.style.display = 'block';
    if (welcomeScreen) welcomeScreen.style.display = 'none';
}

async function carregarHistorico() {
    if (!usuarioLogado) return; // Só carrega se estiver logado
    try {
        const res = await fetch('/historico', { credentials: 'include' });
        if (!res.ok) return;
        conversas = await res.json();
        renderizarHistoricoLateral();
    } catch (err) {
        console.error('Falha no histórico:', err);
    }
}

async function carregarMensagens(id) {
    try {
        const res = await fetch(`/mensagens?conversa_id=${id}`, { credentials: 'include' });
        const mensagens = await res.json();
        let c = conversas.find(conv => conv.id === id);
        if (c) {
            c.mensagens = mensagens;
        } else {
            conversas.push({ id, mensagens, titulo: 'Nova Conversa' });
        }
        renderizarMensagens();
    } catch (err) {
        console.error('Falha ao carregar mensagens:', err);
    }
}

function carregarConversaExistente(id) {
    idConversaAtiva = id;
    carregarMensagens(id);
}

// ── ENVIO ─────────────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', async () => {
    const texto = userInput.value.trim();
    if (aguardandoResposta || texto === '') return;

    userInput.value = '';
    userInput.style.height = 'auto';

    if (!idConversaAtiva) abrirNovaConversa();

    aguardandoResposta = true;
    sendBtn.disabled   = true;

    adicionarBolha(texto, 'user');

    try {
        // Se logado → salva no banco. Se não → só chama a IA
        const body = usuarioLogado
            ? { mensagem: texto, conversa_id: idConversaAtiva }
            : { mensagem: texto, conversa_id: idConversaAtiva, anonimo: true };

        const response = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body)
        });

        if (!response.ok) throw new Error('Erro na resposta do servidor');
        const data = await response.json();
        adicionarBolha(data.resposta, 'iana');

    } catch (e) {
        console.error(e);
        adicionarBolha('Ops! Algo deu errado. Tente novamente.', 'iana');
    } finally {
        aguardandoResposta = false;
        sendBtn.disabled   = false;
    }
});

userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
    }
});

userInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = this.scrollHeight + 'px';
});

// ── RENDERIZAÇÃO ──────────────────────────────────────────────────────────────
function adicionarBolha(texto, remetente) {
    chatBox.style.display = 'block';
    if (welcomeScreen) welcomeScreen.style.display = 'none';

    const isUser = remetente === 'user';
    const div    = document.createElement('div');
    div.style.cssText = `margin:15px; text-align:${isUser ? 'right' : 'left'};`;
    div.innerHTML = `
        <div style="display:inline-block; padding:12px 18px; border-radius:20px;
                    background:${isUser ? '#581c87' : '#1e1f20'}; color:white;
                    max-width:80%; text-align:left; line-height:1.5;">
            ${texto.replace(/\n/g, '<br>')}
        </div>
    `;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function renderizarMensagens() {
    chatBox.innerHTML = '';
    chatBox.style.display = 'block';
    if (welcomeScreen) welcomeScreen.style.display = 'none';
    const conversa = conversas.find(c => c.id === idConversaAtiva);
    if (!conversa || !conversa.mensagens) return;
    conversa.mensagens.forEach(msg => adicionarBolha(msg.texto, msg.remetente));
}

function renderizarHistoricoLateral() {
    historyContainer.innerHTML = '';
    conversas.forEach(chat => {
        const item = document.createElement('div');
        item.className    = 'chat-item';
        item.style.cssText = 'cursor:pointer; padding:10px; border-radius:8px;';
        item.innerHTML    = `🎮 ${chat.titulo || 'Conversa sem título'}`;
        item.onclick      = () => carregarConversaExistente(chat.id);
        historyContainer.appendChild(item);
    });
}

// ── BOTÕES DO HEADER ──────────────────────────────────────────────────────────
document.querySelector('.btn-login').onclick  = () => mostrarModal('login');
document.querySelector('.btn-signup').onclick = () => mostrarModal('registro');

// ── START ─────────────────────────────────────────────────────────────────────
init();