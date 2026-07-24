/* =================================================================
   IANA — animation-controller.js (integrado)
   Contém DUAS coisas que trabalham juntas:

   1) IanaHUD — controla o estado visual da silhueta do troféu
      (ocioso | ouvindo | pensando | falando), lendo o CSS em
      trophy-hud.css via data-estado.

   2) AnimacaoChat — controla a transição welcome -> thinking-view
      que roda só na 1ª mensagem da sessão. Chamado pelo chat.js.

   A integração acontece dentro do próprio AnimacaoChat: sempre que
   ele muda de fase, ele também empurra o estado equivalente pro
   IanaHUD, então o troféu e o texto "Pensando/Analisando/Respondendo"
   ficam sincronizados na primeira mensagem.

   Para as mensagens seguintes (fora da 1ª) e para a chamada de voz,
   quem chama IanaHUD.setEstado(...) é o próprio chat.js diretamente
   — ver os comentários "INTEGRAÇÃO HUD" nesse arquivo.
   ================================================================= */
'use strict';

/* ── 1) IanaHUD ──────────────────────────────────────────────── */
const IanaHUD = (() => {
    let elHud = null;

    /**
     * Inicializa o HUD dentro de um container existente.
     * @param {string} containerId - id do elemento que vai virar o HUD
     */
    function iniciar(containerId) {
        const container = document.getElementById(containerId);
        if (!container) {
            console.warn(`IanaHUD: container #${containerId} não encontrado.`);
            return;
        }
        container.classList.add('trophy-wrap');
        container.dataset.estado = 'ocioso';
        container.innerHTML = '<div class="trophy-silhueta"></div>';
        elHud = container;
    }

    /**
     * Muda o estado visual do HUD.
     * @param {'ocioso'|'ouvindo'|'pensando'|'falando'} estado
     */
    function setEstado(estado) {
        if (!elHud) return;
        elHud.dataset.estado = estado;
    }

    function getEstado() {
        return elHud ? elHud.dataset.estado : null;
    }

    return { iniciar, setEstado, getEstado };
})();
window.IanaHUD = IanaHUD;


/* ── 2) AnimacaoChat ─────────────────────────────────────────── */
class AnimacaoChat {
    constructor() {
        this.em_transicao = false;
        this.estado_atual = 'repouso'; // repouso, pensando, respondendo
        this.primeiraMensagemFeita = false;
        this._timersFase = [];
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    getEstado() {
        return this.estado_atual;
    }

    emTransicao() {
        return this.em_transicao;
    }

    /**
     * Move o welcome pra fora de cena e mostra o thinking-view no lugar,
     * com o status ciclando Pensando -> Analisando -> Respondendo.
     * Sincroniza o IanaHUD para 'pensando' assim que a transição entra
     * em vigor.
     */
    async iniciarPensamento() {
        if (this.em_transicao || this.primeiraMensagemFeita) return;
        this.em_transicao = true;

        const welcomeContainer = document.getElementById('welcome');
        const thinkingContainer = document.getElementById('thinking-view');
        const inputWrapper = document.querySelector('.input-wrap');
        const ianaLabel = document.querySelector('.iana-label-container');
        const pilula = document.querySelector('.input-pill');

        if (!welcomeContainer || !thinkingContainer) {
            // Elementos não existem nesta página — não quebra nada,
            // só não anima (ex: outra tela que reusa este script).
            this.em_transicao = false;
            return;
        }

        if (ianaLabel) {
            ianaLabel.classList.add('sumir');
            await this.sleep(200);
        }

        welcomeContainer.classList.add('transitando');
        if (inputWrapper) inputWrapper.classList.add('transitando');
        if (pilula) pilula.classList.add('disabled');

        thinkingContainer.style.display = 'flex';
        await this.sleep(100);
        thinkingContainer.classList.add('ativo');

        this.estado_atual = 'pensando';
        this.em_transicao = false;

        // INTEGRAÇÃO HUD: sincroniza o troféu com a fase de pensamento.
        window.IanaHUD?.setEstado('pensando');

        this._cicloDeFases();
    }

    /**
     * Alterna o texto/cor do status enquanto espera a resposta da API.
     * Fica parado em "Respondendo" até finalizarPensamento() rodar.
     */
    _cicloDeFases() {
        const dot = document.getElementById('thinking-view-dot');
        const texto = document.getElementById('thinking-view-texto');
        if (!dot || !texto) return;

        const fases = [
            { classe: 'thinking-dot', texto: 'Pensando' },
            { classe: 'analyzing-dot', texto: 'Analisando' },
            { classe: 'speaking-dot', texto: 'Respondendo' }
        ];

        this._limparTimersFase();
        fases.forEach((fase, i) => {
            const t = setTimeout(() => {
                dot.className = fase.classe;
                texto.textContent = fase.texto;
            }, i * 1200);
            this._timersFase.push(t);
        });
    }

    _limparTimersFase() {
        this._timersFase.forEach(t => clearTimeout(t));
        this._timersFase = [];
    }

    /**
     * Esconde o thinking-view. A partir daqui já estamos em modo chat —
     * mensagens seguintes usam o typing indicator normal do chat.js.
     * Sincroniza o IanaHUD de volta pra 'ocioso' (chat.js pode
     * sobrescrever pra 'falando' logo em seguida se for tocar TTS).
     */
    async finalizarPensamento() {
        if (this.em_transicao) return;
        this.em_transicao = true;
        this._limparTimersFase();

        const thinkingContainer = document.getElementById('thinking-view');
        const inputWrapper = document.querySelector('.input-wrap');
        const pilula = document.querySelector('.input-pill');

        if (thinkingContainer) {
            thinkingContainer.classList.remove('ativo');
            await this.sleep(400);
            thinkingContainer.style.display = 'none';
        }

        if (inputWrapper) inputWrapper.classList.remove('transitando');
        if (pilula) pilula.classList.remove('disabled');

        this.primeiraMensagemFeita = true;
        this.estado_atual = 'repouso';
        this.em_transicao = false;

        // INTEGRAÇÃO HUD: volta ao repouso visual.
        window.IanaHUD?.setEstado('ocioso');
    }
}

// Instância global usada pelo chat.js
const animacaoChat = new AnimacaoChat();
window.animacaoChat = animacaoChat;