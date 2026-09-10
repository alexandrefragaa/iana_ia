import fs from "fs/promises";

const ARQUIVO_DESTINO = new URL('./discovered_links.txt', import.meta.url);
export async function saveDiscovery(title, link) {
    try {
        await fs.appendFile(ARQUIVO_DESTINO, `${String(title).replace(/[\r\n]+/g, ' ')} | ${link}\n`);
        return true;
    } catch (err) { console.error('Erro ao salvar descoberta:', err.message); return false; }
}
