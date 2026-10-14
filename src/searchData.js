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
    const idx = html.indexOf('class="result');
    if (idx !== -1) {
        console.log(`[${extensionName}] First result block (for Stage 4 parser):\n`, html.slice(idx, idx + 1500));
    } else {
        console.warn(`[${extensionName}] No 'class="result' found — dumping first 2000 chars instead:\n`, html.slice(0, 2000));
    }
    return html;
}
