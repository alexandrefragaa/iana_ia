import mysql.connector
import os
import random
from datetime import datetime, timedelta
from dotenv import load_dotenv
import smtplib
from email.message import EmailMessage

# Carrega as credenciais do arquivo .env
load_dotenv()

def get_db_connection():
    """Gerencia a conexão com o banco de dados MySQL."""
    return mysql.connector.connect(
        host=os.getenv('DB_HOST'),
        user=os.getenv('DB_USER'),
        password=os.getenv('DB_PASS'),
        database=os.getenv('DB_NAME')
    )

def enviar_email_codigo(destinatario, codigo):
    """Dispara o e-mail com o código de 6 dígitos."""
    msg = EmailMessage()
    msg.set_content(f"Seu código de recuperação Iana é: {codigo}.\nEle expira em 10 minutos.")
    msg['Subject'] = 'Recuperação de Senha - Iana'
    msg['From'] = os.getenv('EMAIL_USER')
    msg['To'] = destinatario

    with smtplib.SMTP_SSL('smtp.gmail.com', 465) as smtp:
        smtp.login(os.getenv('EMAIL_USER'), os.getenv('EMAIL_PASS'))
        smtp.send_message(msg)

# =====================================================================
# FUNÇÕES QUE A SUA INTERFACE VAI CHAMAR (A PONTE COM OS BOTÕES)
# =====================================================================

def iniciar_recuperacao_senha(email):
    """
    Ação do Botão 'Esqueci minha senha':
    Gera o código, salva no banco e envia por e-mail.
    """
    try:
        # 1. Gera o código e calcula expiração
        codigo = str(random.randint(100000, 999999))
        expira_em = datetime.now() + timedelta(minutes=10)
        
        # 2. Salva ou atualiza no MySQL
        conn = get_db_connection()
        cursor = conn.cursor()
        query = """
        INSERT INTO recuperacao_senha (email, codigo, expira_em) 
        VALUES (%s, %s, %s)
        ON DUPLICATE KEY UPDATE codigo=%s, expira_em=%s
        """
        cursor.execute(query, (email, codigo, expira_em, codigo, expira_em))
        conn.commit()
        cursor.close()
        conn.close()
        
        # 3. Dispara o e-mail
        enviar_email_codigo(email, codigo)
        return True, "Código enviado com sucesso para o seu e-mail!"
        
    except Exception as e:
        return False, f"Erro no sistema de recuperação: {e}"

def confirmar_codigo_e_mudar_senha(email, codigo_digitado, nova_senha):
    """
    Ação do Botão 'Confirmar/Continuar':
    Valida o código. Se estiver certo, atualiza a senha e limpa o token.
    """
    try:
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        
        # 1. Busca o código no banco
        query = "SELECT codigo, expira_em FROM recuperacao_senha WHERE email = %s"
        cursor.execute(query, (email,))
        resultado = cursor.fetchone()
        
        if not resultado:
            cursor.close()
            conn.close()
            return False, "E-mail não encontrado ou nenhum código solicitado."
        
        # 2. Verifica se o código expirou
        if datetime.now() > resultado['expira_em']:
            cursor.close()
            conn.close()
            return False, "O código expirou. Solicite um novo."
        
        # 3. Verifica se o código está correto
        if str(resultado['codigo']) != str(codigo_digitado):
            cursor.close()
            conn.close()
            return False, "Código incorreto. Tente novamente."
        
        # 4. SE DEU CERTO: Atualiza a senha do usuário e deleta o código para segurança
        # (AQUI: Altere 'usuarios' e 'senha' para os nomes reais da sua tabela de login)
        query_update_senha = "UPDATE usuarios SET senha = %s WHERE email = %s"
        cursor.execute(query_update_senha, (nova_senha, email))
        
        query_deletar_token = "DELETE FROM recuperacao_senha WHERE email = %s"
        cursor.execute(query_deletar_token, (email,))
        
        conn.commit()
        cursor.close()
        conn.close()
        
        return True, "Senha alterada com sucesso! Agora você já pode fazer login."
        
    except Exception as e:
        return False, f"Erro ao atualizar senha: {e}"