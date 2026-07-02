import { db } from "../backend-node/src/db/mysql.js";

export function saveToDB(title, link) {
    db.query(
        "INSERT INTO knowledge (title, url) VALUES (?, ?)",
        [title, link]
    );
}