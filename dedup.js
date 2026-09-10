import fs from 'node:fs';
const file = new URL('./crawler/discovered_links.txt', import.meta.url);
export function isDuplicate(link) {
    if (!fs.existsSync(file)) return false;
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).some(line => line.trim().split(' | ').at(-1) === link);
}
export function saveLink(link) { fs.appendFileSync(file, link + '\n'); }
