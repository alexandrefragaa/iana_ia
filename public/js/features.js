/* ================================================================
   IANA — features.js
   Detecção emocional, caps lock, respiração
   ================================================================ */

'use strict';

/* ── DETECÇÃO DE ESTADO EMOCIONAL ─────────────────────────────── */
function detectarEstadoEmocional(texto) {
    if (!texto) return 'normal';
    const letras  = (texto.match(/[A-Za-z]/g) || []).length;
    const caps    = (texto.match(/[A-Z]/g) || []).length;
    const pctCaps = letras > 0 ? (caps / letras) * 100 : 0;
    if (pctCaps > 70 || /\*{4,}/.test(texto)) return 'raiva';
    if (/!{2,}/.test(texto) || /\?{2,}/.test(texto)) return 'estressado';
    if (/[!?]{2,}/.test(texto)) return 'frustrado';
    return 'normal';
}

/* ── AVISO CAPS LOCK ──────────────────────────────────────────── */
function detectarCapsLock(e) {
    if (e.getModifierState?.('CapsLock')) mostrarAvisoCaps();
    else esconderAvisoCaps();
}

function mostrarAvisoCaps() {
    let el = document.getElementById('caps-aviso');
    if (!el) {
        el = document.createElement('div');
        el.id = 'caps-aviso';
        el.style.cssText = `
            position:absolute; bottom:calc(100% + 6px); right:16px;
            background:rgba(239,68,68,.12); border:1px solid rgba(239,68,68,.4);
            border-radius:8px; padding:6px 12px; font-size:.78rem;
            color:#f87171; white-space:nowrap; z-index:10;
            animation:fadeUp .2s ease;
        `;
        el.textContent = '⚠️ CAPS LOCK ativado';
        const wrap = document.querySelector('.input-pill');
        if (wrap) { wrap.style.position = 'relative'; wrap.appendChild(el); }
    }
    el.style.display = 'block';
}

function esconderAvisoCaps() {
    const el = document.getElementById('caps-aviso');
    if (el) el.style.display = 'none';
}

/* ── INIT ─────────────────────────────────────────────────────── */
function iniciarFeatures() {
    const textarea = document.getElementById('chat-input');
    if (!textarea) return;
    textarea.addEventListener('keydown', detectarCapsLock);
    // keyup extra: alguns navegadores só atualizam o estado do modifier
    // de forma confiável depois que a tecla é solta
    textarea.addEventListener('keyup', detectarCapsLock);
    textarea.addEventListener('blur', esconderAvisoCaps);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarFeatures);
} else {
    iniciarFeatures();
}

/* ── EXPORTS GLOBAIS ──────────────────────────────────────────── */
window.detectarEstadoEmocional = detectarEstadoEmocional;