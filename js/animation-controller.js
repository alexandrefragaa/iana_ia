/* =================================================================
   CONTROLADOR DE ANIMAÇÕES - TRANSIÇÕES DE CHAT
   ================================================================= */

class AnimacaoChat {
    constructor() {
        this.em_transicao = false;
        this.estado_atual = 'repouso'; // repouso, pensando, respondendo
    }

    /**
     * Inicia a transição para o estado de pensamento
     * Move o welcome-container pra cima e mostra o thinking-view
     */
    async iniciarPensamento() {
        if (this.em_transicao) return;
        this.em_transicao = true;

        const welcomeContainer = document.getElementById('welcome-view');
        const thinkingContainer = document.getElementById('thinking-view');
        const inputWrapper = document.querySelector('.input-area-wrapper');
        const ianaLabel = document.querySelector('.iana-label-container');
        const pilula = document.querySelector('.search-pill');

        if (!welcomeContainer || !thinkingContainer) {
            this.em_transicao = false;
            return;
        }

        // 1. Fazer o label desaparecer
        if (ianaLabel) {
            ianaLabel.classList.add('sumir');
            await this.sleep(200);
        }

        // 2. Animar welcome container pra cima
        welcomeContainer.classList.add('transitando');
        if (inputWrapper) inputWrapper.classList.add('transitando');
        if (pilula) pilula.classList.add('disabled');

        // 3. Mostrar thinking container
        thinkingContainer.style.display = 'flex';
        await this.sleep(100);
        thinkingContainer.classList.add('ativo');

        this.estado_atual = 'pensando';
        this.em_transicao = false;
    }

    /**
     * Retorna ao estado normal após receber resposta
     */
    async finalizarPensamento() {
        if (this.em_transicao) return;
        this.em_transicao = true;

        const welcomeContainer = document.getElementById('welcome-view');
        const thinkingContainer = document.getElementById('thinking-view');
        const inputWrapper = document.querySelector('.input-area-wrapper');
        const ianaLabel = document.querySelector('.iana-label-container');
        const pilula = document.querySelector('.search-pill');

        // 1. Esconder thinking container
        if (thinkingContainer) {
            thinkingContainer.classList.remove('ativo');
            await this.sleep(400);
            thinkingContainer.style.display = 'none';
        }

        // 2. Animar welcome container voltando
        if (welcomeContainer) {
            welcomeContainer.classList.remove('transitando');
            welcomeContainer.classList.add('voltando');
        }
        if (inputWrapper) {
            inputWrapper.classList.remove('transitando');
            inputWrapper.classList.add('voltando');
        }

        // 3. Label reaparece
        if (ianaLabel) {
            ianaLabel.classList.remove('sumir');
            ianaLabel.classList.add('reaparecer');
        }

        if (pilula) pilula.classList.remove('disabled');

        await this.sleep(600);

        // Limpar classes de animação
        if (welcomeContainer) welcomeContainer.classList.remove('voltando');
        if (inputWrapper) inputWrapper.classList.remove('voltando');
        if (ianaLabel) ianaLabel.classList.remove('reaparecer');

        this.estado_atual = 'repouso';
        this.em_transicao = false;
    }

    /**
     * Promise simples para delay
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Obtém o estado atual
     */
    getEstado() {
        return this.estado_atual;
    }

    /**
     * Verifica se está em transição
     */
    emTransicao() {
        return this.em_transicao;
    }
}

// Instância global
const animacaoChat = new AnimacaoChat();

/* =================================================================
   INTEGRAÇÃO COM ENVIO DE MENSAGEM
   ================================================================= */

/**
 * Envia uma mensagem para a IA
 * Integra animações, detecção emocional e chamada de API
 */
async function enviarMensagem() {
    const textarea = document.getElementById('chat-input');
    const mensagem = textarea.value.trim();

    if (!mensagem || aguardandoResposta) return;

    // Limpar input
    textarea.value = '';
    textarea.style.height = 'auto';

    // Iniciar animação de pensamento
    await animacaoChat.iniciarPensamento();

    try {
        // Detectar estado emocional (se feature.js estiver carregado)
        let estadoEmocional = 'normal';
        if (typeof detectarEstadoEmocional === 'function') {
            estadoEmocional = detectarEstadoEmocional(mensagem);
        }

        aguardandoResposta = true;

        // Chamar API do chat
        const response = await fetch('/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mensagem: mensagem,
                idConversa: idConversaAtiva || 'chat_geral',
                estadoEmocional: estadoEmocional
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const dados = await response.json();

        // Se tiver resposta, mostrar
        if (dados.resposta) {
            console.log('✅ Resposta recebida:', dados.resposta);
            
            // Aqui você pode adicionar a resposta ao chat
            // exibirMensagemIana(dados.resposta);
        }

    } catch (erro) {
        console.error('❌ Erro ao enviar mensagem:', erro);
    } finally {
        aguardandoResposta = false;
        
        // Retornar ao estado normal com pequeno delay
        await animacaoChat.sleep(500);
        await animacaoChat.finalizarPensamento();
    }
}

/**
 * Adiciona evento de teclado ao input
 */
document.addEventListener('DOMContentLoaded', () => {
    const textarea = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');

    if (textarea) {
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                enviarMensagem();
            }
        });
    }

    if (sendBtn) {
        sendBtn.addEventListener('click', enviarMensagem);
    }
});

/* =================================================================
   AUTO-RESIZE DO TEXTAREA
   ================================================================= */

document.addEventListener('DOMContentLoaded', () => {
    const textarea = document.getElementById('chat-input');
    
    if (textarea) {
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
        });
    }
});
