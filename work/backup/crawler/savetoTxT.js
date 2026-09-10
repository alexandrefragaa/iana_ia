import fs from "fs/promises";

// Mantive o caminho relativo original ("./crawler/discovered_links.txt").
// Atenção: assim como no scrape_learning.py, esse caminho depende de onde
// o processo Node é executado (cwd), não de onde este arquivo está.
// Se rodar via cron/deploy de outra pasta, ele pode gravar no lugar errado
// ou falhar por a pasta "./crawler" não existir ali. Se quiser, troco por
// um caminho baseado em __dirname (mais seguro).
const ARQUIVO_DESTINO = "./crawler/discovered_links.txt";

export async function saveDiscovery(title, link) {
    try {
        await fs.appendFile(ARQUIVO_DESTINO, `${title} | ${link}\n`);
        return true;
    } catch (err) {
        console.error("Erro ao salvar descoberta:", err.message);
        return false;
    }
}