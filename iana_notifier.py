import smtplib
from email.message import EmailMessage
import os
from dotenv import load_dotenv

load_dotenv()

def enviar_email(destinatario, codigo):
    msg = EmailMessage()
    msg.set_content(f"Seu código de recuperação Iana é: {codigo}. Ele expira em 10 minutos.")
    msg['Subject'] = 'Recuperação de Senha - Iana'
    msg['From'] = os.getenv('EMAIL_USER')
    msg['To'] = destinatario

    # Usando servidor SMTP (ex: Gmail)
    with smtplib.SMTP_SSL('smtp.gmail.com', 465) as smtp:
        smtp.login(os.getenv('EMAIL_USER'), os.getenv('EMAIL_PASS'))
        smtp.send_message(msg)