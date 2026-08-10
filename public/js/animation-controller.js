/* =================================================================
   IANA — animation-controller.js
   Transição welcome -> thinking-view. Roda só na 1ª mensagem da
   sessão/conversa (saindo da tela de boas-vindas); chamado pelo
   chat.js. Mensagens seguintes usam o typing indicator simples.

   FIX: o design do thinking-view mudou (agora é uma linha com um
   ícone pulsante, não mais um texto ciclando "Pensando/Analisando/
   Respondendo") — removida a lógica de ciclo de fases, que dependia
   de elementos (#thinking-view-dot, #thinking-view-texto) que não
   existem mais no HTML atual.
   ================================================================= */

class AnimacaoChat {
    constructor() {
        this.em_transicao = false;
        this.estado_atual = 'repouso'; // repouso, pensando, respondendo
        this.primeiraMensagemFeita = false;
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
     * Move o welcome pra fora de cena e mostra o thinking-view no lugar.
     */
    async iniciarPensamento() {
        if (this.em_transicao || this.primeiraMensagemFeita) return;
        this.em_transicao = true;

        const welcomeContainer = document.getElementById('welcome');
        const thinkingContainer = document.getElementById('thinking-view');
        const inputWrapper = document.querySelector('.input-wrap');
        const ianaLabel = document.querySelector('.iana-label-container');
        const pilula = document.querySelector('.input-pill');

        if (!welcomeContainer) {
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

        // thinking-view é opcional: se não existir no HTML desta página,
        // só a transição do welcome roda (sem quebrar nada).
        if (thinkingContainer) {
            thinkingContainer.style.display = 'flex';
            await this.sleep(100);
            thinkingContainer.classList.add('ativo');
        }

        this.estado_atual = 'pensando';
        this.em_transicao = false;
    }

    /**
     * Esconde o thinking-view. A partir daqui já estamos em modo chat —
     * mensagens seguintes usam o typing indicator normal do chat.js.
     */
    async finalizarPensamento() {
        if (this.em_transicao) return;
        this.em_transicao = true;

        const thinkingContainer = document.getElementById('thinking-view');
        const inputWrapper = document.querySelector('.input-wrap');
        const pilula = document.querySelector('.input-pill');

        if (thinkingContainer) {
            thinkingContainer.classList.remove('ativo');
            await this.sleep(250);
            thinkingContainer.style.display = 'none';
        }

        if (inputWrapper) inputWrapper.classList.remove('transitando');
        if (pilula) pilula.classList.remove('disabled');

        this.primeiraMensagemFeita = true;
        this.estado_atual = 'repouso';
        this.em_transicao = false;
    }
}

const animacaoChat = new AnimacaoChat();
window.animacaoChat = animacaoChat;