import { db } from "../backend-node/src/db/mysql.js";

// Assumindo que `db` é um pool mysql2/promise (db.query retorna uma Promise).
// Se seu `db` usar API por callback (mysql2 "clássico"), me avisa que ajusto.
export async function saveToDB(title, link) {
    try {
        await db.query(
            "INSERT INTO knowledge (title, url) VALUES (?, ?)",
            [title, link]
        );
        return true;
    } catch (err) {
        console.error("Erro ao salvar no banco:", err.message);
        return false;
    }
}