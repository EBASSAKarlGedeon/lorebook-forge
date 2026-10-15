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
    // Reddit's modern UI is a JS shell with no server-rendered text;
    // old.reddit serves real HTML for the same URLs.
    let fetchUrl = url;
    try {
        const u = new URL(url);
        if (/(^|\.)reddit\.com$/i.test(u.hostname)) {
            u.hostname = "old.reddit.com";
            fetchUrl = u.toString();
            console.log(`[${extensionName}] Reddit rewrite: ${fetchUrl}`);
        }
    } catch { /* leave URL as-is */ }
    console.log(`[${extensionName}] Visiting page: ${fetchUrl}`);
    const response = await fetch("/api/search/visit", {
        method: "POST",
        headers: getContext().getRequestHeaders(),
        cache: "no-cache",
        body: JSON.stringify({ url: fetchUrl }),
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
// Strategy: score candidate containers by text length and pick the
// RICHEST one — not the first <article> (which is often a promo banner).
// Diagnostics are logged so we can tune against real pages.
export function extractPageText(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");

    // Remove non-content elements (keep header/footer for now — they're
    // candidates for scoring; we strip them from the winner afterwards)
    doc.querySelectorAll("script, style, noscript, iframe, svg, form, button, template, nav, aside").forEach(el => el.remove());

    // Candidate containers, most specific first. body is the fallback.
    const candidates = [
        ...doc.querySelectorAll("article, main, [role='main'], [itemprop='articleBody']"),
        doc.body,
    ].filter(Boolean);

    // Score each by trimmed text length; log the table for diagnosis
    const scores = [];
    let best = null;
    let bestLen = 0;
    for (const el of candidates) {
        const len = (el.textContent || "").replace(/\s+/g, " ").trim().length;
        const label = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className ? `.${String(el.className).split(" ").slice(0, 2).join(".")}` : ""}`;
        scores.push(`${label}: ${len}`);
        if (len > bestLen) { bestLen = len; best = el; }
    }
    console.log(`[${extensionName}] Container scores:\n  ${scores.join("\n  ")}`);

    if (!best || bestLen === 0) return "";

    // If the winner is <body>, strip the usual chrome inside it
    if (best === doc.body) {
        best.querySelectorAll("header, footer").forEach(el => el.remove());
    }

    const text = best.textContent
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .split("\n")
        .map(line => line.trim())
        .join("\n")
        .trim();
    return text;
}

// ---------- Smart source routing (Stage 6.5) ----------

const MEDIAWIKI_HOST_PATTERNS = [
    /\.fandom\.com$/i,
    /\.wiki\.gg$/i,
    /(^|\.)wikipedia\.org$/i,
];

function getMediaWikiPageTitle(url) {
    try {
        const u = new URL(url);
        const m = u.pathname.match(/^\/wiki\/([^/]+)/);
        return m ? decodeURIComponent(m[1]) : null;
    } catch { return null; }
}

export function isMediaWikiUrl(url) {
    try {
        const u = new URL(url);
        return MEDIAWIKI_HOST_PATTERNS.some(p => p.test(u.hostname)) && !!getMediaWikiPageTitle(url);
    } catch { return false; }
}

// Wikitext → readable text. Templates/refs/tables stripped (innermost-first,
// repeated passes for nesting); links resolved to their display text.
export function wikitextToText(wikitext) {
    let text = String(wikitext ?? "");
    text = text.replace(/<!--[\s\S]*?-->/g, "");                    // HTML comments
    text = text.replace(/<ref[^>]*\/>/gi, "");                      // self-closing refs
    text = text.replace(/<ref[\s\S]*?<\/ref>/gi, "");               // ref blocks
    text = text.replace(/<br\s*\/?>/gi, "\n");                      // line breaks
    for (let i = 0; i < 20; i++) {                                  // tables {| ... |}
        const next = text.replace(/\{\|[^{}]*\|\}/g, "");
        if (next === text) break;
        text = next;
    }
    for (let i = 0; i < 20; i++) {                                  // templates {{ ... }}
        const next = text.replace(/\{\{[^{}]*\}\}/g, "");
        if (next === text) break;
        text = next;
    }
    text = text.replace(/\[\[(?:Category|File|Image|wp|w):[^\]]*\]\]/gi, ""); // metadata links
    text = text.replace(/\[\[(?:[^\[\]|]*\|)?([^\[\]|]*)\]\]/g, "$1");        // [[a|b]] → b
    text = text.replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]*)\]/g, "$2");       // [url label] → label
    text = text.replace(/\[(https?:\/\/[^\s\]]+)\]/g, "$1");                  // [url] → url
    text = text.replace(/^=+\s*(.*?)\s*=+$/gm, "$1");               // headings → plain lines
    text = text.replace(/^[*#:]+ */gm, "");                         // list bullets
    text = text.replace(/'''''([^']*)'''''/g, "$1");                // bold-italic
    text = text.replace(/'''([^']*)'''/g, "$1");                    // bold
    text = text.replace(/''([^']*)''/g, "$1");                      // italic
    text = text.replace(/__(NOTOC|TOC|FORCETOC|NOEDITSECTION)__\b/gi, "");
    return decodeHtmlEntities(text.replace(/\n{3,}/g, "\n\n").trim());
}

// ---------- Stage 17: MediaWiki rendered-HTML route ----------
// Primary: action=parse&prop=text — the wiki engine expands ALL templates
// ({{Nihongo}} terms survive, entities decode) and returns just the article
// body HTML. Verified against Fandom: contains rendered ruby readings,
// reference superscripts, and prunable navboxes. Falls back to the legacy
// wikitext route if prop=text is unavailable.

const MEDIAWIKI_NOISE_SELECTORS = [
    "sup.reference",        // citation superscripts [1]
    ".mw-cite-backlink",    // ↑ arrows in the reference list
    ".mw-references-wrap",  // the whole References section output
    ".references",          // some wiki skins use this instead
    "table.nav",             // navigation boxes (e.g. Skills NavBox)
    ".navbox",
    "#toc",
    ".mw-editsection",
    ".article-tabs",
    ".mw-empty-elt",
];

// Rendered-HTML (media wiki) → readable text. Structure-aware, no regex.
function renderedMediaWikiToText(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");

    // 1) Prune noise
    doc.querySelectorAll(MEDIAWIKI_NOISE_SELECTORS.join(", ")).forEach(el => el.remove());

    // 2) Infobox → "Label: Value" lines (canonical facts: names, debuts, users).
    //    piped data comes as .pi-data label/value pairs on Fandom.
    for (const aside of [...doc.querySelectorAll("aside.portable-infobox")]) {
        const parts = [];
        const title = aside.querySelector(".pi-title")?.textContent.trim() || "";
        for (const data of aside.querySelectorAll(".pi-data")) {
            const label = data.querySelector(".pi-data-label")?.textContent.trim() || "";
            const value = (data.querySelector(".pi-data-value")?.textContent || "").replace(/\s+/g, " ").trim();
            if (label && value) parts.push(`${label}: ${value}`);
        }
        const div = doc.createElement("div");
        div.textContent = (title ? `== Infobox: ${title} ==\n` : "") + parts.join("\n") + "\n";
        aside.replaceWith(div);
    }

    // 3) Headings → "== Title ==" lines so section structure survives flattening
    for (const h of [...doc.querySelectorAll("h2, h3, h4")]) {
        const level = h.tagName === "H2" ? "==" : "===";
        const div = doc.createElement("div");
        div.textContent = `\n\n${level} ${h.textContent.trim()} ${level}\n`;
        h.replaceWith(div);
    }

    // 4) Block elements → newline boundaries so paragraphs/list rows stay readable
    for (const p of doc.querySelectorAll("p, li, tr, dd, dt, blockquote, figure")) {
        p.appendChild(doc.createTextNode("\n"));
    }

    // 5) The rendered body always ships inside .mw-parser-output — target it
    //    directly instead of content-scoring fallbacks.
    const root = doc.querySelector(".mw-parser-output") || doc.body;
    return root.textContent
        .replace(/[ \t]+/g, " ")
        .split("\n")
        .map(line => line.trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// ---------- Stage 18: wiki link discovery ----------
// Harvest internal /wiki/ links from the MediaWiki rendered HTML. Same noise
// pruning as the text route (navboxes/refs/toc would flood the list).
// URL shape verified against a real api.php sample:
// <a href="/wiki/Page_title" ...> inside .mw-parser-output.
const WIKI_LINK_SKIP_PREFIXES = /^(File|Image|Special|Template|Help|User|Talk|MediaWiki|Draft|Project|Forum):/i;

export function collectWikiLinks(html, originUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll(MEDIAWIKI_NOISE_SELECTORS.join(", ")).forEach(el => el.remove());
    const origin = new URL(originUrl);
    const seen = new Map();
    for (const a of doc.querySelectorAll("a[href^='/wiki/']")) {
        const href = a.getAttribute("href") || "";
        if (/[?&](action|oldid|redlink|diff|veaction)=/i.test(href)) continue;
        try {
            const u = new URL(href, origin);
            const m = u.pathname.match(/^\/wiki\/([^?#]+)/);
            if (!m) continue;
            const pageTitle = decodeURIComponent(m[1]).replace(/_/g, " ");
            if (WIKI_LINK_SKIP_PREFIXES.test(pageTitle)) continue;
            if (decodeURIComponent(u.pathname) === decodeURIComponent(origin.pathname)) continue; // self-link
            const url = `${u.origin}/wiki/${m[1]}`;
            const label = String(a.textContent || "").replace(/\s+/g, " ").trim() || pageTitle;
            if (!seen.has(url)) seen.set(url, { label: label.slice(0, 80), title: pageTitle, url });
        } catch { /* bad href — skip */ }
    }
    const links = [...seen.values()];
    console.log(`[${extensionName}] collectWikiLinks: ${links.length} unique internal link(s) from "${originUrl}"`, links.slice(0, 8));
    return links;
}

// Legacy fallback: entity-decoding patch for the wikitext cleaner, so
// &mdash; / &#8212; / &nbsp; don't leak into drafts if this path is ever hit.
function decodeHtmlEntities(text) {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—",
                    ndash: "–", hellip: "…", laquo: "«", raquo: "»", middot: "·", bull: "•" };
    return String(text)
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

async function fetchMediaWikiText(url) {
    const u = new URL(url);
    const title = getMediaWikiPageTitle(url);
    const ctx = getContext();

    // --- Primary route: rendered HTML (prop=text) ---
    try {
        const renderedUrl = `${u.origin}/api.php?action=parse&page=${encodeURIComponent(title)}` +
            `&format=json&prop=text&disabletoc=1&disableeditsection=1&disablelimitreport=1`;
        console.log(`[${extensionName}] MediaWiki rendered route: ${renderedUrl}`);
        const response = await fetch("/api/search/visit", {
            method: "POST",
            headers: ctx.getRequestHeaders(),
            cache: "no-cache",
            body: JSON.stringify({ url: renderedUrl, html: false }),
        });
        if (response.ok) {
            const body = await response.text();
            const data = JSON.parse(body); // throws → caught below
            if (data?.error) throw new Error(`MediaWiki: ${data.error.info || data.error.code}`);
            const renderedHtml = data?.parse?.text?.["*"];
            if (typeof renderedHtml === "string" && renderedHtml.trim()) {
                const text = renderedMediaWikiToText(renderedHtml);
                if (!text) throw new Error("Rendered text came back empty");
                console.log(`[${extensionName}] MediaWiki rendered "${data.parse.title || title}": ` +
                    `${renderedHtml.length} chars HTML → ${text.length} chars text. First 300:\n`, text.slice(0, 300));
                return { text, title: data.parse.title || title, raw: text, route: "MediaWiki (rendered)", html: renderedHtml };
            }
        }
        // fall through to legacy route
        console.warn(`[${extensionName}] prop=text unavailable (HTTP ${response.status}) — falling back to wikitext route`);
    } catch (err) {
        console.warn(`[${extensionName}] Rendered route failed (${err.message}) — falling back to wikitext route`);
    }

    // --- Fallback route: raw wikitext (Stage 6.5 behavior) ---
    const apiUrl = `${u.origin}/api.php?action=parse&page=${encodeURIComponent(title)}&format=json&prop=wikitext`;
    console.log(`[${extensionName}] MediaWiki wikitext fallback: ${apiUrl}`);

    const response = await fetch("/api/search/visit", {
        method: "POST",
        headers: ctx.getRequestHeaders(),
        cache: "no-cache",
        body: JSON.stringify({ url: apiUrl, html: false }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    console.log(`[${extensionName}] MediaWiki API response (first 300 chars):`, body.slice(0, 300));

    let data;
    try { data = JSON.parse(body); } catch {
        console.error(`[${extensionName}] MediaWiki API returned non-JSON (first 300 chars):`, body.slice(0, 300));
        throw new Error("MediaWiki API returned non-JSON (bot wall?)");
    }
    if (data?.error) throw new Error(`MediaWiki: ${data.error.info || data.error.code}`);

    const wikitext = data?.parse?.wikitext?.["*"];
    if (typeof wikitext !== "string" || !wikitext.trim()) throw new Error("No wikitext in API response");

    const pageTitle = data?.parse?.title || title;
    const text = wikitextToText(wikitext);
    console.log(`[${extensionName}] MediaWiki "${pageTitle}": ${wikitext.length} chars wikitext → ${text.length} chars text`);
    return { text, title: pageTitle, raw: text, route: "MediaWiki (wikitext)" };
}

export async function fetchPageText(url) {
    if (isMediaWikiUrl(url)) {
        const result = await fetchMediaWikiText(url);
        if (!result.text) throw new Error("No readable text found on this page.");
        return result;
    }
    const html = await fetchPageHtml(url);
    const text = extractPageText(html);
    console.log(`[${extensionName}] Extracted ${text.length} chars of text. First 300 chars:\n`, text.slice(0, 300));
    if (!text) throw new Error("No readable text found on this page.");
    return { text, title: null, raw: text, route: "HTML" };
}
