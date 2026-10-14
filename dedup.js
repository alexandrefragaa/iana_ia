import fs from 'node:fs';

const file = new URL('./crawler/discovered_links.txt', import.meta.url);
let linksCache = null;

function carregarCache() {
    if (linksCache) return linksCache;
    linksCache = new Set();
    if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const link = line.trim().split(' | ').at(-1);
            if (link) linksCache.add(link);
        }
    }
    return linksCache;
}

export function isDuplicate(link) {
    return carregarCache().has(link);
}

export function saveLink(link) {
    const cache = carregarCache();
    if (!cache.has(link)) {
        cache.add(link);
        fs.appendFileSync(file, `${link}\n`, 'utf8');
    }
}