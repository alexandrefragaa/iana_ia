/* ================================================================
   IANA — animation-controller.js

   RESPONSABILIDADES:

   1. Controlar o HUD da Iana.
   2. Controlar o estado visual:
      ocioso
      ouvindo
      pensando
      falando
   3. Controlar o indicador de pensamento do chat.
   4. Controlar a primeira transição do welcome.
   5. Permitir múltiplos HUDs.
   6. Controlar o HUD da chamada de voz.
================================================================ */

'use strict';



/* ================================================================
   IANA HUD
================================================================ */

const IanaHUD = (() => {

    const elementos = new Set();

    let estadoAtual = 'ocioso';


    /* ============================================================
       MARKUP
    ============================================================ */

    function montarMarkup() {

        return `

            <div class="jarvis-ring jarvis-ring-outer"></div>

            <div class="jarvis-ring jarvis-ring-mid"></div>

            <div class="jarvis-ring jarvis-ring-inner"></div>

            <div class="jarvis-core"></div>

            <div class="jarvis-bars">

                <span></span>
                <span></span>
                <span></span>
                <span></span>
                <span></span>

            </div>

        `;
    }


    /* ============================================================
       INICIAR
    ============================================================ */

    function iniciar(
        containerId,
        tamanho = 'sm'
    ) {

        const container =
            document.getElementById(
                containerId
            );


        if (!container) {

            console.warn(
                `IanaHUD: container #${containerId} não encontrado.`
            );

            return null;
        }


        container.classList.add(
            'jarvis-hud',
            `jarvis-hud--${tamanho}`
        );


        container.dataset.estado =
            estadoAtual;


        container.innerHTML =
            montarMarkup();


        elementos.add(
            container
        );


        return container;
    }


    /* ============================================================
       REMOVER
    ============================================================ */

    function remover(
        containerId
    ) {

        const container =
            document.getElementById(
                containerId
            );


        if (!container) {
            return;
        }


        elementos.delete(
            container
        );


        container.innerHTML = '';


        container.classList.remove(
            'jarvis-hud',
            'jarvis-hud--sm',
            'jarvis-hud--lg'
        );


        delete container.dataset.estado;
    }


    /* ============================================================
       REMOVER TODOS
    ============================================================ */

    function removerTodos() {

        elementos.forEach(
            container => {

                if (!container) {
                    return;
                }


                container.innerHTML =
                    '';


                container.classList.remove(
                    'jarvis-hud',
                    'jarvis-hud--sm',
                    'jarvis-hud--lg'
                );


                delete container.dataset.estado;

            }
        );


        elementos.clear();
    }


    /* ============================================================
       MUDAR ESTADO
    ============================================================ */

    function setEstado(
        estado
    ) {

        const estadosValidos = [

            'ocioso',

            'ouvindo',

            'pensando',

            'falando'

        ];


        if (
            !estadosValidos.includes(
                estado
            )
        ) {

            console.warn(
                `IanaHUD: estado inválido "${estado}".`
            );

            return;
        }


        estadoAtual =
            estado;


        elementos.forEach(
            elemento => {

                if (!elemento) {
                    return;
                }


                elemento.dataset.estado =
                    estado;

            }
        );
    }


    /* ============================================================
       GET ESTADO
    ============================================================ */

    function getEstado() {

        return estadoAtual;
    }


    /* ============================================================
       EXISTE
    ============================================================ */

    function existe(
        containerId
    ) {

        const container =
            document.getElementById(
                containerId
            );


        return Boolean(

            container &&
            elementos.has(
                container
            )

        );
    }


    return {

        iniciar,

        remover,

        removerTodos,

        setEstado,

        getEstado,

        existe

    };

})();


window.IanaHUD =
    IanaHUD;



/* ================================================================
   ANIMAÇÃO DO CHAT
================================================================ */

class AnimacaoChat {

    constructor() {

        this.em_transicao =
            false;


        this.estado_atual =
            'repouso';


        this.primeiraMensagemFeita =
            false;


        this.pensando =
            false;


        this._timersFase =
            [];

    }


    /* ============================================================
       SLEEP
    ============================================================ */

    sleep(ms) {

        return new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    ms
                )
        );
    }


    /* ============================================================
       ESTADO
    ============================================================ */

    getEstado() {

        return this.estado_atual;
    }


    /* ============================================================
       TRANSIÇÃO
    ============================================================ */

    emTransicao() {

        return this.em_transicao;
    }


    /* ============================================================
       MOSTRAR INDICADOR DE PENSAMENTO
       
       NÃO MOSTRA TEXTO.
       
       SOMENTE O ÍCONE.
    ============================================================ */

    mostrarPensando() {

        const thinking =
            document.getElementById(
                'thinking-view'
            );


        const dot =
            document.getElementById(
                'thinking-view-dot'
            );


        if (!thinking || !dot) {
            return;
        }


        /* Cancela qualquer timer antigo */

        this._limparTimersFase();


        /* Ativa */

        thinking.style.display =
            'flex';


        requestAnimationFrame(
            () => {

                thinking.classList.add(
                    'ativo'
                );

            }
        );


        thinking.setAttribute(
            'aria-hidden',
            'false'
        );


        this.pensando =
            true;


        this.estado_atual =
            'pensando';


        /* Estado do HUD */

        window.IanaHUD?.setEstado(
            'pensando'
        );
    }


    /* ============================================================
       ESCONDER INDICADOR
    ============================================================ */

    async esconderPensando() {

        const thinking =
            document.getElementById(
                'thinking-view'
            );


        if (!thinking) {
            return;
        }


        this._limparTimersFase();


        thinking.classList.remove(
            'ativo'
        );


        thinking.setAttribute(
            'aria-hidden',
            'true'
        );


        await this.sleep(
            220
        );


        thinking.style.display =
            'none';


        this.pensando =
            false;
    }


    /* ============================================================
       PRIMEIRA MENSAGEM
       
       A diferença aqui é que NÃO existem mais textos
       "Pensando", "Analisando" ou "Respondendo".
    ============================================================ */

    async iniciarPensamento() {

        if (
            this.em_transicao ||
            this.primeiraMensagemFeita
        ) {

            this.mostrarPensando();

            return;
        }


        this.em_transicao =
            true;


        const welcome =
            document.getElementById(
                'welcome'
            );


        const inputWrapper =
            document.querySelector(
                '.input-wrap'
            );


        const pilula =
            document.querySelector(
                '.input-pill'
            );


        if (!welcome) {

            this.em_transicao =
                false;

            this.mostrarPensando();

            return;
        }


        /* --------------------------------------------------------
           ESCONDE SUGESTÕES/WELCOME
        -------------------------------------------------------- */

        welcome.classList.add(
            'transitando'
        );


        if (inputWrapper) {

            inputWrapper.classList.add(
                'transitando'
            );
        }


        if (pilula) {

            pilula.classList.add(
                'disabled'
            );
        }


        await this.sleep(
            180
        );


        /* --------------------------------------------------------
           MARCA PRIMEIRA MENSAGEM
        -------------------------------------------------------- */

        this.primeiraMensagemFeita =
            true;


        this.em_transicao =
            false;


        /* --------------------------------------------------------
           MOSTRA ÍCONE
        -------------------------------------------------------- */

        this.mostrarPensando();
    }


    /* ============================================================
       COMPATIBILIDADE
       
       Caso algum código antigo chame _cicloDeFases(),
       não faz mais nada.
       
       Não haverá texto.
    ============================================================ */

    _cicloDeFases() {

        return;
    }


    /* ============================================================
       LIMPAR TIMERS
    ============================================================ */

    _limparTimersFase() {

        this._timersFase.forEach(
            timer =>
                clearTimeout(
                    timer
                )
        );


        this._timersFase =
            [];
    }


    /* ============================================================
       FINALIZAR PENSAMENTO
       
       Chamado quando a resposta da Iana chegou.
    ============================================================ */

    async finalizarPensamento() {

        this._limparTimersFase();


        await this.esconderPensando();


        const inputWrapper =
            document.querySelector(
                '.input-wrap'
            );


        const pilula =
            document.querySelector(
                '.input-pill'
            );


        if (inputWrapper) {

            inputWrapper.classList.remove(
                'transitando'
            );

        }


        if (pilula) {

            pilula.classList.remove(
                'disabled'
            );

        }


        this.estado_atual =
            'repouso';


        this.em_transicao =
            false;


        this.pensando =
            false;


        /*
        O chat.js pode alterar para "falando"
        caso esteja usando voz/TTS.
        */

        window.IanaHUD?.setEstado(
            'ocioso'
        );
    }


    /* ============================================================
       QUANDO A IANA COMEÇA A RESPONDER
    ============================================================ */

    iniciarResposta() {

        this.estado_atual =
            'respondendo';


        window.IanaHUD?.setEstado(
            'falando'
        );
    }


    /* ============================================================
       RESETAR CHAT
       
       Usado no Novo Chat.
    ============================================================ */

    resetar() {

        this._limparTimersFase();


        this.em_transicao =
            false;


        this.estado_atual =
            'repouso';


        this.primeiraMensagemFeita =
            false;


        this.pensando =
            false;


        const thinking =
            document.getElementById(
                'thinking-view'
            );


        const welcome =
            document.getElementById(
                'welcome'
            );


        const inputWrapper =
            document.querySelector(
                '.input-wrap'
            );


        const pilula =
            document.querySelector(
                '.input-pill'
            );


        /* --------------------------------------------------------
           THINKING
        -------------------------------------------------------- */

        if (thinking) {

            thinking.classList.remove(
                'ativo'
            );


            thinking.style.display =
                'none';


            thinking.setAttribute(
                'aria-hidden',
                'true'
            );
        }


        /* --------------------------------------------------------
           WELCOME
        -------------------------------------------------------- */

        if (welcome) {

            welcome.style.display =
                '';


            welcome.classList.remove(
                'transitando',
                'voltando'
            );
        }


        /* --------------------------------------------------------
           INPUT
        -------------------------------------------------------- */

        if (inputWrapper) {

            inputWrapper.classList.remove(
                'transitando',
                'voltando'
            );
        }


        if (pilula) {

            pilula.classList.remove(
                'disabled'
            );
        }


        /* --------------------------------------------------------
           HUD
        -------------------------------------------------------- */

        window.IanaHUD?.setEstado(
            'ocioso'
        );
    }

}



/* ================================================================
   INSTÂNCIA GLOBAL
================================================================ */

const animacaoChat =
    new AnimacaoChat();


window.animacaoChat =
    animacaoChat;



/* ================================================================
   HUD PEQUENO
================================================================ */

function inicializarIanaHUD() {

    const hud =
        document.getElementById(
            'iana-hud'
        );


    if (!hud) {
        return;
    }


    IanaHUD.iniciar(
        'iana-hud',
        'sm'
    );


    IanaHUD.setEstado(
        'ocioso'
    );
}



/* ================================================================
   INICIALIZAÇÃO
================================================================ */

if (
    document.readyState ===
    'loading'
) {

    document.addEventListener(
        'DOMContentLoaded',
        inicializarIanaHUD
    );

} else {

    inicializarIanaHUD();

}



/* ================================================================
   CHAMADA DE VOZ
================================================================ */

window.IanaVoiceUI = {


    /* ============================================================
       ABRIR
    ============================================================ */

    abrirHUD() {

        let container =
            document.getElementById(
                'iana-voice-hud'
            );


        if (!container) {

            container =
                document.createElement(
                    'div'
                );


            container.id =
                'iana-voice-hud';


            container.className =
                'iana-voice-hud';


            document.body.appendChild(
                container
            );
        }


        IanaHUD.iniciar(
            'iana-voice-hud',
            'lg'
        );


        IanaHUD.setEstado(
            'ouvindo'
        );


        document.body.classList.add(
            'iana-em-chamada'
        );
    },


    /* ============================================================
       FECHAR
    ============================================================ */

    fecharHUD() {

        IanaHUD.remover(
            'iana-voice-hud'
        );


        const container =
            document.getElementById(
                'iana-voice-hud'
            );


        if (container) {

            container.remove();

        }


        document.body.classList.remove(
            'iana-em-chamada'
        );


        IanaHUD.setEstado(
            'ocioso'
        );
    },


    /* ============================================================
       OUVINDO
    ============================================================ */

    ouvindo() {

        IanaHUD.setEstado(
            'ouvindo'
        );
    },


    /* ============================================================
       PENSANDO
    ============================================================ */

    pensando() {

        IanaHUD.setEstado(
            'pensando'
        );
    },


    /* ============================================================
       FALANDO
    ============================================================ */

    falando() {

        IanaHUD.setEstado(
            'falando'
        );
    },


    /* ============================================================
       OCIOSO
    ============================================================ */

    ocioso() {

        IanaHUD.setEstado(
            'ocioso'
        );
    }

};