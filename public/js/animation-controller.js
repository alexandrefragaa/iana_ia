
/* =================================================================
   IANA — animation-controller.js

   Transição:
   welcome -> thinking-view -> chat

   A animação acontece somente na primeira mensagem da conversa.

   Mensagens seguintes:
   - não repetem a transição;
   - usam o indicador de digitação normal do chat.js.

   Compatível com:
   - chat.js
   - features.js
   - thinking-view opcional
   - layout atual sem thinking-view-dot/texto
   ================================================================= */

'use strict';


/* ────────────────────────────────────────────────────────────────
   CONTROLADOR
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


    /* ────────────────────────────────────────────────────────────
       UTILITÁRIO
       ──────────────────────────────────────────────────────────── */

    sleep(ms) {
        return new Promise(resolve => {
            setTimeout(resolve, ms);
        });
    }


    /* ────────────────────────────────────────────────────────────
       ESTADO
       ──────────────────────────────────────────────────────────── */

    getEstado() {
        return this.estado_atual;
    }


    emTransicao() {
        return this.em_transicao;
    }


    primeiraMensagemEnviada() {
        return this.primeiraMensagemFeita;
    }


    /* ────────────────────────────────────────────────────────────
       INICIAR PENSAMENTO
       ──────────────────────────────────────────────────────────── */

    async iniciarPensamento() {

        /*
         * Não inicia duas transições simultaneamente.
         */
        if (this.em_transicao) {
            return false;
        }

        /*
         * Se a primeira mensagem já aconteceu,
         * não repete a animação.
         */
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
         * Sem welcome:
         *
         * Não há nada para animar.
         * Mesmo assim marcamos a primeira mensagem como feita
         * para impedir novas tentativas.
         */
        if (!welcomeContainer) {

            this.primeiraMensagemFeita = true;
            this.estado_atual = 'pensando';
            this.em_transicao = false;

            return true;
        }


        /* ─────────────────────────────────────────────────────────
           LABEL DA IANA
           ───────────────────────────────────────────────────────── */

        if (ianaLabel) {

            ianaLabel.classList.add('sumir');

            await this.sleep(200);
        }


        /* ─────────────────────────────────────────────────────────
           WELCOME
           ───────────────────────────────────────────────────────── */

        welcomeContainer.classList.add('transitando');


        /* ─────────────────────────────────────────────────────────
           INPUT
           ───────────────────────────────────────────────────────── */

        if (inputWrapper) {
            inputWrapper.classList.add('transitando');
        }


        if (pilula) {
            pilula.classList.add('disabled');
        }


        /* ─────────────────────────────────────────────────────────
           THINKING VIEW
           ───────────────────────────────────────────────────────── */

        /*
         * O thinking-view é opcional.
         *
         * Isso permite que o mesmo JS seja utilizado
         * em páginas que não possuem esse elemento.
         */

        if (thinkingContainer) {

            thinkingContainer.style.display = 'flex';

            /*
             * Pequeno delay para permitir que o navegador
             * registre display:flex antes da animação CSS.
             */
            await this.sleep(50);

            thinkingContainer.classList.add('ativo');
        }


        /* ─────────────────────────────────────────────────────────
           ESTADO
           ───────────────────────────────────────────────────────── */

        this.estado_atual = 'pensando';

        this.em_transicao = false;

        return true;
    }


    /* ────────────────────────────────────────────────────────────
       FINALIZAR PENSAMENTO
       ──────────────────────────────────────────────────────────── */

    async finalizarPensamento() {

        /*
         * Não executa duas finalizações simultaneamente.
         */
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


        /* ─────────────────────────────────────────────────────────
           THINKING VIEW
           ───────────────────────────────────────────────────────── */

        if (thinkingContainer) {

            thinkingContainer.classList.remove('ativo');

            /*
             * Tempo da animação de saída.
             */
            await this.sleep(250);

            thinkingContainer.style.display = 'none';
        }


        /* ─────────────────────────────────────────────────────────
           INPUT
           ───────────────────────────────────────────────────────── */

        if (inputWrapper) {
            inputWrapper.classList.remove('transitando');
        }


        if (pilula) {
            pilula.classList.remove('disabled');
        }


        /* ─────────────────────────────────────────────────────────
           ESTADO FINAL
           ───────────────────────────────────────────────────────── */

        this.primeiraMensagemFeita = true;

        this.estado_atual = 'repouso';

        this.em_transicao = false;

        return true;
    }


    /* ────────────────────────────────────────────────────────────
       RESET
       ──────────────────────────────────────────────────────────── */

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


        /*
         * Welcome
         */
        if (welcomeContainer) {
            welcomeContainer.classList.remove('transitando');
        }


        /*
         * Thinking view
         */
        if (thinkingContainer) {

            thinkingContainer.classList.remove('ativo');

            thinkingContainer.style.display = 'none';
        }


        /*
         * Input
         */
        if (inputWrapper) {
            inputWrapper.classList.remove('transitando');
        }


        /*
         * Input pill
         */
        if (pilula) {
            pilula.classList.remove('disabled');
        }


        /*
         * Label
         */
        if (ianaLabel) {
            ianaLabel.classList.remove('sumir');
        }
    }


    /* ────────────────────────────────────────────────────────────
       DEFINIR ESTADO
       ──────────────────────────────────────────────────────────── */

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


/* ────────────────────────────────────────────────────────────────
   INSTÂNCIA GLOBAL
   ──────────────────────────────────────────────────────────────── */

const animacaoChat = new AnimacaoChat();

window.animacaoChat = animacaoChat;


/* ────────────────────────────────────────────────────────────────
   COMPATIBILIDADE
   ──────────────────────────────────────────────────────────────── */

window.AnimacaoChat = AnimacaoChat;
