from flask import Flask, request, jsonify

# 1. Inicializa o servidor da API [10]
app = Flask(__name__)

# 2. Cria o endpoint /api/chat com o método POST [6, 11]
@app.route('/api/chat', methods=['POST'])
def responder_ia():
    # Pega os dados enviados no corpo da requisição [7]
    dados = request.get_json()
    mensagem_usuario = dados.get("mensagem", "")
    
    # Lógica e personalidade da sua IA
    resposta_ia = f"Olá! Sou a sua IA personalizada. Você disse: '{mensagem_usuario}'"
    
    # Retorna o resultado formatado em JSON [8, 9]
    return jsonify({
        "status": "sucesso",
        "resposta": resposta_ia
    })

# 3. Executa o servidor na porta 5000 [10, 12]
if __name__ == '__main__':
    app.run(port=5000, debug=True)