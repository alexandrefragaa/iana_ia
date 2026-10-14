// Substitua de processarEnvioIAStreaming até enviarMensagem no seu public/js/chat.js:

async function processarEnvioIA(texto, opcoesAnexo = null, previewAnexo = null) {
    if (aguardandoResposta) return;

    const textoLimpo = String(texto || '').trim();
    if (!textoLimpo && !opcoesAnexo) return;

    // Se houver anexo (foto, vídeo, áudio, PDF), usa a rota POST /chat
    if (opcoesAnexo) {
        aguardandoResposta = true;
        atualizarBotoesChat(true);
        controller = new AbortController();

        removerWelcome();
        if (previewAnexo) adicionarAnexoUsuarioDOM(previewAnexo);
        adicionarMensagemDOM('usuario', textoLimpo);

        const indicador = mostrarIndicadorDigitando();

        try {
            const payload = {
                mensagem: textoLimpo,
                conversa_id: idConversaAtiva,
                config_usuario: obterConfigSalva(),
                ...opcoesAnexo
            };

            const response = await fetch('/chat', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            const data = await response.json().catch(() => ({}));
            removerIndicadorDigitando();

            if (!response.ok) {
                throw new Error(data.mensagem || 'Não foi possível processar o anexo.');
            }

            const respostaTexto = data.resposta || 'Recebi o seu arquivo!';
            const elementoIA = adicionarMensagemDOM('ia', respostaTexto);
            const conteudoEl = elementoIA?.querySelector('.mensagem-conteudo');
            if (conteudoEl && typeof marked !== 'undefined') {
                conteudoEl.innerHTML = sanitizarHTML(marked.parse(respostaTexto, { breaks: true }));
            }

            if (data.conversa_id) idConversaAtiva = data.conversa_id;
            if (usuarioAtual) carregarHistorico();
            if (ttsNextResponse) {
                ttsNextResponse = false;
                falar(respostaTexto);
            }
        } catch (err) {
            removerIndicadorDigitando();
            if (err.name !== 'AbortError') {
                adicionarMensagemDOM('ia', err.message || 'Erro ao enviar anexo para a Iana.');
            }
        } finally {
            controller = null;
            aguardandoResposta = false;
            atualizarBotoesChat(false);
        }
        return;
    }

    // Caso seja mensagem de texto, usa o Streaming Token a Token (SSE)
    return await processarEnvioIAStreaming(textoLimpo);
}

async function processarEnvioIAStreaming(texto) {
    const textoLimpo = String(texto || '').trim();
    if (!textoLimpo || aguardandoResposta) return;

    aguardandoResposta = true;
    atualizarBotoesChat(true);
    controller = new AbortController();

    removerWelcome();
    adicionarMensagemDOM('usuario', textoLimpo);

    const elementoIA = adicionarMensagemDOM('ia', '...');
    const conteudoEl = elementoIA.querySelector('.mensagem-conteudo');
    const container = obterElemento('chat-messages') || obterElemento('mensagens');

    let textoAcumulado = '';
    let bufferSSE = '';

    try {
        const params = new URLSearchParams({
            mensagem: textoLimpo,
            conversa_id: idConversaAtiva || '',
            config: JSON.stringify(obterConfigSalva())
        });

        const response = await fetch(`/chat/stream?${params.toString()}`, {
            credentials: 'include',
            signal: controller.signal
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.mensagem || `Erro HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            bufferSSE += decoder.decode(value, { stream: true });
            const blocos = bufferSSE.split('\n\n');
            bufferSSE = blocos.pop() || ''; // Guarda linha incompleta para o próximo pacote TCP

            for (const bloco of blocos) {
                const linha = bloco.trim();
                if (!linha.startsWith('data: ')) continue;

                try {
                    const json = JSON.parse(linha.substring(6));
                    if (json.erro) {
                        textoAcumulado = json.erro;
                        conteudoEl.textContent = textoAcumulado;
                    }
                    if (json.chunk) {
                        textoAcumulado += json.chunk;
                        conteudoEl.textContent = textoAcumulado;
                        if (container) container.scrollTop = container.scrollHeight;
                    }
                    if (json.conversa_id) {
                        idConversaAtiva = json.conversa_id;
                    }
                } catch {}
            }
        }

        if (!textoAcumulado.trim()) {
            textoAcumulado = 'Não consegui gerar uma resposta agora. Tenta de novo?';
            conteudoEl.textContent = textoAcumulado;
        } else if (typeof marked !== 'undefined') {
            conteudoEl.innerHTML = sanitizarHTML(marked.parse(textoAcumulado, { breaks: true }));
        }

        if (usuarioAtual) carregarHistorico();
        if (ttsNextResponse) {
            ttsNextResponse = false;
            falar(textoAcumulado);
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            conteudoEl.textContent = textoAcumulado || '[Resposta interrompida pelo jogador.]';
        } else {
            console.error('[IANA STREAM]', err);
            conteudoEl.textContent = err.message || 'Ocorreu um erro ao gerar a resposta em tempo real.';
        }
    } finally {
        controller = null;
        aguardandoResposta = false;
        atualizarBotoesChat(false);
    }
}