
from flask import Flask, request, jsonify

app = Flask(__name__)

# 1. Configurações de Segurança
MINHA_API_KEY = "iana-chave-secreta-123"

# 2. System Prompt Estruturado (Inspirado nas melhores IAs)
SYSTEM_PROMPT_GAMER = """

""".strip()

# 3. Armazenamento de Histórico em Memória
sessoes_memoria = {}

@app.route('/api/chat', methods=['POST'])
def chat_iana():
    # --- A. VALIDAÇÃO DE SEGURANÇA (API Key) ---
    api_key_recebida = request.headers.get("X-API-Key")
    if api_key_recebida != MINHA_API_KEY:
        return jsonify({
            "status": "erro",
            "mensagem": "Acesso não autorizado! API Key inválida."
        }), 401

    # --- B. LEITURA DA REQUISIÇÃO ---
    dados = request.get_json() or {}
    mensagem_usuario = dados.get("mensagem", "").strip()
    sessao_id = dados.get("sessao_id", "jogador_default")

    if not mensagem_usuario:
        return jsonify({"status": "erro", "mensagem": "Envie uma mensagem válida."}), 400

    # --- C. GERENCIAMENTO DE MEMÓRIA (Sessão) ---
    if sessao_id not in sessoes_memoria:
        # Inicializa a sessão com o System Prompt
        sessoes_memoria[sessao_id] = [
            {"role": "system", "content": SYSTEM_PROMPT_GAMER}
        ]

    # Salva a nova mensagem do jogador
    sessoes_memoria[sessao_id].append({"role": "user", "content": mensagem_usuario})

    # --- D. SIMULAÇÃO / INTEGRAÇÃO DA RESPOSTA DA IA ---
    # Aqui, quando você conectar o SDK de um modelo (ex: Gemini ou Claude), 
    # você enviará a lista 'sessoes_memoria[sessao_id]' como contexto da conversa.
    
    # Exemplo de resposta da IANA adaptada ao tom gamer:
    resposta_ia = (
        f"E aí, jogador! 🎮 Recebi sua mensagem: '{mensagem_usuario}'. "
        f"Estou pronta para te ajudar a detonar nesse jogo e buscar essa platina! "
        f"Qual é o chefão ou desafio que estamos enfrentando hoje?"
    )

    # Salva a resposta da IANA no histórico
    sessoes_memoria[sessao_id].append({"role": "assistant", "content": resposta_ia})

    # --- E. RETORNO EM JSON ---
    return jsonify({
        "status": "sucesso",
        "sessao_id": sessao_id,
        "resposta": resposta_ia,
        "historico_count": len(sessoes_memoria[sessao_id]) - 1  # desconta o system prompt
    })

if __name__ == '__main__':
    app.run(port=5000, debug=True)
