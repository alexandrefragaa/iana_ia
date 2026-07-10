//scraper.js

import axios from "axios";
import * as cheerio from "cheerio";

export async function scrape(url) {
    try {
        const { data } = await axios.get(url, { timeout: 8000 });
        const $ = cheerio.load(data);

        const title = $("title").text();

        const links = [];

        $("a").each((i, el) => {
            const href = $(el).attr("href");
            if (href && href.startsWith("http")) {
                links.push(href);
            }
        });

        return {
            title,
            links
        };
    } catch (err) {
        console.log("Erro scraping:", err.message);
        return null;
    }
}