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

// ---------- Page reading (Stage 5) ----------
// Verified against ST's own WebScraper (public/scripts/scrapers.js):
// POST /api/search/visit { url } → response body IS the page content.

export async function fetchPageHtml(url) {
    console.log(`[${extensionName}] Visiting page: ${url}`);
    const response = await fetch("/api/search/visit", {
        method: "POST",
        headers: getContext().getRequestHeaders(),
        cache: "no-cache",
        body: JSON.stringify({ url }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.error(`[${extensionName}] /visit failed: HTTP ${response.status}`, text.slice(0, 300));
        throw new Error(`HTTP ${response.status}`);
    }
    const html = await response.text();
    console.log(`[${extensionName}] Page fetched: ${html.length} chars`);
    return html;
}

// Extract readable text from a full HTML page.
// Strategy: prefer <article>/<main>, else <body>; strip the usual
// noise containers first. Heuristic, not perfect — good enough for
// research material that the user will curate anyway.
export function extractPageText(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, noscript, iframe, svg, nav, header, footer, aside, form, button").forEach(el => el.remove());
    const source = doc.querySelector("article") || doc.querySelector("main") || doc.body;
    if (!source) return "";
    const text = source.textContent
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .split("\n")
        .map(line => line.trim())
        .join("\n")
        .trim();
    return text;
}

export async function fetchPageText(url) {
    const html = await fetchPageHtml(url);
    const text = extractPageText(html);
    console.log(`[${extensionName}] Extracted ${text.length} chars of text. First 300 chars:\n`, text.slice(0, 300));
    if (!text) throw new Error("No readable text found on this page.");
    return text;
}