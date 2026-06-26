<<<<<<< HEAD
//scraper.js

import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";

export async function scrape(url) {
    try {
        const { data } = await axios.get(url);
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
=======
//scraper.js

import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";

export async function scrape(url) {
    try {
        const { data } = await axios.get(url);
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
>>>>>>> dff1b3145e486aa6f40565c5c012d7d0d2b98c3f
}