// public/js/features.js
// Funcionalidades adicionais: CAPS LOCK detection, pausa, etc

let estadoEmocional = 'normal'; // normal, estressado, raiva, frustrado

/**
 * Detecta estado emocional baseado em indicadores visuais
 * Requisito #11: CAPS LOCK, !!, ?!, ???, ****
 */
function detectarEstadoEmocional(texto) {
    if (!texto) return 'normal';

    const capsLock = (texto.match(/[A-Z]/g) || []).length;
    const totalLetras = (texto.match(/[A-Za-z]/g) || []).length;
    const percentualCaps = totalLetras > 0 ? (capsLock / totalLetras) * 100 : 0;

    const temExclamacoes = /!{2,}/.test(texto);
    const temInterrogacoes = /\?{2,}/.test(texto);
    const temMisto = /[!?]{2,}/.test(texto);
    const temAstriscos = /\*{4,}/.test(texto);

    if (percentualCaps > 70 || temAstriscos) {
        return 'raiva';
    } else if (temExclamacoes || temInterrogacoes) {
        return 'estressado';
    } else if (temMisto) {
        return 'frustrado';
    }

    return 'normal';
}

function obterInstrucaoEmocional(estado) {
    const instrucoes = {
        'normal': 'Responda normalmente, de forma conversacional e divertida.',
        'estressado': 'A pessoa parece um pouco estressada. Responda de forma mais calma e reconfortante.',
        'raiva': 'A pessoa está muito estressada ou irritada. Responda com empatia, calma e compreensão.',
        'frustrado': 'A pessoa está frustrada. Seja empático, compreenda a situação e ofereça soluções de forma tranquila.'
    };
    return instrucoes[estado] || instrucoes.normal;
}

function detectarCapsLock(event) {
    const letra = event.key;
    const temShift = event.shiftKey;

    if (letra.length === 1) {
        if ((letra === letra.toUpperCase() && letra !== letra.toLowerCase() && !temShift) ||
            (letra === letra.toLowerCase() && temShift)) {
            mostrarAvisoCapsLock();
        } else {
            esconderAvisoCapsLock();
        }
    }
}

function mostrarAvisoCapsLock() {
    let aviso = document.getElementById('caps-lock-warning');
    if (!aviso) {
        aviso = document.createElement('div');
        aviso.id = 'caps-lock-warning';
        aviso.style.cssText = `
            position: absolute;
            bottom: 100%;
            right: 0;
            background: rgba(248, 113, 113, 0.1);
            border: 1px solid rgba(248, 113, 113, 0.5);
            border-radius: 8px;
            padding: 8px 12px;
            font-size: 0.85rem;
            color: #f87171;
            margin-bottom: 5px;
            white-space: nowrap;
        `;
        aviso.textContent = '⚠️ CAPS LOCK ativado';

        const textarea = document.getElementById('chat-input');
        if (textarea && textarea.parentElement) {
            textarea.parentElement.style.position = 'relative';
            textarea.parentElement.appendChild(aviso);
        }
    }
    aviso.style.display = 'block';
}

function esconderAvisoCapsLock() {
    const aviso = document.getElementById('caps-lock-warning');
    if (aviso) {
        aviso.style.display = 'none';
    }
}

async function aguardarRespiracao(tempoMs = 500) {
    return new Promise(resolve => setTimeout(resolve, tempoMs));
}

function criarEfeitoRespiracao() {
    const container = document.createElement('div');
    container.className = 'respiracao-visual';
    container.style.cssText = `
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 10px 0;
    `;

    const pontos = ['', '', ''];
    pontos.forEach((_, i) => {
        const ponto = document.createElement('div');
        ponto.style.cssText = `
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #a855f7;
            animation: respirar 1.5s ease-in-out infinite;
            animation-delay: ${i * 0.15}s;
        `;
        container.appendChild(ponto);
    });

    return container;
}

function inicializarDeteccaoEmocional() {
    const textarea = document.getElementById('chat-input');
    if (!textarea) return;

    textarea.addEventListener('keydown', detectarCapsLock);
    textarea.addEventListener('input', () => {
        estadoEmocional = detectarEstadoEmocional(textarea.value);
    });
}

const style = document.createElement('style');
style.textContent = `
    @keyframes respirar {
        0%, 100% {
            transform: scale(0.8);
            opacity: 0.5;
        }
        50% {
            transform: scale(1.2);
            opacity: 1;
        }
    }

    #caps-lock-warning {
        animation: slideDown 0.3s ease-out;
    }

    @keyframes slideDown {
        from {
            opacity: 0;
            transform: translateY(-10px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }
`;
document.head.appendChild(style);

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inicializarDeteccaoEmocional);
} else {
    inicializarDeteccaoEmocional();
}

window.detectarEstadoEmocional = detectarEstadoEmocional;
window.obterInstrucaoEmocional = obterInstrucaoEmocional;
window.aguardarRespiracao = aguardarRespiracao;
window.criarEfeitoRespiracao = criarEfeitoRespiracao;