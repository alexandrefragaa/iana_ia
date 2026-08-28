/* =================================================================
   IANA — animation-controller.js

   Duas coisas neste arquivo:

   1) AnimacaoChat — transição welcome -> thinking-view -> chat.
      Só roda na 1ª mensagem da conversa; se os elementos (#welcome,
      #thinking-view) não existirem no HTML atual, ela detecta isso
      e não faz nada (sem erro) — ver comentário "Sem welcome" abaixo.

   2) IanaHUD — o orbe estilo Jarvis usado na tela de chamada de voz
      (#voz-hud-grande) e em qualquer outro elemento com a classe
      .jarvis-hud. FIX: essa parte tinha sumido de versões anteriores
      deste arquivo — sem ela, o <div class="jarvis-hud"> ficava vazio
      pra sempre (nada nunca injetava os anéis dentro dele). Agora ela
      se auto-monta sozinha (não depende de chat.js chamar nada) e
      também aceita ser chamada manualmente via IanaHUD.iniciar(id).
   ================================================================= */

'use strict';


/* ────────────────────────────────────────────────────────────────
   1) CONTROLADOR DE TRANSIÇÃO (welcome -> thinking -> chat)
   ──────────────────────────────────────────────────────────────── */

class AnimacaoChat {

    constructor() {
        this.em_transicao = false;

        /*
         * Estados possíveis:
         *
         * repouso
         * pensando
         * respondendo
         */
        this.estado_atual = 'repouso';

        /*
         * Controla se a primeira mensagem já iniciou
         * a transição welcome -> chat.
         */
        this.primeiraMensagemFeita = false;
    }


    sleep(ms) {
        return new Promise(resolve => {
            setTimeout(resolve, ms);
        });
    }


    getEstado() {
        return this.estado_atual;
    }


    emTransicao() {
        return this.em_transicao;
    }


    primeiraMensagemEnviada() {
        return this.primeiraMensagemFeita;
    }


    async iniciarPensamento() {

        if (this.em_transicao) {
            return false;
        }

        if (this.primeiraMensagemFeita) {
            return false;
        }

        this.em_transicao = true;

        const welcomeContainer =
            document.getElementById('welcome');

        const thinkingContainer =
            document.getElementById('thinking-view');

        const inputWrapper =
            document.querySelector('.input-wrap');

        const ianaLabel =
            document.querySelector('.iana-label-container');

        const pilula =
            document.querySelector('.input-pill');


        /*
         * Sem welcome (o HTML atual não tem mais #welcome — o
         * chat.js insere a tela de boas-vindas dinamicamente com
         * outra estrutura): não há nada pra animar. Marcamos como
         * feito pra não tentar de novo, e seguimos sem erro.
         */
        if (!welcomeContainer) {

            this.primeiraMensagemFeita = true;
            this.estado_atual = 'pensando';
            this.em_transicao = false;

            return true;
        }


        if (ianaLabel) {
            ianaLabel.classList.add('sumir');
            await this.sleep(200);
        }


        welcomeContainer.classList.add('transitando');


        if (inputWrapper) {
            inputWrapper.classList.add('transitando');
        }


        if (pilula) {
            pilula.classList.add('disabled');
        }


        if (thinkingContainer) {
            thinkingContainer.style.display = 'flex';
            await this.sleep(50);
            thinkingContainer.classList.add('ativo');
        }


        this.estado_atual = 'pensando';
        this.em_transicao = false;

        return true;
    }


    async finalizarPensamento() {

        if (this.em_transicao) {
            return false;
        }

        this.em_transicao = true;

        const thinkingContainer =
            document.getElementById('thinking-view');

        const inputWrapper =
            document.querySelector('.input-wrap');

        const pilula =
            document.querySelector('.input-pill');


        if (thinkingContainer) {
            thinkingContainer.classList.remove('ativo');
            await this.sleep(250);
            thinkingContainer.style.display = 'none';
        }


        if (inputWrapper) {
            inputWrapper.classList.remove('transitando');
        }


        if (pilula) {
            pilula.classList.remove('disabled');
        }


        this.primeiraMensagemFeita = true;
        this.estado_atual = 'repouso';
        this.em_transicao = false;

        return true;
    }


    resetar() {

        this.em_transicao = false;
        this.estado_atual = 'repouso';
        this.primeiraMensagemFeita = false;

        const welcomeContainer =
            document.getElementById('welcome');

        const thinkingContainer =
            document.getElementById('thinking-view');

        const inputWrapper =
            document.querySelector('.input-wrap');

        const ianaLabel =
            document.querySelector('.iana-label-container');

        const pilula =
            document.querySelector('.input-pill');


        if (welcomeContainer) {
            welcomeContainer.classList.remove('transitando');
        }


        if (thinkingContainer) {
            thinkingContainer.classList.remove('ativo');
            thinkingContainer.style.display = 'none';
        }


        if (inputWrapper) {
            inputWrapper.classList.remove('transitando');
        }


        if (pilula) {
            pilula.classList.remove('disabled');
        }


        if (ianaLabel) {
            ianaLabel.classList.remove('sumir');
        }
    }


    definirEstado(estado) {

        const estadosValidos = [
            'repouso',
            'pensando',
            'respondendo'
        ];

        if (!estadosValidos.includes(estado)) {
            return false;
        }

        this.estado_atual = estado;

        return true;
    }
}


const animacaoChat = new AnimacaoChat();
window.animacaoChat = animacaoChat;
window.AnimacaoChat = AnimacaoChat;


/* ────────────────────────────────────────────────────────────────
   2) IanaHUD — orbe estilo Jarvis (anéis + núcleo + barrinhas)

   FIX: recolocado nesta versão do arquivo. Não depende de nenhum
   outro script chamar iniciar() — ele mesmo procura por qualquer
   elemento .jarvis-hud já existente no HTML (ex: #voz-hud-grande)
   e monta os anéis dentro na hora que a página carrega. setEstado()
   também garante a montagem antes de aplicar o estado, então mesmo
   que um .jarvis-hud apareça depois (inserido dinamicamente por
   outro script) ele ainda funciona.
   ──────────────────────────────────────────────────────────────── */

const IanaHUD = (() => {
    let estadoAtual = 'ocioso';

    function montarMarkup() {
        return `
            <div class="jarvis-ring jarvis-ring-outer"></div>
            <div class="jarvis-ring jarvis-ring-mid"></div>
            <div class="jarvis-ring jarvis-ring-inner"></div>
            <div class="jarvis-core"></div>
            <div class="jarvis-bars">
                <span></span><span></span><span></span><span></span><span></span>
            </div>
        `;
    }

    function montarTodos() {
        document.querySelectorAll('.jarvis-hud').forEach(el => {
            if (el.dataset.jarvisMontado === 'true') return;
            el.innerHTML = montarMarkup();
            el.dataset.estado = estadoAtual;
            el.dataset.jarvisMontado = 'true';
        });
    }

    /**
     * Chamada opcional — útil quando o container ainda não tem a
     * classe .jarvis-hud no HTML (ex: um id genérico que precisa
     * virar orbe via JS). Se o HTML já tiver a classe, isso é
     * redundante e inofensivo.
     * @param {string} containerId
     * @param {'sm'|'lg'} tamanho
     */
    function iniciar(containerId, tamanho = 'sm') {
        const el = document.getElementById(containerId);
        if (!el) {
            console.warn(`IanaHUD: container #${containerId} não encontrado.`);
            return;
        }
        el.classList.add('jarvis-hud', `jarvis-hud--${tamanho}`);
        montarTodos();
    }

    function setEstado(estado) {
        estadoAtual = estado;
        montarTodos();
        document.querySelectorAll('.jarvis-hud').forEach(el => {
            el.dataset.estado = estado;
        });
    }

    function getEstado() {
        return estadoAtual;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', montarTodos, { once: true });
    } else {
        montarTodos();
    }

    return { iniciar, setEstado, getEstado };
})();

window.IanaHUD = IanaHUD;