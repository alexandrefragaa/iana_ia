import mysql.connector
import os
from dotenv import load_dotenv # Importa o carregador

# Carrega as variáveis do arquivo .env
load_dotenv()

def get_db_connection():
    return mysql.connector.connect(
        host=os.getenv('DB_HOST'),
        user=os.getenv('DB_USER'),
        password=os.getenv('DB_PASS'),
        database=os.getenv('DB_NAME')
    )

def get_db_connection():
    return mysql.connector.connect(**db_config)

def gerar_codigo_recuperacao(email):
    """Gera um código de 6 dígitos e salva no MySQL com validade de 10 min."""
    codigo = str(random.randint(100000, 999999))
    expira_em = datetime.now() + timedelta(minutes=10)
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Query otimizada para MySQL
    query = """
    INSERT INTO recuperacao_senha (email, codigo, expira_em) 
    VALUES (%s, %s, %s)
    ON DUPLICATE KEY UPDATE codigo=%s, expira_em=%s
    """
    cursor.execute(query, (email, codigo, expira_em, codigo, expira_em))
    conn.commit()
    cursor.close()
    conn.close()
    return codigo

def validar_codigo(email, codigo_digitado):
    """Verifica se o código é válido e se ainda não expirou."""
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    
    query = "SELECT codigo, expira_em FROM recuperacao_senha WHERE email = %s"
    cursor.execute(query, (email,))
    resultado = cursor.fetchone()
    
    if not resultado:
        return False, "E-mail não encontrado."
    
    # Verifica expiração (o MySQL retorna o datetime corretamente)
    if datetime.now() > resultado['expira_em']:
        return False, "Código expirado. Solicite um novo."
    
    if str(resultado['codigo']) == str(codigo_digitado):
        return True, "Código validado com sucesso!"
    else:
        return False, "Código incorreto."