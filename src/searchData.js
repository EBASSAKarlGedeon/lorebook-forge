// Search data: the ONLY module that talks to search endpoints.
// Owns the SearXNG HTML parser — selectors verified against real
// output from searxng/searxng:latest (2026-10), see Stage 3 dump.
import { getContext } from "../../../../extensions.js";
import { extensionName } from "./config.js";

// Raw fetch: returns the results-page HTML from ST's server-side proxy.
async function fetchSearxngHtml(baseUrl, query) {
    const response = await fetch("/api/search/searxng", {
        method: "POST",
        headers: getContext().getRequestHeaders(),
        cache: "no-cache",
        body: JSON.stringify({ baseUrl, query }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.error(`[${extensionName}] SearXNG request failed: HTTP ${response.status}`, text.slice(0, 500));
        throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
}

// Parse the results HTML into structured objects.
// Structure per result (verified):
//   article.result > .result_inner > h3 a (title+href), p.content (snippet)
//   article.result > .engines > span (engine names)
export function parseSearxngResults(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const results = [];
    for (const article of doc.querySelectorAll("article.result")) {
        const titleLink = article.querySelector("h3 a");
        const url = titleLink?.getAttribute("href") || "";
        const title = titleLink?.textContent?.trim() || "";
        // Skip non-standard results (images, videos, infoboxes) — no title/URL
        if (!url || !title) continue;
        results.push({
            title,
            url,
            snippet: article.querySelector("p.content")?.textContent?.trim() || "",
            engines: [...article.querySelectorAll(".engines span")]
                .map(s => s.textContent.trim()).filter(Boolean),
            thumbnail: article.querySelector("img.thumbnail")?.getAttribute("src") || null,
        });
    }
    return results;
}

// The public search API. Stage 5+ (page reading, distillation) build on this.
export async function searchSearxng(baseUrl, query) {
    console.log(`[${extensionName}] Searching SearXNG for: "${query}"`);
    const html = await fetchSearxngHtml(baseUrl, query);
    const results = parseSearxngResults(html);
    console.log(`[${extensionName}] Parsed ${results.length} results`,
        results.slice(0, 3).map(r => ({ title: r.title, url: r.url, engines: r.engines })));
    return results;
}

// Connection test (Stage 3) — kept for the button.
export async function testSearxngConnection(baseUrl) {
    console.log(`[${extensionName}] Testing SearXNG at ${baseUrl}...`);
    const html = await fetchSearxngHtml(baseUrl, "connectivity test");
    console.log(`[${extensionName}] SearXNG responded: ${html.length} chars of HTML`);
    const articleCount = (html.match(/<article/g) || []).length;
    console.log(`[${extensionName}] <article> elements found: ${articleCount}`);
    return html;
}
