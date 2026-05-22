import smtplib
from email.message import EmailMessage

def enviar_email_recuperacao(destinatario, codigo):
    msg = EmailMessage()
    msg.set_content(f"Olá! Seu código de recuperação para a Iana é: {codigo}. Ele expira em 10 minutos.")
    msg['Subject'] = 'Recuperação de Senha - Iana IA'
    msg['From'] = 'seu_email@gmail.com' # Configure aqui
    msg['To'] = destinatario

    # Configuração do servidor (exemplo Gmail)
    with smtplib.SMTP_SSL('smtp.gmail.com', 465) as smtp:
        smtp.login('seu_email@gmail.com', 'sua_senha_de_app')
        smtp.send_message(msg)