/* ================================================================
   IANA — chat.js — FINAL
   ================================================================ */

'use strict';

// ── ESTADO ──────────────────────────────────────────────────────
const S = {
    esperando:    false,
    gravando:     false,
    chamadaVoz:   false,
    idConversa:   localStorage.getItem('iana_conv') || null,
    emailRecup:   '',
    idRenomear:   null,
    idExcluir:    null,
    controller:   new AbortController(),
    mediaRec:     null,
    audioChunks:  [],
    speechRec:    null,
    synth:        window.speechSynthesis || null,
};

const CONFIG_KEY = 'iana_config';

// ── UTILS ────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const qs = s  => document.querySelector(s);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function lerConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; } catch { return {}; }
}

function montarConfigPrompt() {
    const c = lerConfig();
    const partes = [];

    const mapP = {
        gamer: 'Fale como gamer apaixonado.', nerd: 'Seja técnica e detalhista.',
        descontraida: 'Seja descontraída e use gírias.', direta: 'Seja direta e objetiva.',
        professora: 'Seja didática e explique passo a passo.', hype: 'Seja hype e animada.',
        epica: 'Use linguagem épica.', humor: 'Adicione humor natural.'
    };

    const mapF = {
        platinas:'platinas e troféus', builds:'builds e estratégias', itens:'localização de itens',
        boss:'chefões e vilões', lore:'lore e história', competitivo:'modo competitivo',
        rpg:'RPGs', horror:'games de horror', series:'séries e filmes', tecnologia:'tecnologia',
        dbd:'Dead by Daylight', batman:'Batman Arkham', re:'Resident Evil', gta:'GTA RP'
    };

    if (c.personalidade?.length) partes.push(c.personalidade.map(p => mapP[p]).filter(Boolean).join(' '));
    if (c.foco?.length) partes.push(`Especialidade: ${c.foco.map(f => mapF[f]).filter(Boolean).join(', ')}.`);
    if (c.plataforma?.length) partes.push(`Plataforma do usuário: ${c.plataforma.join(', ')}.`);
    if (c.tamanho === 'curta') partes.push('Respostas curtas e diretas.');
    if (c.tamanho === 'completa') partes.push('Respostas completas e detalhadas.');
    if (c.emojis === 'muito') partes.push('Use muitos emojis.');
    if (c.emojis === 'nenhum') partes.push('Não use emojis.');
    if (c.perguntas !== false) partes.push('Ao final de cada resposta, faça uma pergunta relacionada.');
    if (c.instrucoes) partes.push(`Instruções: ${c.instrucoes}`);
    if (c.sobreVoce) partes.push(`Sobre o usuário: ${c.sobreVoce}`);

    return partes.join('\n');
}

// ── AUTENTICAÇÃO ─────────────────────────────────────────────────
async function api(url, opts = {}) {
    opts.credentials = 'include';
    opts.headers = { 'Content-Type': 'application/json', ...opts.headers };
    return fetch(url, opts);
}

async function verificarSessao() {
    try {
        const r = await api('/auth/me');
        const d = await r.json();
        if (d.logado) aoLogar(d.usuario);
        else estadoVisitante();
    } catch { estadoVisitante(); }
}

function estadoVisitante() {
    $('auth-buttons')?.style.setProperty('display', 'flex');
    $('sidebar-footer')?.style.setProperty('display', 'none');
    const hint = $('historico-hint');
    if (hint) hint.textContent = 'Faça login para salvar conversas.';
}

function aoLogar(u) {
    // Esconde botões de auth
    $('auth-buttons')?.style.setProperty('display', 'none');

    // Mostra perfil na sidebar
    const footer = $('sidebar-footer');
    if (footer) footer.style.display = 'block';
    const nome = $('user-nome-sidebar');
    if (nome) nome.textContent = u.nome;

    // Saudação
    const titulo = $('welcome-titulo');
    if (titulo) {
        const h = new Date().getHours();
        const s = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
        const frases = [
            `${s}, ${u.nome}! Pronto pra dominar? 🎮`,
            `${s}, ${u.nome}! Que conquista desbloqueamos hoje? 🏆`,
            `Ei, ${u.nome}! Como posso te ajudar? ✨`,
            `${s}, ${u.nome}! Tô aqui pra te guiar! 🗺️`,
        ];
        titulo.innerHTML = `<span class="g-text">${frases[Math.floor(Math.random()*frases.length)]}</span>`;
    }

    carregarHistorico();
}

async function fazerLogin() {
    const email = $('login-email')?.value.trim();
    const senha = $('login-senha')?.value;
    if (!email || !senha) { setErro('login-erro', 'Preencha todos os campos.'); return; }
    const btn = $('btn-login'); setLoading(btn, 'Entrando...');
    try {
        const r = await api('/auth/login', { method:'POST', body: JSON.stringify({email,senha}) });
        const d = await r.json();
        if (!r.ok) { setErro('login-erro', d.erro || 'Falha.'); return; }
        fecharAuth(); aoLogar(d.usuario);
    } catch { setErro('login-erro', 'Erro de conexão.'); }
    finally { resetBtn(btn, 'Entrar'); }
}

async function fazerCadastro() {
    const nome  = $('cad-nome')?.value.trim();
    const email = $('cad-email')?.value.trim();
    const senha = $('cad-senha')?.value;
    if (!nome||!email||!senha) { setErro('cad-erro','Preencha todos os campos.'); return; }
    if (senha.length < 8) { setErro('cad-erro','Senha mínima: 8 caracteres.'); return; }
    const btn = $('btn-cadastrar'); setLoading(btn,'Criando...');
    try {
        const r = await api('/auth/registro', { method:'POST', body: JSON.stringify({nome,email,senha}) });
        const d = await r.json();
        if (!r.ok) { setErro('cad-erro', d.erro || 'Falha.'); return; }
        fecharAuth(); aoLogar(d.usuario);
    } catch { setErro('cad-erro','Erro de conexão.'); }
    finally { resetBtn(btn,'Criar Conta'); }
}

async function fazerLogout() {
    await api('/auth/logout', { method:'POST' });
    location.reload();
}

async function enviarCodigo() {
    const email = $('esq-email')?.value.trim();
    const erroEl = $('esq-erro');
    if (!email) { setErro('esq-erro','Digite seu e-mail.'); return; }
    erroEl.style.color = '#a855f7'; erroEl.textContent = 'Enviando...';
    try {
        const r = await api('/auth/esqueci-senha', { method:'POST', body: JSON.stringify({email}) });
        const d = await r.json();
        if (!r.ok) { erroEl.style.color='#f87171'; erroEl.textContent = d.erro || 'Erro.'; return; }
        S.emailRecup = email;
        const lbl = $('cod-label');
        if (lbl) lbl.textContent = `Código enviado para ${email}`;
        mostrarTela('tela-codigo');
    } catch { erroEl.style.color='#f87171'; erroEl.textContent='Erro de conexão.'; }
}

async function mudarSenha() {
    const codigo    = $('cod-input')?.value.trim();
    const novaSenha = $('cod-nova-senha')?.value;
    if (!codigo||!novaSenha) { setErro('cod-erro','Preencha o código e a nova senha.'); return; }
    try {
        const r = await api('/auth/mudar-senha', { method:'POST', body: JSON.stringify({email:S.emailRecup, codigo, nova_senha:novaSenha}) });
        const d = await r.json();
        if (!r.ok) { setErro('cod-erro', d.erro || 'Código inválido.'); return; }
        alert('✅ Senha alterada! Faça login.');
        mostrarTela('tela-login');
    } catch { setErro('cod-erro','Erro de conexão.'); }
}

// ── MODAIS ────────────────────────────────────────────────────────
const TELAS_AUTH = ['tela-login','tela-cadastro','tela-esqueci','tela-codigo','tela-pesquisa','tela-feedback','tela-renomear','tela-confirmar'];

function mostrarTela(id) {
    TELAS_AUTH.forEach(t => { const el = $(t); if (el) el.style.display = t===id ? 'flex' : 'none'; });
    const ov = $('overlay-auth');
    if (ov) { ov.style.display = 'flex'; ov.querySelector('[style*=flex]')?.style.setProperty('flex-direction','column'); }
    const el = $(id); if (el) el.style.display = 'flex';
    el && (el.style.flexDirection = 'column');
}

function fecharAuth() {
    const ov = $('overlay-auth'); if (ov) ov.style.display = 'none';
    TELAS_AUTH.forEach(t => { const el = $(t); if (el) el.style.display = 'none'; });
}

function setErro(id, msg) {
    const el = $(id); if (el) { el.textContent = msg; el.style.color = '#f87171'; }
}

function setLoading(btn, txt) { if (btn) { btn._orig = btn.textContent; btn.textContent = txt; btn.disabled = true; } }
function resetBtn(btn, txt)   { if (btn) { btn.textContent = txt || btn._orig || 'OK'; btn.disabled = false; } }

// ── HISTÓRICO ─────────────────────────────────────────────────────
async function carregarHistorico() {
    const lista = $('historico-lista'); if (!lista) return;
    try {
        const r = await api('/chat/conversas');
        if (!r.ok) return;
        const { conversas } = await r.json();
        lista.innerHTML = '';

        if (!conversas?.length) {
            lista.innerHTML = '<p class="sidebar-hint">Nenhum chat salvo ainda.</p>';
            return;
        }

        conversas.forEach(c => {
            const item = document.createElement('div');
            item.className = `conv-item ${S.idConversa===c.id_conversa?'ativa':''} ${c.fixada?'fixada':''}`;
            item.dataset.id = c.id_conversa;

            const span = document.createElement('span');
            span.className = 'conv-titulo';
            span.textContent = (c.fixada ? '📌 ' : '') + (c.titulo || 'Conversa');
            span.onclick = () => ativarConversa(c.id_conversa);

            const menuBtn = document.createElement('button');
            menuBtn.className = 'conv-menu-btn'; menuBtn.textContent = '⋮';

            const opcoes = document.createElement('div');
            opcoes.className = 'conv-opcoes';
            opcoes.innerHTML = `
                <button class="conv-opt-btn" data-acao="fixar">📌 ${c.fixada?'Desafixar':'Fixar'}</button>
                <button class="conv-opt-btn" data-acao="renomear">✏️ Renomear</button>
                <button class="conv-opt-btn danger" data-acao="excluir">🗑️ Excluir</button>`;

            menuBtn.onclick = e => {
                e.stopPropagation();
                document.querySelectorAll('.conv-opcoes.aberta').forEach(o => { if(o!==opcoes) o.classList.remove('aberta'); });
                opcoes.classList.toggle('aberta');
            };

            opcoes.querySelectorAll('.conv-opt-btn').forEach(b => {
                b.onclick = e => {
                    e.stopPropagation();
                    opcoes.classList.remove('aberta');
                    const acao = b.dataset.acao;
                    if (acao==='fixar') fixarConversa(c.id_conversa, !c.fixada);
                    else if (acao==='renomear') abrirRenomear(c.id_conversa, c.titulo);
                    else if (acao==='excluir') abrirExcluir(c.id_conversa);
                };
            });

            item.append(span, menuBtn, opcoes);
            lista.appendChild(item);
        });
    } catch (e) { console.error('[Histórico]', e); }
}

async function fixarConversa(id, fixar) {
    await api(`/chat/conversas/${id}/fixar`, { method:'PATCH', body: JSON.stringify({fixada:fixar}) });
    carregarHistorico();
}

function abrirRenomear(id, titulo) {
    S.idRenomear = id;
    const inp = $('rename-input'); if (inp) inp.value = titulo || '';
    mostrarTela('tela-renomear');
}

async function salvarRenomear() {
    const novo = $('rename-input')?.value.trim();
    if (!novo || !S.idRenomear) { fecharAuth(); return; }
    await api(`/chat/conversas/${S.idRenomear}`, { method:'PUT', body: JSON.stringify({novoTitulo:novo}) });
    fecharAuth(); carregarHistorico();
}

function abrirExcluir(id) {
    S.idExcluir = id;
    mostrarTela('tela-confirmar');
}

async function confirmarExcluir() {
    if (!S.idExcluir) return;
    await api(`/chat/conversas/${S.idExcluir}`, { method:'DELETE' });
    fecharAuth();
    if (S.idConversa === S.idExcluir) { S.idConversa = null; localStorage.removeItem('iana_conv'); resetarChat(); }
    S.idExcluir = null;
    carregarHistorico();
}

async function ativarConversa(id) {
    S.idConversa = id; localStorage.setItem('iana_conv', id);
    const msgs = $('msgs'); if (!msgs) return;
    msgs.innerHTML = '';
    esconderWelcome();
    getChatbox().classList.add('tem-msgs');

    const loading = criarLoading(); msgs.appendChild(loading);

    try {
        const r = await api(`/chat/historico/${id}`);
        loading.remove();
        if (!r.ok) return;
        const { mensagens } = await r.json();
        if (!mensagens?.length) return;
        mensagens.forEach(m => {
            if (m.tipo_sender==='usuario') renderMsgUser(m.conteudo, false);
            else renderMsgIana(m.conteudo, false);
        });
        getChatbox().scrollTop = getChatbox().scrollHeight;
    } catch { loading.remove(); }

    carregarHistorico();
}

async function pesquisarConversas(termo) {
    const res = $('pesquisa-resultados'); if (!res) return;
    res.innerHTML = '';
    if (!termo.trim()) return;
    try {
        const r = await api('/chat/conversas');
        const { conversas } = await r.json();
        const found = (conversas||[]).filter(c => c.titulo?.toLowerCase().includes(termo.toLowerCase()));
        if (!found.length) { res.innerHTML='<p style="color:#71717a;font-size:.85rem;text-align:center;padding:12px;">Nenhuma encontrada.</p>'; return; }
        found.forEach(c => {
            const item = document.createElement('div');
            item.style.cssText='padding:10px;background:rgba(34,211,238,.08);border-radius:8px;cursor:pointer;margin-top:6px;font-size:.87rem;border:1px solid rgba(34,211,238,.15);';
            item.textContent = c.titulo;
            item.onclick = () => { ativarConversa(c.id_conversa); fecharAuth(); };
            res.appendChild(item);
        });
    } catch {}
}

// ── CHAT ──────────────────────────────────────────────────────────
function getChatbox() { return $('chatbox'); }

function esconderWelcome() {
    const w = $('welcome'); if (w) w.style.display = 'none';
}

function resetarChat() {
    S.idConversa = null; localStorage.removeItem('iana_conv');
    const msgs = $('msgs'); if (msgs) msgs.innerHTML = '';
    getChatbox().classList.remove('tem-msgs');
    const w = $('welcome'); if (w) w.style.display = 'flex';
    carregarHistorico();
}

function criarLoading() {
    const d = document.createElement('div');
    d.style.cssText = 'text-align:center;color:#71717a;padding:16px;font-size:.85rem;';
    d.textContent = 'Carregando...'; return d;
}

function renderMsgUser(texto, scroll = true) {
    esconderWelcome();
    getChatbox().classList.add('tem-msgs');
    const msgs = $('msgs'); if (!msgs) return;

    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap-user';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble-user';
    bubble.textContent = texto;

    const grande = texto.length > 500;
    if (grande) { bubble.style.maxHeight='160px'; bubble.style.overflow='hidden'; bubble.style.transition='max-height .4s'; }

    const acoes = document.createElement('div');
    acoes.className = 'msg-acoes msg-acoes-user';

    if (grande) {
        const btnExp = document.createElement('button');
        btnExp.className = 'msg-expandir'; btnExp.textContent = '▼ Expandir';
        let exp = false;
        btnExp.onclick = () => { exp=!exp; bubble.style.maxHeight=exp?'9999px':'160px'; btnExp.textContent=exp?'▲ Recolher':'▼ Expandir'; };
        acoes.appendChild(btnExp);
    }

    const btnEdit = document.createElement('button');
    btnEdit.className = 'msg-acao-btn'; btnEdit.textContent = '✏️'; btnEdit.title = 'Editar';
    btnEdit.onclick = () => { const inp=$('chat-input'); if(inp){inp.value=texto;inp.focus();ajustarAltura(inp);} };
    acoes.appendChild(btnEdit);

    const btnCopy = document.createElement('button');
    btnCopy.className = 'msg-acao-btn'; btnCopy.textContent = '📋'; btnCopy.title = 'Copiar';
    btnCopy.onclick = () => navigator.clipboard.writeText(texto);
    acoes.appendChild(btnCopy);

    wrap.append(bubble, acoes);
    msgs.appendChild(wrap);
    if (scroll) getChatbox().scrollTop = getChatbox().scrollHeight;
}

function renderMsgIana(texto, scroll = true) {
    const msgs = $('msgs'); if (!msgs) return;
    getChatbox().classList.add('tem-msgs');

    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap-iana';

    const av = document.createElement('img');
    av.src = '/img/iana-avatar.png'; av.className = 'msg-iana-avatar'; av.alt = 'Iana';

    const content = document.createElement('div');
    content.className = 'msg-iana-content';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble-iana';

    const grande = texto.length > 500;
    if (grande) { bubble.style.maxHeight='160px'; bubble.style.overflow='hidden'; bubble.style.transition='max-height .4s'; }

    const html = typeof DOMPurify!=='undefined' && typeof marked!=='undefined'
        ? DOMPurify.sanitize(marked.parse(texto))
        : texto.replace(/\n/g,'<br>');
    bubble.innerHTML = html;

    const acoes = document.createElement('div');
    acoes.className = 'msg-acoes';

    if (grande) {
        const btnExp = document.createElement('button');
        btnExp.className = 'msg-expandir'; btnExp.textContent = '▼ Expandir';
        let exp = false;
        btnExp.onclick = () => { exp=!exp; bubble.style.maxHeight=exp?'9999px':'160px'; btnExp.textContent=exp?'▲ Recolher':'▼ Expandir'; };
        acoes.appendChild(btnExp);
    }

    const btnCopy = document.createElement('button');
    btnCopy.className = 'msg-acao-btn'; btnCopy.textContent = '📋'; btnCopy.title = 'Copiar';
    btnCopy.onclick = () => navigator.clipboard.writeText(bubble.innerText || bubble.textContent);
    acoes.appendChild(btnCopy);

    content.append(bubble, acoes);
    wrap.append(av, content);
    msgs.appendChild(wrap);
    if (scroll) getChatbox().scrollTop = getChatbox().scrollHeight;
}

function mostrarTyping() {
    const msgs = $('msgs'); if (!msgs || $('typing-indicator')) return;
    esconderWelcome();
    getChatbox().classList.add('tem-msgs');

    const wrap = document.createElement('div');
    wrap.className = 'typing-wrap'; wrap.id = 'typing-indicator';

    const av = document.createElement('img');
    av.src = '/img/iana-avatar.png'; av.className = 'msg-iana-avatar'; av.alt = 'Iana';

    const dots = document.createElement('div');
    dots.className = 'typing-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';

    wrap.append(av, dots);
    msgs.appendChild(wrap);
    getChatbox().scrollTop = getChatbox().scrollHeight;
}

function esconderTyping() { $('typing-indicator')?.remove(); }

// ── ENVIO ─────────────────────────────────────────────────────────
async function enviarMensagem(textoForcado) {
    const input = $('chat-input');
    const texto = textoForcado || input?.value.trim();
    if (!texto || S.esperando) return;

    if (input && !textoForcado) { input.value = ''; ajustarAltura(input); }

    renderMsgUser(texto);
    await processarIA(texto);
}

async function processarIA(texto) {
    S.esperando = true;
    const send = $('btn-send'); const stop = $('btn-stop');
    const input = $('chat-input');

    if (send) send.style.display = 'none';
    if (stop) stop.style.display = 'flex';
    if (input) { input.disabled = true; input.placeholder = 'Iana está pensando...'; }

    mostrarTyping();

    if (!S.idConversa) {
        S.idConversa = `conv_${Date.now()}`;
        localStorage.setItem('iana_conv', S.idConversa);
    }

    const estadoEmocional = typeof detectarEstadoEmocional === 'function'
        ? detectarEstadoEmocional(texto) : 'normal';

    try {
        const r = await api('/chat/stream', {
            method: 'POST',
            body: JSON.stringify({
                mensagem: texto,
                idConversa: S.idConversa,
                estadoEmocional,
                configPrompt: montarConfigPrompt()
            }),
            signal: S.controller.signal
        });

        esconderTyping();

        if (!r.ok) {
            const d = await r.json().catch(()=>({}));
            renderMsgIana(d.erro || 'Tive um problema de conexão. Pode repetir? 😊');
            return;
        }

        const d = await r.json();
        if (d.idConversa && !S.idConversa) {
            S.idConversa = d.idConversa;
            localStorage.setItem('iana_conv', S.idConversa);
        }

        const resposta = d.resposta || 'Hmm, não recebi resposta. Tente novamente.';
        renderMsgIana(resposta);
        carregarHistorico();

        // TTS — fala a resposta se chamada de voz ativa
        if (S.chamadaVoz && S.synth) {
            falarResposta(resposta);
        }

    } catch (e) {
        esconderTyping();
        if (e.name !== 'AbortError') renderMsgIana('Erro de conexão. Verifique sua internet. 😊');
    } finally {
        S.esperando = false;
        if (send) send.style.display = 'flex';
        if (stop) stop.style.display = 'none';
        if (input) { input.disabled = false; input.placeholder = 'Peça à Iana...'; input.focus(); }
    }
}

function pararIA() {
    try { S.controller.abort(); } catch {}
    S.controller = new AbortController();
    S.esperando = false;
    esconderTyping();
    const send=$('btn-send'); const stop=$('btn-stop');
    if (send) send.style.display = 'flex';
    if (stop) stop.style.display = 'none';
    const input=$('chat-input');
    if (input) { input.disabled=false; input.placeholder='Peça à Iana...'; }
}

function usarSugestao(txt) { enviarMensagem(txt); }

function ajustarAltura(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

// ── UPLOAD / CÂMERA / TELA ─────────────────────────────────────────
function toggleMenuUpload() {
    const menu = $('upload-menu');
    const btn  = $('btn-mais');
    const pill = $('input-pill');
    if (!menu) return;

    const aberto = menu.style.display === 'flex';
    if (aberto) {
        menu.style.display = 'none';
        btn?.classList.remove('ativo');
    } else {
        const rect = pill.getBoundingClientRect();
        menu.style.cssText = `display:flex;flex-direction:column;position:fixed;bottom:${window.innerHeight-rect.top+8}px;left:${rect.left}px;`;
        btn?.classList.add('ativo');
    }
}

function fecharMenuUpload() {
    const menu = $('upload-menu');
    if (menu) menu.style.display = 'none';
    $('btn-mais')?.classList.remove('ativo');
}

async function abrirCamera() {
    fecharMenuUpload();
    const ov = $('overlay-camera'); if (!ov) return;
    ov.style.display = 'flex';
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        const video  = $('camera-preview');
        if (video) { video.srcObject = stream; video._stream = stream; }
    } catch { alert('❌ Câmera não acessível.'); ov.style.display='none'; }
}

function fecharCamera() {
    const ov = $('overlay-camera'); if (ov) ov.style.display = 'none';
    const video = $('camera-preview');
    if (video?._stream) { video._stream.getTracks().forEach(t=>t.stop()); video._stream=null; }
}

async function capturarFoto() {
    const video = $('camera-preview'); if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    fecharCamera();

    const dataUrl = canvas.toDataURL('image/jpeg');
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap-user';
    wrap.innerHTML = `<img src="${dataUrl}" style="max-width:240px;max-height:180px;border-radius:12px;border:1px solid rgba(168,85,247,.3);">`;
    $('msgs')?.appendChild(wrap);
    getChatbox().classList.add('tem-msgs'); esconderWelcome();
    getChatbox().scrollTop = getChatbox().scrollHeight;

    await processarIA('[Usuário tirou uma foto com a câmera. Reconheça e pergunte como pode ajudar.]');
}

async function compartilharTela() {
    fecharMenuUpload();
    try {
        const stream  = await navigator.mediaDevices.getDisplayMedia({ video:{ cursor:'always' }, audio:false });
        const video   = document.createElement('video');
        video.srcObject = stream; video.autoplay = true;
        await new Promise(r => { video.onloadedmetadata = r; });
        await sleep(400);
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        stream.getTracks().forEach(t => t.stop());

        const dataUrl = canvas.toDataURL('image/png');
        const wrap = document.createElement('div');
        wrap.className = 'msg-wrap-user';
        wrap.innerHTML = `
            <p style="font-size:.8rem;color:#71717a;text-align:right;margin-bottom:4px;">🖥️ Tela capturada</p>
            <img src="${dataUrl}" style="max-width:280px;border-radius:12px;border:1px solid rgba(34,211,238,.3);">`;
        $('msgs')?.appendChild(wrap);
        getChatbox().classList.add('tem-msgs'); esconderWelcome();
        getChatbox().scrollTop = getChatbox().scrollHeight;

        await processarIA('[Usuário compartilhou a tela. Analise o que vê na imagem e ajude com o que for necessário.]');
    } catch (e) {
        if (e.name !== 'NotAllowedError') alert('Erro ao capturar tela: ' + e.message);
    }
}

function iniciarUpload() {
    const fi = $('file-input'); if (!fi) return;
    fi.addEventListener('change', async e => {
        const file = e.target.files[0]; if (!file) return;
        esconderWelcome(); getChatbox().classList.add('tem-msgs');
        const msgs = $('msgs');

        if (file.type.startsWith('image/')) {
            const url = URL.createObjectURL(file);
            const wrap = document.createElement('div');
            wrap.className = 'msg-wrap-user';
            wrap.innerHTML = `<img src="${url}" style="max-width:240px;max-height:180px;border-radius:12px;border:1px solid rgba(168,85,247,.3);">`;
            msgs?.appendChild(wrap);
        } else {
            renderMsgUser(`📎 ${file.name}`, false);
        }
        getChatbox().scrollTop = getChatbox().scrollHeight;

        let conteudo = '';
        if (file.type === 'text/plain' || file.name.endsWith('.txt'))
            conteudo = (await file.text()).slice(0,2000);

        const prompt = conteudo
            ? `[Usuário enviou o arquivo "${file.name}". Conteúdo:\n${conteudo}]`
            : `[Usuário enviou ${file.type.startsWith('image/')?'uma imagem':'um arquivo'}: "${file.name}". Reconheça e pergunte como ajudar.]`;

        await processarIA(prompt);
        e.target.value = '';
    });
}

// ── GRAVAÇÃO DE ÁUDIO ──────────────────────────────────────────────
function iniciarGravacao() {
    const btn = $('btn-mic'); if (!btn) return;
    btn.addEventListener('click', async () => {
        if (!S.gravando) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
                S.mediaRec = new MediaRecorder(stream);
                S.audioChunks = [];
                S.mediaRec.ondataavailable = e => { if(e.data.size>0) S.audioChunks.push(e.data); };
                S.mediaRec.onstop = async () => {
                    const blob = new Blob(S.audioChunks, { type:'audio/webm' });
                    const url  = URL.createObjectURL(blob);
                    stream.getTracks().forEach(t=>t.stop());
                    const wrap = document.createElement('div');
                    wrap.className = 'msg-wrap-user';
                    wrap.innerHTML = `<audio src="${url}" controls style="max-width:260px;border-radius:8px;"></audio>`;
                    $('msgs')?.appendChild(wrap);
                    esconderWelcome(); getChatbox().classList.add('tem-msgs');
                    getChatbox().scrollTop = getChatbox().scrollHeight;
                    await processarIA('[Usuário enviou áudio. Responda naturalmente como se tivesse ouvido.]');
                };
                S.mediaRec.start();
                S.gravando = true;
                btn.classList.add('gravando'); btn.title = 'Parar gravação';
            } catch { alert('❌ Permissão de microfone negada.'); }
        } else {
            S.mediaRec?.stop(); S.gravando = false;
            btn.classList.remove('gravando'); btn.title = 'Gravar áudio';
        }
    });
}

// ── CHAMADA DE VOZ ─────────────────────────────────────────────────
function iniciarChamadaVoz() {
    const ov     = $('overlay-voz'); if (!ov) return;
    const status = $('voz-status');
    const transc = $('voz-transcript');

    S.chamadaVoz = true;
    ov.style.display = 'flex';

    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        if (status) status.textContent = 'Reconhecimento de voz não suportado neste navegador.';
        return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    S.speechRec = new SpeechRecognition();
    S.speechRec.lang = 'pt-BR';
    S.speechRec.continuous = true;
    S.speechRec.interimResults = true;

    if (status) status.textContent = 'Ouvindo...';

    S.speechRec.onresult = async e => {
        const transcript = [...e.results].map(r => r[0].transcript).join('');
        if (transc) transc.textContent = transcript;
        if (e.results[e.results.length-1].isFinal && transcript.trim()) {
            if (status) status.textContent = 'Processando...';
            renderMsgUser(transcript);
            await processarIA(transcript);
            if (status) status.textContent = 'Ouvindo...';
            if (transc) transc.textContent = '';
        }
    };

    S.speechRec.onerror = e => { if (status) status.textContent = `Erro: ${e.error}`; };
    S.speechRec.start();
}

function encerrarChamadaVoz() {
    S.chamadaVoz = false;
    S.speechRec?.stop(); S.speechRec = null;
    S.synth?.cancel();
    $('overlay-voz')?.style.setProperty('display','none');
}

function falarResposta(texto) {
    if (!S.synth) return;
    S.synth.cancel();
    const textoLimpo = texto.replace(/[#*`_~]/g,'').replace(/\[.*?\]/g,'');
    const utter = new SpeechSynthesisUtterance(textoLimpo);
    utter.lang = 'pt-BR'; utter.rate = 1.05; utter.pitch = 1;
    const vozes = S.synth.getVoices().filter(v => v.lang.startsWith('pt'));
    if (vozes.length) utter.voice = vozes[0];
    S.synth.speak(utter);
}

// ── FEEDBACK ──────────────────────────────────────────────────────
async function enviarFeedback() {
    const assunto  = $('fb-assunto')?.value.trim();
    const texto    = $('fb-texto')?.value.trim();
    const autoriza = $('fb-autoriza')?.checked;
    if (!assunto||!texto) { alert('Preencha assunto e texto.'); return; }
    if (!autoriza) { alert('Marque a autorização.'); return; }
    const btn = $('btn-fb-enviar'); setLoading(btn,'Enviando...');
    try {
        const r = await fetch('https://formsubmit.co/ajax/iana_ia@outlook.com', {
            method:'POST',
            headers:{'Content-Type':'application/json','Accept':'application/json'},
            body: JSON.stringify({ _subject:`[Iana] ${assunto}`, Assunto:assunto, Mensagem:texto, _template:'box', _captcha:'false' })
        });
        if (r.ok) { alert('✅ Feedback enviado!'); fecharAuth(); }
        else alert('Erro ao enviar.');
    } catch { alert('Erro de conexão.'); }
    finally { resetBtn(btn,'Enviar'); }
}

// ── INIT ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    verificarSessao();
    iniciarGravacao();
    iniciarUpload();

    // Sidebar toggle
    $('sidebar-toggle')?.addEventListener('click', () => $('sidebar')?.classList.toggle('collapsed'));
    $('btn-topbar-menu')?.addEventListener('click', () => $('sidebar')?.classList.toggle('collapsed'));

    // Novo chat / busca
    $('btn-novo-chat')?.addEventListener('click', resetarChat);
    $('btn-buscar')?.addEventListener('click', () => mostrarTela('tela-pesquisa'));
    $('pesquisa-input')?.addEventListener('input', e => pesquisarConversas(e.target.value));

    // Auth header
    $('btn-entrar')?.addEventListener('click', () => mostrarTela('tela-login'));
    $('btn-registrar')?.addEventListener('click', () => mostrarTela('tela-cadastro'));

    // Auth modal
    $('btn-login')?.addEventListener('click', fazerLogin);
    $('btn-cadastrar')?.addEventListener('click', fazerCadastro);
    $('btn-enviar-cod')?.addEventListener('click', enviarCodigo);
    $('btn-mudar-senha')?.addEventListener('click', mudarSenha);
    $('btn-salvar-rename')?.addEventListener('click', salvarRenomear);
    $('btn-confirmar-excluir')?.addEventListener('click', confirmarExcluir);
    $('btn-fb-enviar')?.addEventListener('click', enviarFeedback);

    // Enter nos campos
    $('login-senha')?.addEventListener('keydown', e => { if(e.key==='Enter') fazerLogin(); });
    $('cad-senha')?.addEventListener('keydown', e => { if(e.key==='Enter') fazerCadastro(); });

    // Fechar modal ao clicar fora
    $('overlay-auth')?.addEventListener('click', e => { if(e.target.id==='overlay-auth') fecharAuth(); });

    // Dropdown usuário
    $('btn-user-menu')?.addEventListener('click', e => {
        e.stopPropagation();
        $('user-dropdown')?.classList.toggle('aberto');
    });
    $('dd-config')?.addEventListener('click', () => { window.location.href='/configuracoes'; });
    $('dd-feedback')?.addEventListener('click', () => { $('user-dropdown')?.classList.remove('aberto'); mostrarTela('tela-feedback'); });
    $('dd-logout')?.addEventListener('click', fazerLogout);

    // Fecha dropdowns ao clicar fora
    document.addEventListener('click', () => {
        $('user-dropdown')?.classList.remove('aberto');
        document.querySelectorAll('.conv-opcoes.aberta').forEach(o => o.classList.remove('aberta'));
        fecharMenuUpload();
    });

    // Upload menu
    $('btn-mais')?.addEventListener('click', e => { e.stopPropagation(); toggleMenuUpload(); });
    $('up-foto')?.addEventListener('click', abrirCamera);
    $('up-imagem')?.addEventListener('click', () => { fecharMenuUpload(); $('file-input').accept='image/*'; $('file-input')?.click(); });
    $('up-arquivo')?.addEventListener('click', () => { fecharMenuUpload(); $('file-input').accept='.pdf,.txt,.doc,.docx'; $('file-input')?.click(); });
    $('up-audio')?.addEventListener('click', () => { fecharMenuUpload(); $('file-input').accept='audio/*'; $('file-input')?.click(); });
    $('up-tela')?.addEventListener('click', compartilharTela);

    // Câmera
    $('btn-capturar-foto')?.addEventListener('click', capturarFoto);

    // Chamada de voz
    $('btn-voz-call')?.addEventListener('click', () => iniciarChamadaVoz());
    $('btn-voz-encerrar')?.addEventListener('click', encerrarChamadaVoz);
    $('btn-voz-mute')?.addEventListener('click', e => {
        e.currentTarget.classList.toggle('mudo');
        if (S.speechRec) {
            if (e.currentTarget.classList.contains('mudo')) { S.speechRec.stop(); e.currentTarget.textContent='🔇'; }
            else { S.speechRec.start(); e.currentTarget.textContent='🎙️'; }
        }
    });

    // Parar IA
    $('btn-stop')?.addEventListener('click', pararIA);

    // Enviar
    $('btn-send')?.addEventListener('click', () => enviarMensagem());
    $('chat-input')?.addEventListener('keydown', e => {
        if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); enviarMensagem(); }
    });
    $('chat-input')?.addEventListener('input', function() { ajustarAltura(this); });
});