
import os

BASE_PATH = os.path.join(
    os.environ["LOCALAPPDATA"],
    "iana_database"
)

os.makedirs(BASE_PATH, exist_ok=True)

def get_db_path(filename):
    return os.path.join(BASE_PATH, filename)