// Search data: the ONLY module that talks to search endpoints.
// Stage 3: connection test. Stage 4 adds the real search function.
import { getContext } from "../../../../extensions.js";
import { extensionName } from "./config.js";

// baseUrl is passed in by the caller (settings.js) — avoids a circular import.
export async function testSearxngConnection(baseUrl) {
    console.log(`[${extensionName}] Testing SearXNG at ${baseUrl}...`);
    const response = await fetch("/api/search/searxng", {
        method: "POST",
        headers: getContext().getRequestHeaders(),
        cache: "no-cache",
        body: JSON.stringify({ baseUrl, query: "connectivity test" }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.error(`[${extensionName}] SearXNG test failed: HTTP ${response.status}`, text.slice(0, 500));
        throw new Error(`HTTP ${response.status}`);
    }
    const html = await response.text();
    console.log(`[${extensionName}] SearXNG responded: ${html.length} chars of HTML`);

    // Dump the FIRST RESULT BLOCK so we can design the parser against real markup
        // Dump the FIRST RESULT BLOCK so we can design the parser against real markup
        // Dump the FIRST RESULT BLOCK so we can design the parser against real markup.
    // SearXNG wraps each result in an <article> — count them and show one.
    const articleCount = (html.match(/<article/g) || []).length;
    console.log(`[${extensionName}] <article> elements found: ${articleCount}`);
    const idx = html.indexOf("<article");
    if (idx !== -1) {
        console.log(`[${extensionName}] First result block (for Stage 4 parser):\n`, html.slice(idx, idx + 2500));
    } else {
        console.warn(`[${extensionName}] No <article> found — dumping first 2500 chars instead:\n`, html.slice(0, 2500));
    }
    return html;
}
