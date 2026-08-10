/* ================================================================
   IANA — features.js
   Detecção emocional + Caps Lock
   ================================================================ */

'use strict';

/* ────────────────────────────────────────────────────────────────
   DETECÇÃO EMOCIONAL
   ──────────────────────────────────────────────────────────────── */

function detectarEstadoEmocional(texto) {
    if (typeof texto !== 'string' || !texto.trim()) {
        return 'normal';
    }

    const letras = (texto.match(/[A-Za-zÀ-ÿ]/g) || []).length;
    const caps = (texto.match(/[A-ZÀ-Ý]/g) || []).length;

    const pctCaps = letras > 0
        ? (caps / letras) * 100
        : 0;

    /*
     * Raiva:
     * - maioria das letras em CAPS
     * - sequência de asteriscos usada como ênfase
     */
    if (
        pctCaps > 70 ||
        /\*{4,}/.test(texto)
    ) {
        return 'raiva';
    }

    /*
     * Frustração:
     * combinações como:
     * !?
     * ?!
     */
    if (/[!?]{2,}/.test(texto)) {
        const temExclamacao = /!/.test(texto);
        const temPergunta = /\?/.test(texto);

        if (temExclamacao && temPergunta) {
            return 'frustrado';
        }
    }

    /*
     * Estresse:
     * múltiplos ! ou ?
     */
    if (
        /!{2,}/.test(texto) ||
        /\?{2,}/.test(texto)
    ) {
        return 'estressado';
    }

    return 'normal';
}


/* ────────────────────────────────────────────────────────────────
   CAPS LOCK
   ──────────────────────────────────────────────────────────────── */

function detectarCapsLock(event) {
    if (!event) return;

    try {
        if (event.getModifierState?.('CapsLock')) {
            mostrarAvisoCaps();
        } else {
            esconderAvisoCaps();
        }
    } catch {
        // Alguns navegadores podem não disponibilizar getModifierState.
    }
}


/* ────────────────────────────────────────────────────────────────
   MOSTRAR AVISO
   ──────────────────────────────────────────────────────────────── */

function mostrarAvisoCaps() {
    let el = document.getElementById('caps-aviso');

    if (!el) {
        el = document.createElement('div');
        el.id = 'caps-aviso';

        el.style.cssText = `
            position: absolute;
            bottom: calc(100% + 6px);
            right: 16px;

            background: rgba(239, 68, 68, 0.12);
            border: 1px solid rgba(239, 68, 68, 0.4);

            border-radius: 8px;
            padding: 6px 12px;

            font-size: 0.78rem;
            line-height: 1.2;

            color: #f87171;

            white-space: nowrap;
            z-index: 100;

            pointer-events: none;

            animation: ianaCapsFadeUp 0.2s ease;
        `;

        el.textContent = '⚠️ CAPS LOCK ativado';

        const wrap = document.querySelector('.input-pill');

        if (wrap) {
            const positionAtual = getComputedStyle(wrap).position;

            if (positionAtual === 'static') {
                wrap.style.position = 'relative';
            }

            wrap.appendChild(el);
        } else {
            /*
             * Fallback caso .input-pill ainda não exista.
             */
            document.body.appendChild(el);

            el.style.position = 'fixed';
            el.style.right = '20px';
            el.style.bottom = '90px';
        }
    }

    el.style.display = 'block';
}


/* ────────────────────────────────────────────────────────────────
   ESCONDER AVISO
   ──────────────────────────────────────────────────────────────── */

function esconderAvisoCaps() {
    const el = document.getElementById('caps-aviso');

    if (el) {
        el.style.display = 'none';
    }
}


/* ────────────────────────────────────────────────────────────────
   CSS DA ANIMAÇÃO
   ──────────────────────────────────────────────────────────────── */

function inserirEstiloFeatures() {
    if (document.getElementById('iana-features-style')) {
        return;
    }

    const style = document.createElement('style');

    style.id = 'iana-features-style';

    style.textContent = `
        @keyframes ianaCapsFadeUp {
            from {
                opacity: 0;
                transform: translateY(4px);
            }

            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
    `;

    document.head.appendChild(style);
}


/* ────────────────────────────────────────────────────────────────
   INICIALIZAÇÃO
   ──────────────────────────────────────────────────────────────── */

function iniciarFeatures() {
    const textarea = document.getElementById('chat-input');

    inserirEstiloFeatures();

    if (!textarea) {
        return;
    }

    /*
     * Evita registrar os mesmos eventos duas vezes.
     */
    if (textarea.dataset.featuresInicializadas === 'true') {
        return;
    }

    textarea.dataset.featuresInicializadas = 'true';

    textarea.addEventListener(
        'keydown',
        detectarCapsLock
    );

    textarea.addEventListener(
        'keyup',
        detectarCapsLock
    );

    textarea.addEventListener(
        'blur',
        esconderAvisoCaps
    );

    textarea.addEventListener(
        'focus',
        event => {
            detectarCapsLock(event);
        }
    );
}


/* ────────────────────────────────────────────────────────────────
   DOM READY
   ──────────────────────────────────────────────────────────────── */

if (document.readyState === 'loading') {
    document.addEventListener(
        'DOMContentLoaded',
        iniciarFeatures,
        { once: true }
    );
} else {
    iniciarFeatures();
}


/* ────────────────────────────────────────────────────────────────
   API GLOBAL
   ──────────────────────────────────────────────────────────────── */

window.detectarEstadoEmocional = detectarEstadoEmocional;
window.detectarCapsLock = detectarCapsLock;
window.mostrarAvisoCaps = mostrarAvisoCaps;
window.esconderAvisoCaps = esconderAvisoCaps;
window.iniciarFeatures = iniciarFeatures;
