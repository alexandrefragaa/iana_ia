import fs from "fs";

export function isDuplicate(link) {
    const data = fs.readFileSync("./crawler/discovered_links.txt", "utf-8");
    return data.includes(link);
}

export function saveLink(link) {
    fs.appendFileSync("./crawler/discovered_links.txt", link + "\n");

}