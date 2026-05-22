import chromadb
from pathlib import Path
import os

# Define o mesmo caminho que você usou no script principal
path_banco = Path(os.getenv('LOCALAPPDATA')) / "iana_database" / "chromadb"

# Conecta ao banco
client = chromadb.PersistentClient(path=str(path_banco))
collection = client.get_or_create_collection(name="conhecimento_jogos")

# 1. Verifica quantos itens (documentos) existem
contagem = collection.count()
print(f"📊 Total de documentos minerados no banco: {contagem}")

# 2. Mostra os últimos 3 itens para você ver o que tem lá
if contagem > 0:
    print("\n🔍 Amostra dos dados:")
    resultados = collection.peek(3) # Pega os 3 primeiros
    for i, doc in enumerate(resultados['documents']):
        print(f"\n--- Item {i+1} ---")
        print(f"URL: {resultados['metadatas'][i]}")
        print(f"Texto (primeiros 100 caracteres): {doc[:100]}...")
else:
    print("⚠️ O banco está vazio!")