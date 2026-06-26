import { scrape } from "./crawler/scraper.js";
import { isDuplicate, saveLink } from "./dedup.js";
import { isValidGameContent } from "./filter.js";
import { saveDiscovery } from "./crawler/savetoTxT.js";
import { saveToDB } from "./crawler/savetoDb.js";
import fs from "fs";

// Ler URLs dos arquivos de dados
function loadLinksFromFile(filepath) {
    try {
        const content = fs.readFileSync(filepath, "utf-8");
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
    // Carregar URLs reais
    const urls = loadLinksFromFile("./data/links_para_mineracao.txt");
    
    console.log(`📡 ${urls.length} links para processar`);
    
    let processed = 0;
    let learned = 0;
    
    for (const url of urls.slice(0, 20)) {
        try {
            const data = await scrape(url);
            
            if (!data) continue;
            
            if (isDuplicate(url)) {
                console.log("⏭️  Duplicado:", url);
                continue;
            }
            
            if (!isValidGameContent(data.title, url)) {
                console.log("⏭️  Não é conteúdo de game:", url);
                continue;
            }
            
            console.log("✅ Novo link:", url);
            
            saveLink(url);
            saveDiscovery(data.title, url);
            saveToDB(data.title, url);
            
            learned++;
        } catch (err) {
            console.log("❌ Erro:", err.message);
        }
        
        processed++;
    }
    
    console.log(`\n✅ Pipeline Completo!`);
    console.log(`   Processados: ${processed}`);
    console.log(`   Aprendidos: ${learned}`);
}

run();