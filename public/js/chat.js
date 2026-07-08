/* ================================================================
   IANA — chat.js — VERSÃO FINAL COMPLETA UNIFICADA (2026)
   ================================================================ */

let aguardandoResposta = false;
let idConversaAtiva    = null;
let controller         = new AbortController();
let emailRecuperacao   = '';
let idConversaRenomear = null;
let usuarioLogado      = 'visitante';
let mediaRecorder, audioChunks = [], gravandoAudio = false;
let streamTelaCompartilhada = null;
let ttsEnabled = true; // Text-to-speech feature gate
let ttsNextResponse = false;
let vozSelecionada = null;
let ttsVoice = null;

const TELAS = [
    'tela-login','tela-cadastro','tela-esqueci','tela-codigo',
    'tela-pesquisa','tela-feedback','tela-renomear','tela-confirmacao'
];

/* ── FUNÇÕES TTS (TEXT-TO-SPEECH) ─────────────────────────────── */
function escolherVozTTS() {
    if (ttsVoice) return ttsVoice;
    atualizarVozTTS();
    return ttsVoice;
}

function getVoicesTTS() {
    return typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : [];
}

function atualizarVozTTS() {
    const voices = getVoicesTTS();
    if (!voices.length) return;
    const preferida = voices.find(v => /pt-BR|pt|Português|Portuguese/i.test(v.lang) && /feminino|female|zira|helena|marília|marilia|alloy|nina|luciana|vitoria|victoria|sophia|calma|suave|forte/i.test(v.name));
    ttsVoice = preferida || voices.find(v => /pt-BR|pt|Português|Portuguese/i.test(v.lang)) || voices[0];
}

function criarValorVoz(voz) {
    return encodeURIComponent(JSON.stringify({ name: voz.name, lang: voz.lang, uri: voz.voiceURI }));
}

function encontrarVoz(valor) {
    try {
        const info = JSON.parse(decodeURIComponent(valor));
        return getVoicesTTS().find(v => v.name === info.name && v.lang === info.lang && v.voiceURI === info.uri) || null;
    } catch { return null; }
}

function atualizarListaVozesTTS() {
    const select = document.getElementById('voice-selector-modal'); 
    if (!select) return;
    const voices = getVoicesTTS();
    const preferidas = voices.filter(v => /pt-BR|pt|Português|Portuguese/i.test(v.lang) && /feminino|female|zira|helena|marília|marilia|alloy|nina|luciana|vitoria|victoria|sophia|calma|suave|forte/i.test(v.name));
    const items = preferidas.length ? preferidas : voices.filter(v => /pt-BR|pt|Português|Portuguese/i.test(v.lang));

    select.innerHTML = '<option value="">Padrão feminino</option>';
    items.forEach(voz => {
        select.insertAdjacentHTML('beforeend', `<option value="${criarValorVoz(voz)}">${voz.name}</option>`);
    });
}

function aplicarVozSelecionada() {
    const select = document.getElementById('voice-selector-modal'); 
    if (select && select.value) vozSelecionada = encontrarVoz(select.value);
    else vozSelecionada = null;
}

/* ── UTILS ────────────────────────────────────────────────────── */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── MODAIS ───────────────────────────────────────────────────── */
function mostrarTela(id) {
    TELAS.forEach(t => {
        const el = document.getElementById(t);
        if (el) el.style.display = t === id ? 'flex' : 'none';
    });
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function fecharModal() {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.style.display = 'none';
    TELAS.forEach(t => { const el = document.getElementById(t); if (el) el.style.display = 'none'; });
}

function erro(id, msg) {
    const el = document.getElementById(id);
    if (el) { el.textContent = msg; el.style.color = '#f87171'; }
}

function mensagemErroAuth(msg, fallback = 'Erro inesperado.') {
    const texto = String(msg || '').toLowerCase();

    if (texto.includes('já cadastrado') || texto.includes('already registered') || texto.includes('já existe')) {
        return 'Este e-mail já está cadastrado.';
    }
    if (texto.includes('não cadastrado') || texto.includes('não encontrado') || texto.includes('inexistente')) {
        return 'Este e-mail não está cadastrado.';
    }
    if (texto.includes('senha incorreta') || texto.includes('senha inválida') || texto.includes('invalid password')) {
        return 'Senha inválida. Verifique os dados e tente novamente.';
    }
    return fallback;
}

/* ── TYPING INDICATOR — SÓ 3 PONTINHOS, SEM BALÃO ────────────── */
function mostrarTypingIndicator() {
    const chatBox = document.getElementById('chat-box');
    const welcome = document.getElementById('welcome-view');
    if (!chatBox) return;
    if (welcome) welcome.style.display = 'none';
    chatBox.classList.add('has-messages');

    const typing = document.createElement('div');
    typing.id = 'typing-indicator';
    typing.className = 'iana-response-container iana-thinking-clean';
    typing.innerHTML = `
        <img src="/img/iana-avatar.png" class="iana-avatar-img">
        <div class="iana-typing-indicator">
            <div class="typing-dots"><span></span><span></span><span></span></div>
        </div>`;
    chatBox.appendChild(typing);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function esconderTypingIndicator() {
    document.getElementById('typing-indicator')?.remove();
}

function pararRespostaIA() {
    try { controller.abort(); } catch (e) {}
    controller = new AbortController();
    aguardandoResposta = false;
    esconderTypingIndicator();
    const stop  = document.getElementById('btn-stop-response');
    const send  = document.getElementById('send-btn');
    const input = document.getElementById('chat-input');
    if (stop)  stop.style.display  = 'none';
    if (send)  send.style.display  = 'flex';
    if (input) { input.disabled = false; input.placeholder = 'Peça à Iana...'; }
}

/* ── SESSÃO E IDENTIDADE ───────────────────────────────────────── */
async function verificarSessao() {
    try {
        const res  = await fetch('/auth/me', { credentials: 'include' });
        const data = await res.json();
        if (data.logado) atualizarUILogado(data.usuario);
        else atualizarUIVisitante();
    } catch (e) { atualizarUIVisitante(); }
}

function carregarHistoricoVisitante() {
    const container = document.getElementById('history-container');
    if (container) container.innerHTML = '<div style="color:#666;padding:15px;font-size:.85rem;text-align:center;">Faça login para salvar seu histórico.</div>';
}

function atualizarUIVisitante() {
    usuarioLogado = null;
    const authHeader = document.getElementById('user-auth-header');
    if (authHeader) authHeader.style.display = 'flex';

    const perfil = document.getElementById('user-profile-section');
    if (perfil) perfil.style.display = 'none';

    const nomeEl = document.getElementById('sidebar-user-name');
    if (nomeEl) nomeEl.textContent = '';

    carregarHistoricoVisitante();
}

function atualizarUILogado(usuario) {
    usuarioLogado = usuario.email || usuario.id || usuario.nome;

    const authHeader = document.getElementById('user-auth-header');
    if (authHeader) authHeader.style.display = 'none';

    const perfil = document.getElementById('user-profile-section');
    const nomeEl = document.getElementById('sidebar-user-name');
    if (perfil) perfil.style.display = 'block';
    if (nomeEl) nomeEl.textContent   = usuario.nome;

    const g = document.getElementById('user-greeting');
    if (g) {
        const h = new Date().getHours();
        const s = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
        const frases = [
            `${s}, ${usuario.nome}! Você consegue se desafiar`,
            `${s}, ${usuario.nome}! Você é melhor que você pensa`,
            `Ei, ${usuario.nome}! Talvez eu possa te ajudar`,
            `Olá, ${usuario.nome}! Me diga como posso te ajudar`
        ];
        g.innerHTML = `<span class="gradient-text">${frases[Math.floor(Math.random()*frases.length)]}</span>`;
    }

    carregarHistorico();
}

/* ── AUTH ─────────────────────────────────────────────────────── */
async function realizarLogin() {
    const email = document.getElementById('login-email')?.value.trim();
    const senha = document.getElementById('login-senha')?.value;
    if (!email || !senha) { erro('login-erro', 'Preencha e-mail e senha.'); return; }
    const btn = document.getElementById('btn-efetuar-login');
    if (!btn) return;
    const orig = btn.textContent; btn.textContent = 'Entrando...'; btn.disabled = true;
    try {
        const res  = await fetch('/auth/login', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email,senha}) });
        const data = await res.json();
        if (!res.ok) erro('login-erro', mensagemErroAuth(data.erro, 'Falha no login.'));
        else { fecharModal(); atualizarUILogado(data.usuario); }
    } catch (e) { erro('login-erro','Erro de conexão.'); }
    finally { btn.textContent = orig; btn.disabled = false; }
}

async function realizarCadastro() {
    const nome  = document.getElementById('cadastro-nome')?.value.trim();
    const email = document.getElementById('cadastro-email')?.value.trim();
    const senha = document.getElementById('cadastro-senha')?.value;
    if (!nome||!email||!senha) { erro('cadastro-erro','Preencha todos os campos.'); return; }
    const btn = document.getElementById('btn-efetuar-cadastro');
    if (!btn) return;
    const orig = btn.textContent; btn.textContent = 'Registrando...'; btn.disabled = true;
    try {
        const res  = await fetch('/auth/registro', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({nome,email,senha}) });
        const data = await res.json();
        if (!res.ok) erro('cadastro-erro', mensagemErroAuth(data.erro, 'Falha no cadastro.'));
        else { fecharModal(); atualizarUILogado(data.usuario); }
    } catch (e) { erro('cadastro-erro','Erro de conexão.'); }
    finally { btn.textContent = orig; btn.disabled = false; }
}

async function realizarLogout() {
    try {
        const res = await fetch('/auth/logout', { method:'POST', credentials:'include' });
        if (res.ok) {
            atualizarUIVisitante();
            mostrarTela('tela-login');
        }
    } catch (e) {
        console.warn('Logout failed:', e);
        atualizarUIVisitante();
    }
}

async function enviarCodigo() {
    const email  = document.getElementById('esq-email')?.value.trim();
    const erroEl = document.getElementById('esq-erro');
    if (!email) { erro('esq-erro','Digite seu e-mail.'); return; }
    if (erroEl) { erroEl.style.color = '#a855f7'; erroEl.textContent = 'Enviando...'; }
    
    try {
        const res  = await fetch('/auth/esqueci-senha', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email}) });
        const data = await res.json();
        if (!res.ok) { 
            if (erroEl) { erroEl.style.color='#f87171'; erroEl.textContent = mensagemErroAuth(data.erro, 'Não foi possível enviar o código.'); }
        } else {
            emailRecuperacao = email;
            const label = document.getElementById('esq-email-label');
            if (label) label.textContent = `Código enviado para ${email}`;
            mostrarTela('tela-codigo');
        }
    } catch (e) { if (erroEl) { erroEl.style.color='#f87171'; erroEl.textContent='Erro de conexão.'; } }
}

async function mudarSenha() {
    const codigo    = document.getElementById('esq-codigo')?.value.trim();
    const novaSenha = document.getElementById('esq-nova-senha')?.value;
    if (!codigo||!novaSenha) { erro('codigo-erro','Preencha o código e a nova senha.'); return; }
    
    try {
        const res  = await fetch('/auth/mudar-senha', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:emailRecuperacao,codigo,nova_senha:novaSenha}) });
        const data = await res.json();
        if (!res.ok) erro('codigo-erro', mensagemErroAuth(data.erro, 'Código inválido.'));
        else { 
            alert('✅ Senha alterada! Faça login.'); 
            const erroEsq = document.getElementById('esq-erro');
            if (erroEsq) erroEsq.textContent = '';
            mostrarTela('tela-login'); 
        }
    } catch (e) { erro('codigo-erro','Erro de conexão.'); }
}

/* ── HISTÓRICO ────────────────────────────────────────────────── */
async function atualizarTituloConversa(titulo) {
    const el = document.getElementById('conversation-title');
    if (el) el.textContent = titulo ? `${titulo}` : 'Novo chat';
}

async function carregarHistorico() {
    const container = document.getElementById('history-container');
    if (!container) return;
    try {
        const res = await fetch('/chat/conversas', { credentials:'include' });
        if (!res.ok) { 
            container.innerHTML = '<div style="color:#666;padding:15px;font-size:.85rem;text-align:center;">Erro ao carregar o histórico.</div>';
            return; 
        }
        const { conversas } = await res.json();
        container.innerHTML = '';

        if (!conversas?.length) {
            container.innerHTML = '<div style="color:#666;padding:15px;font-size:.85rem;text-align:center;">Nenhum chat salvo</div>';
            return;
        }

        conversas.forEach(c => {
            const item = document.createElement('div');
            item.className = `chat-item ${idConversaAtiva === c.id_conversa ? 'active' : ''} ${c.fixada ? 'fixada' : ''}`;
            const tituloSafe = (c.titulo||'Conversa').replace(/'/g,"\\'").replace(/"/g,'\\"');

            item.innerHTML = `
                <span class="chat-titulo">${c.titulo || 'Conversa'}</span>
                <div class="chat-options-wrapper">
                    <button class="btn-chat-options" onclick="event.stopPropagation();toggleChatOptionsMenu(this)">⋮</button>
                    <div class="chat-options-menu">
                        <button class="chat-option-btn" onclick="event.stopPropagation();acaoFixar('${c.id_conversa}',${!c.fixada})">📌 ${c.fixada?'Desafixar':'Fixar'}</button>
                        <button class="chat-option-btn" onclick="event.stopPropagation();acaoRenomear('${c.id_conversa}','${tituloSafe}')">✏️ Renomear</button>
                        <button class="chat-option-btn" style="color:#f87171;" onclick="event.stopPropagation();acaoExcluir('${c.id_conversa}')">🗑️ Excluir</button>
                    </div>
                </div>`;

            const tituloBtn = item.querySelector('.chat-titulo');
            if (tituloBtn) tituloBtn.onclick = () => ativarConversa(c.id_conversa, c.titulo);
            container.appendChild(item);
        });
    } catch (e) { console.error('Histórico:', e); }
}

async function acaoFixar(id, fixar) {
    fecharChatOptionsMenu();
    await fetch(`/chat/conversas/${id}/fixar`, {
        method:'PATCH', credentials:'include',
        headers:{'Content-Type':'application/json'},
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
    if (!novo || !idConversaRenomear) { fecharModal(); return; }
    await fetch(`/chat/conversas/${idConversaRenomear}`, {
        method:'PUT', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ novoTitulo: novo })
    });
    fecharModal();
    carregarHistorico();
}

function acaoExcluir(id) {
    fecharChatOptionsMenu();
    const tituloEl = document.querySelector('#tela-confirmacao .modal-titulo');
    const msgEl    = document.querySelector('#tela-confirmacao .modal-msg');
    if (tituloEl) tituloEl.textContent = 'Excluir conversa';
    if (msgEl)    msgEl.textContent    = 'Tem certeza? Esta ação não pode ser desfeita.';

    const btnConf = document.getElementById('btn-confirmar-acao');
    if (!btnConf) return;
    
    const novo = btnConf.cloneNode(true);
    btnConf.parentNode.replaceChild(novo, btnConf);
    
    const b = document.getElementById('btn-confirmar-acao');
    b.textContent = 'Excluir';
    b.addEventListener('click', async () => {
        await fetch(`/chat/conversas/${id}`, { method:'DELETE', credentials:'include' });
        fecharModal();
        if (idConversaAtiva === id) { resetarChat(); }
        else { carregarHistorico(); }
    });
    mostrarTela('tela-confirmacao');
}

async function ativarConversa(id, titulo) {
    idConversaAtiva = id;
    atualizarTituloConversa(titulo || 'Conversa');
    const chatBox = document.getElementById('chat-box');
    if (!chatBox) return;

    chatBox.querySelectorAll('.iana-response-container, .user-msg-bubble').forEach(el => el.remove());
    const welcome = document.getElementById('welcome-view');
    if (welcome) welcome.style.display = 'none';
    chatBox.classList.add('has-messages');

    const loadingMsg = document.createElement('div');
    loadingMsg.id = 'loading-historico';
    loadingMsg.style.cssText = 'text-align:center;color:#666;padding:20px;font-size:.85rem;';
    loadingMsg.textContent = 'Carregando conversa...';
    chatBox.appendChild(loadingMsg);

    try {
        const res = await fetch(`/chat/historico/${id}`, { credentials: 'include' });
        document.getElementById('loading-historico')?.remove();

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            console.error('Erro ao carregar histórico:', data.erro || res.status);
            const erroMsg = document.createElement('div');
            erroMsg.style.cssText = 'text-align:center;color:#f87171;padding:20px;font-size:.85rem;';
            erroMsg.textContent = 'Não consegui carregar esta conversa.';
            chatBox.appendChild(erroMsg);
            return;
        }

        const { mensagens } = await res.json();

        if (!mensagens || !mensagens.length) {
            const vazio = document.createElement('div');
            vazio.style.cssText = 'text-align:center;color:#666;padding:20px;font-size:.85rem;';
            vazio.textContent = 'Esta conversa ainda não tem mensagens.';
            chatBox.appendChild(vazio);
        } else {
            mensagens.forEach(m => {
                if (m.tipo_sender === 'usuario') {
                    adicionarBolhaUsuario(chatBox, m.conteudo, false);
                } else {
                    adicionarRespostaIA(m.conteudo, false);
                }
            });
        }
        chatBox.scrollTop = chatBox.scrollHeight;
    } catch (e) {
        document.getElementById('loading-historico')?.remove();
        console.error('Erro de conexão ao carregar histórico:', e);
    }
}

function resetarChat() {
    idConversaAtiva = null;
    atualizarTituloConversa('Novo chat');
    const chatBox = document.getElementById('chat-box');
    if (chatBox) {
        chatBox.querySelectorAll('.iana-response-container, .user-msg-bubble').forEach(el => el.remove());
        chatBox.classList.remove('has-messages');
    }
    const welcome = document.getElementById('welcome-view');
    if (welcome) welcome.style.display = 'flex';
    carregarHistorico();
}

async function pesquisarConversas(termo) {
    const resultados = document.getElementById('pesquisa-resultados');
    if (!resultados) return;
    resultados.innerHTML = '';
    if (!termo.trim()) return;
    try {
        const res = await fetch('/chat/conversas', { credentials:'include' });
        const { conversas } = await res.json();
        const found = (conversas||[]).filter(c => c.titulo?.toLowerCase().includes(termo.toLowerCase()));
        if (!found.length) { resultados.innerHTML = '<p style="color:#666;font-size:.85rem;text-align:center;margin-top:10px;">Nenhuma encontrada.</p>'; return; }
        found.forEach(c => {
            const item = document.createElement('div');
            item.style.cssText = 'padding:10px;background:rgba(34,211,238,.08);border-radius:8px;cursor:pointer;border:1px solid rgba(34,211,238,.2);font-size:.88rem;margin-bottom:6px;color:#e3e3e3;';
            item.textContent   = c.titulo || 'Sem título';
            item.onclick       = () => { ativarConversa(c.id_conversa, c.titulo); fecharModal(); };
            resultados.appendChild(item);
        });
    } catch (e) {}
}

function toggleChatOptionsMenu(btn) {
    const menu = btn.parentElement.querySelector('.chat-options-menu');
    document.querySelectorAll('.chat-options-menu').forEach(m => { if (m !== menu) { m.classList.remove('ativo'); m.classList.remove('show'); } });
    menu.classList.toggle('ativo');
}

function fecharChatOptionsMenu() { 
    document.querySelectorAll('.chat-options-menu').forEach(m => { m.classList.remove('ativo'); m.classList.remove('show'); }); 
}

/* ── FEEDBACK + SCREENSHOT ───────────────────────────────────── */
async function capturarScreenshot() {
    fecharModal();
    try {
        const stream  = await navigator.mediaDevices.getDisplayMedia({ video:{ cursor:'always' }, audio:false });
        const video   = document.createElement('video');
        video.srcObject = stream; video.autoplay = true;
        await new Promise(r => { video.onloadedmetadata = r; });
        await sleep(300);
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        stream.getTracks().forEach(t => t.stop());
        window._screenshotDataUrl = canvas.toDataURL('image/png');
        mostrarTela('tela-feedback');
        const dz = document.getElementById('btn-capturar-tela');
        if (dz) dz.innerHTML = `<img src="${window._screenshotDataUrl}" style="max-width:100%;max-height:120px;border-radius:8px;"><span style="font-size:.75rem;color:#22d3ee;display:block;margin-top:6px;">✅ Tela capturada</span>`;
    } catch (e) {
        mostrarTela('tela-feedback');
        if (e.name !== 'NotAllowedError') alert('Erro ao capturar: ' + e.message);
    }
}

async function enviarFeedback() {
    const assunto  = document.getElementById('feedback-assunto')?.value.trim();
    const texto    = document.getElementById('feedback-texto')?.value.trim();
    const autoriza = document.getElementById('feedback-autoriza')?.checked;
    const btn      = document.getElementById('btn-enviar-feedback');
    if (!assunto) { alert('Preencha o assunto.'); return; }
    if (!texto)   { alert('Descreva seu feedback.'); return; }
    if (!autoriza){ alert('Marque a autorização.'); return; }
    const orig = btn.innerText; btn.innerText='Enviando...'; btn.disabled=true;
    try {
        const body = { _subject:`[Iana Feedback] ${assunto}`, Assunto:assunto, Mensagem:texto, Autorizou:autoriza?'Sim':'Não', _template:'box', _captcha:'false' };
        if (window._screenshotDataUrl) body.Screenshot_info = 'Captura de tela incluída pelo usuário.';
        const res = await fetch('https://formsubmit.co', {
            method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body: JSON.stringify(body)
        });
        if (res.ok) {
            alert('✅ Feedback enviado!'); fecharModal();
            document.getElementById('feedback-assunto').value=''; document.getElementById('feedback-texto').value='';
            document.getElementById('feedback-autoriza').checked=false; window._screenshotDataUrl=null;
            const dz = document.getElementById('btn-capturar-tela'); if (dz) dz.textContent = 'Capturar Tela';
        } else alert('Erro ao enviar.');
    } catch (e) { alert('Erro de conexão.'); }
    finally { btn.innerText=orig; btn.disabled=false; }
}

/* ── BOLHAS ───────────────────────────────────────────────────── */
function adicionarBolhaUsuario(chatBox, texto, comAcoes = true) {
    const welcome = document.getElementById('welcome-view');
    if (welcome) welcome.style.display = 'none';
    if (chatBox) chatBox.classList.add('has-messages');

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;width:100%;margin-bottom:8px;';

    const bubble = document.createElement('div');
    bubble.className = 'user-msg-bubble';
    bubble.textContent = texto;

    const grande = texto.length > 500;
    if (grande) {
        bubble.style.maxHeight = '160px';
        bubble.style.overflow  = 'hidden';
        bubble.style.transition = 'max-height .4s ease';
    }

    wrap.appendChild(bubble);

    if (comAcoes) {
        const acoes = document.createElement('div');
        acoes.style.cssText = 'display:flex;gap:8px;margin-top:6px;justify-content:flex-end;';

        if (grande) {
            const btnExp = document.createElement('button');
            btnExp.style.cssText = 'background:none;border:none;cursor:pointer;opacity:.6;font-size:.8rem;color:#22d3ee;';
            btnExp.textContent = '▼ Expandir';
            let exp = false;
            btnExp.onclick = () => {
                exp = !exp;
                bubble.style.maxHeight = exp ? '9999px' : '160px';
                btnExp.textContent = exp ? '▲ Recolher' : '▼ Expandir';
            };
            acoes.appendChild(btnExp);
        }

        const btnEdit = document.createElement('button');
        btnEdit.style.cssText = 'background:none;border:none;cursor:pointer;opacity:.6;font-size:.85rem;';
        btnEdit.innerHTML = '✏️';
        btnEdit.title = 'Editar mensagem';
        btnEdit.onclick = () => {
            const input = document.getElementById('chat-input');
            if (input) {
                input.value = texto;
                input.focus();
                input.style.height = 'auto';
                input.style.height = input.scrollHeight + 'px';
            }
        };
        acoes.appendChild(btnEdit);

        const btnCopy = document.createElement('button');
        btnCopy.style.cssText = 'background:none;border:none;cursor:pointer;opacity:.6;font-size:.85rem;';
        btnCopy.innerHTML = '📋';
        btnCopy.title = 'Copiar';
        btnCopy.onclick = () => navigator.clipboard.writeText(texto);
        acoes.appendChild(btnCopy);

        wrap.appendChild(acoes);
    }

    if (chatBox) {
        chatBox.appendChild(wrap);
        chatBox.scrollTop = chatBox.scrollHeight;
    }
}

function adicionarRespostaIA(texto, comAcoes = true) {
    const chatBox = document.getElementById('chat-box');
    if (!chatBox) return;
    chatBox.classList.add('has-messages');

    const container = document.createElement('div');
    container.className = 'iana-response-container';

    const av = document.createElement('img');
    av.src = '/img/iana-avatar.png';
    av.className = 'iana-avatar-img';
    container.appendChild(av);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0;';

    const bubble = document.createElement('div');
    bubble.className = 'iana-message-bubble';

    const grande = texto.length > 500;
    if (grande) {
        bubble.style.maxHeight = '160px';
        bubble.style.overflow  = 'hidden';
        bubble.style.transition = 'max-height .4s ease';
    }

    bubble.innerHTML = typeof marked !== 'undefined' ? marked.parse(texto) : texto.replace(/\n/g,'<br>');
    wrap.appendChild(bubble);

    if (comAcoes) {
        const acoes = document.createElement('div');
        acoes.style.cssText = 'display:flex;gap:8px;margin-top:6px;';

        if (grande) {
            const btnExp = document.createElement('button');
            btnExp.style.cssText = 'background:none;border:none;cursor:pointer;opacity:.6;font-size:.8rem;color:#22d3ee;';
            btnExp.textContent = '▼ Expandir';
            let exp = false;
            btnExp.onclick = () => {
                exp = !exp;
                bubble.style.maxHeight = exp ? '9999px' : '160px';
                btnExp.textContent = exp ? '▲ Recolher' : '▼ Expandir';
            };
            acoes.appendChild(btnExp);
        }

        const btnCopy = document.createElement('button');
        btnCopy.style.cssText = 'background:none;border:none;cursor:pointer;opacity:.6;font-size:.85rem;';
        btnCopy.innerHTML = '📋';
        btnCopy.title = 'Copiar';
        btnCopy.onclick = () => navigator.clipboard.writeText(bubble.innerText || bubble.textContent || '');
        acoes.appendChild(btnCopy);

        wrap.appendChild(acoes);
    }

    container.appendChild(wrap);
    chatBox.appendChild(container);
    chatBox.scrollTop = chatBox.scrollHeight;

    try {
        const deveFalar = ttsEnabled && typeof speechSynthesis !== 'undefined' && texto && (ttsNextResponse || Boolean(streamTelaCompartilhada));
        if (deveFalar) {
            const ut = new SpeechSynthesisUtterance((typeof texto === 'string') ? texto.replace(/\n/g, ' ') : String(texto));
            ut.lang = 'pt-BR';
            const voz = escolherVozTTS();
            if (voz) ut.voice = voz;
            ut.rate = 1;
            ut.pitch = 1.05;
            speechSynthesis.cancel();
            speechSynthesis.speak(ut);
        }
    } catch (e) { console.warn('TTS falhou:', e); }
    ttsNextResponse = false;
}

/* ── ENVIO PRINCIPAL ─────────────────────────────────────────── */
async function enviarMensagem() {
    const chatInput = document.getElementById('chat-input');
    if (!chatInput || aguardandoResposta) return;
    const mensagem = chatInput.value.trim();
    if (!mensagem) return;

    chatInput.value = ''; chatInput.style.height = 'auto';
    await processarEnvioIA(mensagem);
}

/* ── GRAVAÇÃO DE ÁUDIO ────────────────────────────────────────── */
function iniciarGravacaoAudio() {
    const btn = document.getElementById('btn-gravar-audio');
    let mediaRecorder;
    let audioChunks = [];
    let gravandoAudio = false;

    btn?.addEventListener('click', async () => {
        if (!gravandoAudio) {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            
            mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
            mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                // Aqui você pode implementar o envio do áudio
                console.log('Áudio gravado:', audioBlob);
            };

            mediaRecorder.start();
            gravandoAudio = true;
            btn.classList.add('gravando');
            btn.title = 'Parar gravação';
        } else {
            if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
            gravandoAudio = false;
            btn.classList.remove('gravando');
            btn.title = 'Gravar áudio';
        }
    });
}

/* ── INICIALIZAÇÃO ────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    verificarSessao();
    iniciarMenuUpload();
    iniciarUpload();
    iniciarGravacaoAudio();

    document.getElementById('voice-selector')?.addEventListener('change', aplicarVozSelecionada);
    document.getElementById('sidebar-toggle')?.addEventListener('click', () => document.getElementById('sidebar').classList.toggle('collapsed'));
    document.getElementById('btn-nova-conversa')?.addEventListener('click', resetarChat);
    document.getElementById('btn-abrir-pesquisa')?.addEventListener('click', () => mostrarTela('tela-pesquisa'));

    document.getElementById('btn-trigger-login')?.addEventListener('click',  () => mostrarTela('tela-login'));
    document.getElementById('btn-trigger-signup')?.addEventListener('click', () => mostrarTela('tela-cadastro'));

    const btnMenu  = document.getElementById('btn-user-menu');
    const dropdown = document.getElementById('user-dropdown');
    btnMenu?.addEventListener('click', e => { e.stopPropagation(); dropdown?.classList.toggle('aberto'); });
    document.addEventListener('click', () => { dropdown?.classList.remove('aberto'); fecharChatOptionsMenu(); });

    document.getElementById('btn-logout')?.addEventListener('click', realizarLogout);
    document.getElementById('btn-abrir-feedback')?.addEventListener('click', () => { mostrarTela('tela-feedback'); dropdown?.classList.remove('aberto'); });
    document.getElementById('btn-enviar-feedback')?.addEventListener('click', enviarFeedback);
    document.getElementById('btn-capturar-tela')?.addEventListener('click', capturarScreenshot);

    document.querySelectorAll('.modal-close').forEach(b => b.addEventListener('click', fecharModal));
    document.getElementById('modal-overlay')?.addEventListener('click', e => { if (e.target.id==='modal-overlay') fecharModal(); });
    document.getElementById('btn-cancelar-acao')?.addEventListener('click', fecharModal);

    document.getElementById('btn-efetuar-login')?.addEventListener('click', realizarLogin);
    document.getElementById('btn-efetuar-cadastro')?.addEventListener('click', realizarCadastro);
    document.getElementById('btn-enviar-codigo')?.addEventListener('click', enviarCodigo);
    document.getElementById('btn-mudar-senha')?.addEventListener('click', mudarSenha);
    document.getElementById('btn-confirmar-renomear')?.addEventListener('click', salvarRenomear);

    document.getElementById('login-senha')?.addEventListener('keydown', e => { if (e.key==='Enter') realizarLogin(); });
    document.getElementById('cadastro-senha')?.addEventListener('keydown', e => { if (e.key==='Enter') realizarCadastro(); });
    document.getElementById('pesquisa-input')?.addEventListener('input', e => pesquisarConversas(e.target.value));

    document.getElementById('btn-stop-response')?.addEventListener('click', pararRespostaIA);

    document.getElementById('send-btn')?.addEventListener('click', enviarMensagem);
    const textarea = document.getElementById('chat-input');
    textarea?.addEventListener('keydown', e => { if (e.key==='Enter'&&!e.shiftKey) { e.preventDefault(); enviarMensagem(); } });
    textarea?.addEventListener('input', function() { this.style.height='auto'; this.style.height=this.scrollHeight+'px'; });
});

/* ── CÂMERA ───────────────────────────────────────────────────── */
async function iniciarCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        const chatBox = document.getElementById('chat-box');
        if (!chatBox) return;

        const preview = document.createElement('div');
        preview.className = 'share-screen-preview';
        preview.innerHTML = `
            <div class="share-screen-preview-header">
                <span>Abrir Câmera</span>
                <button type="button" class="share-screen-stop-btn" title="Fechar">✕</button>
            </div>
            <video autoplay playsinline muted style="max-width:100%;border-radius:8px;background:#000"></video>
            <div style="display:flex;gap:8px;margin-top:8px;">
                <button class="btn-capture-photo btn-modal-primary">Capturar Foto</button>
                <button class="btn-close-camera btn-link-modal">Fechar</button>
            </div>
        `;
        
        const videoEl = preview.querySelector('video');
        if (videoEl) videoEl.srcObject = stream;

        const encerrar = () => { 
            stream.getTracks().forEach(t => t.stop()); 
            preview.remove(); 
        };
        
        preview.querySelector('.share-screen-stop-btn').onclick = encerrar;
        preview.querySelector('.btn-close-camera').onclick = encerrar;

        preview.querySelector('.btn-capture-photo').onclick = async () => {
            const canvas = document.createElement('canvas');
            canvas.width = videoEl?.videoWidth || 640;
            canvas.height = videoEl?.videoHeight || 480;
            const ctx = canvas.getContext('2d');
            if (ctx && videoEl) ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/png');
            
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display:flex;justify-content:flex-end;width:100%;margin-bottom:8px;';
            wrap.innerHTML = `<img src="${dataUrl}" style="max-width:240px;max-height:180px;border-radius:12px;border:1px solid rgba(168,85,247,.3);">`;
            
            chatBox.appendChild(wrap);
            chatBox.classList.add('has-messages');
            chatBox.scrollTop = chatBox.scrollHeight;
            
            ttsNextResponse = true;
            await processarEnvioIA(`[Usuário enviou uma foto capturada pela câmera.]`);
            encerrar();
        };

        chatBox.appendChild(preview);
        chatBox.classList.add('has-messages');
        chatBox.scrollTop = chatBox.scrollHeight;

    } catch (e) {
        alert('Erro ao abrir câmera: ' + e.message);
    }
}

/* ── PROCESSAMENTO IA ────────────────────────────────────────── */
async function processarEnvioIA(conteudo) {
    const chatBox = document.getElementById('chat-box');
    if (!chatBox) return;

    adicionarBolhaUsuario(chatBox, conteudo);
    mostrarTypingIndicator();
    
    const sendBtn = document.getElementById('send-btn');
    const input = document.getElementById('chat-input');
    if (sendBtn) sendBtn.disabled = true;
    if (input) {
        input.disabled = true;
        input.placeholder = 'Iana está pensando...';
    }

    try {
        const res = await fetch('/chat/enviar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mensagem: conteudo, id_conversa: typeof idConversaAtiva !== 'undefined' ? idConversaAtiva : null })
        });

        if (!res.ok) throw new Error('Erro na comunicação com o servidor');
        
        const data = await res.json();
        
        esconderTypingIndicator();
        adicionarRespostaIA(data.resposta);
        
    } catch (e) {
        console.error('Erro:', e);
        esconderTypingIndicator();
        adicionarRespostaIA('Desculpe, não consegui processar sua solicitação no momento.');
    } finally {
        if (sendBtn) sendBtn.disabled = false;
        if (input) {
            input.disabled = false;
            input.placeholder = 'Digite sua mensagem...';
        }
    }
}

/* ── FUNÇÕES DE APOIO ────────────────────────────────────────── */
function adicionarBolhaUsuario(container, texto) {
    const div = document.createElement('div');
    div.className = 'mensagem-usuario';
    div.textContent = texto;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function adicionarRespostaIA(texto) {
    const container = document.getElementById('chat-box');
    const div = document.createElement('div');
    div.className = 'mensagem-ia';
    div.innerHTML = texto;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function mostrarTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) indicator.style.display = 'block';
}

function esconderTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) indicator.style.display = 'none';
}