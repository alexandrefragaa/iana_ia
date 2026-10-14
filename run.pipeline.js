import { scrape }              from "./crawler/scraper.js";
import { isDuplicate, saveLink } from "./dedup.js";
import { isValidGameContent }  from "./filter.js";
import { saveDiscovery }       from "./crawler/savetoTxT.js";
import fs from "fs";

function loadLinksFromFile(filepath) {
    try {
        const content = fs.readFileSync(new URL(filepath, import.meta.url), "utf-8");
        return content
            .split("\n")
            .map(line => line.trim())
            .filter(line => line.startsWith("http"));
    } catch (err) {
        console.log("❌ Erro lendo arquivo:", err.message);
        return [];
    }
}

async function run() {
    const urls = loadLinksFromFile("./data/links_para_mineracao.txt");
    console.log(`📡 ${urls.length} links para processar`);

    let processed = 0;
    let learned   = 0;

    for (const url of urls.slice(0, 20)) {
        processed++;
        try {
            if (isDuplicate(url)) {
                console.log("⏭️  Duplicado:", url);
                continue;
            }

            const data = await scrape(url);
            if (!data) continue;

            if (!isValidGameContent(data.title, url)) {
                console.log("⏭️  Não é conteúdo de game:", url);
                continue;
            }

            console.log("✅ Novo link:", url);
            if (await saveDiscovery(data.title, url)) {
                saveLink(url);
                learned++;
            }
        } catch (err) {
            console.log("❌ Erro:", err.message);
        }
    }

    console.log(`\n✅ Pipeline Completo!`);
    console.log(`   Processados: ${processed}`);
    console.log(`   Aprendidos:  ${learned}`);
}

run();