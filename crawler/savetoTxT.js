import fs from "fs";

export function saveDiscovery(title, link) {
    fs.appendFileSync(
        "./crawler/discovered_links.txt",
        `${title} | ${link}\n`
    );
}