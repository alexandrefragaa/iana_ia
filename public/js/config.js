const CONFIG_KEY = 'iana_config';

/* ── NAVEGAÇÃO ────────────────────────────────────────────────── */
function irPara(secao, btn) {
    document.querySelectorAll('.config-secao').forEach(s => s.classList.remove('ativa'));
    document.querySelectorAll('.config-nav-item').forEach(b => b.classList.remove('ativo'));
    document.getElementById(`secao-${secao}`)?.classList.add('ativa');
    btn.classList.add('ativo');
}

/* ── CHIPS ────────────────────────────────────────────────────── */
document.querySelectorAll('.config-chip').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('ativo'));
});

/* ── CONTADORES ───────────────────────────────────────────────── */
function iniciarContador(taId, ctId, max) {
    const ta = document.getElementById(taId);
    const ct = document.getElementById(ctId);
    if (!ta || !ct) return;
    ta.addEventListener('input', () => {
        ct.textContent = `${ta.value.length}/${max}`;
        ct.style.color = ta.value.length > max * 0.9 ? '#f87171' : '#444';
    });
}

iniciarContador('config-instrucoes', 'config-contador', 800);
iniciarContador('config-sobre-voce', 'config-contador-voce', 400);

/* ── CARREGAR ─────────────────────────────────────────────────── */
function carregarConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; }
    catch { return {}; }
}

function aplicarConfig(config) {
    ['personalidade','foco','plataforma','voz'].forEach(grupo => {
        const valores = config[grupo] || [];
        document.querySelectorAll(`#chips-${grupo} .config-chip`).forEach(chip => {
            chip.classList.toggle('ativo', valores.includes(chip.dataset.valor));
        });
    });

    const ti = document.getElementById('config-instrucoes');
    const tv = document.getElementById('config-sobre-voce');
    if (ti) { ti.value = config.instrucoes || ''; document.getElementById('config-contador').textContent = `${ti.value.length}/800`; }
    if (tv) { tv.value = config.sobreVoce || ''; document.getElementById('config-contador-voce').textContent = `${tv.value.length}/400`; }

    const s1 = document.getElementById('config-tamanho');
    const s2 = document.getElementById('config-emojis');
    if (s1 && config.tamanho) s1.value = config.tamanho;
    if (s2 && config.emojis)  s2.value = config.emojis;

    ['perguntas','humor','criatividade','contexto'].forEach(k => {
        const el = document.getElementById(`toggle-${k}`);
        if (el) el.checked = config[k] !== undefined ? config[k] : true;
    });
}

/* ── SALVAR ───────────────────────────────────────────────────── */
function salvarConfig() {
    const pegar = g => [...document.querySelectorAll(`#chips-${g} .config-chip.ativo`)].map(b => b.dataset.valor);

    const config = {
        personalidade: pegar('personalidade'),
        foco:          pegar('foco'),
        plataforma:    pegar('plataforma'),
        voz:           pegar('voz'),
        instrucoes:    document.getElementById('config-instrucoes')?.value.trim() || '',
        sobreVoce:     document.getElementById('config-sobre-voce')?.value.trim() || '',
        tamanho:       document.getElementById('config-tamanho')?.value || 'media',
        emojis:        document.getElementById('config-emojis')?.value || 'moderado',
        perguntas:     document.getElementById('toggle-perguntas')?.checked ?? true,
        humor:         document.getElementById('toggle-humor')?.checked ?? true,
        criatividade:  document.getElementById('toggle-criatividade')?.checked ?? true,
        contexto:      document.getElementById('toggle-contexto')?.checked ?? true,
    };

    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));

    const btn = document.getElementById('btn-salvar');
    const orig = btn.textContent;
    btn.textContent = '✅ Configurações salvas!';
    btn.style.background = 'linear-gradient(135deg,#10b981,#059669)';
    setTimeout(() => {
        btn.textContent = orig;
        btn.style.background = '';
    }, 2000);
}

document.getElementById('btn-salvar')?.addEventListener('click', salvarConfig);
aplicarConfig(carregarConfig());

/* ── SEGURANÇA: TROCAR SENHA ──────────────────────────────────── */
function mostrarMsgSeguranca(texto, tipo) {
    const msgEl = document.getElementById('seguranca-msg');
    if (!msgEl) return;
    msgEl.textContent = texto;
    msgEl.className = `config-seguranca-msg ${tipo}`;
}

async function trocarSenha() {
    const atual     = document.getElementById('senha-atual')?.value;
    const nova      = document.getElementById('senha-nova')?.value;
    const confirmar = document.getElementById('senha-nova-confirmar')?.value;
    const btn       = document.getElementById('btn-trocar-senha');
    if (!btn) return;

    if (!atual || !nova || !confirmar) { mostrarMsgSeguranca('Preencha todos os campos.', 'erro'); return; }
    if (nova.length < 8) { mostrarMsgSeguranca('A nova senha precisa ter no mínimo 8 caracteres.', 'erro'); return; }
    if (nova !== confirmar) { mostrarMsgSeguranca('As senhas novas não coincidem.', 'erro'); return; }

    const orig = btn.textContent;
    btn.textContent = 'Trocando...'; btn.disabled = true;
    try {
        const res = await fetch('/auth/trocar-senha', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ senhaAtual: atual, novaSenha: nova })
        });
        const data = await res.json();
        if (!res.ok) {
            mostrarMsgSeguranca(data.erro || 'Não foi possível trocar a senha.', 'erro');
        } else {
            mostrarMsgSeguranca('✅ Senha alterada com sucesso!', 'sucesso');
            document.getElementById('senha-atual').value = '';
            document.getElementById('senha-nova').value = '';
            document.getElementById('senha-nova-confirmar').value = '';
        }
    } catch (e) {
        mostrarMsgSeguranca('Erro de conexão.', 'erro');
    } finally {
        btn.textContent = orig; btn.disabled = false;
    }
}

document.getElementById('btn-trocar-senha')?.addEventListener('click', trocarSenha);