/* =================================================================
   IANA — animation-controller.js
   Transição welcome -> "pensando" (Pensando/Analisando/Respondendo)
   Roda só na 1ª mensagem da sessão/conversa; chamado pelo chat.js.

   FIX (ativação real): este arquivo antes definia seu PRÓPRIO
   enviarMensagem() e seus próprios listeners de teclado/clique nos
   MESMOS elementos que o chat.js já usa (#chat-input, #send-btn), e
   usava IDs/classes (welcome-view, thinking-view, .search-pill,
   .iana-label-container) que não existiam no HTML. Como não estava
   incluído no index.html, nunca rodava — mas se alguém adicionasse o
   <script> sem perceber, ele sobrescrevia o enviarMensagem() de
   verdade (o do chat.js, com histórico/config/abort controller) por
   uma versão incompleta que nem mostrava a resposta na tela.

   Agora: só expõe a classe AnimacaoChat + uma instância global
   `animacaoChat`. Toda a lógica de envio continua 100% no chat.js,
   que chama animacaoChat.iniciarPensamento()/finalizarPensamento()
   quando for o caso.
   ================================================================= */

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
    }
}

// Instância global usada pelo chat.js
const animacaoChat = new AnimacaoChat();
window.animacaoChat = animacaoChat;