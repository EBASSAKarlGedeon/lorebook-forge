// Pure helpers: no imports, no side effects.

export function escapeHtml(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Cheap token estimate — matches the ~len/4 estimate used throughout the UI
// (entry meta, context chips) and by the wizard's history/source budgeting.
export function estimateTokens(text) {
    return Math.ceil(String(text ?? "").length / 4);
}

// ---------- Direct-URL detection (paste a URL into the search bar) ----------
function unwrapUrlInput(input) {
    let s = String(input ?? "").trim();
    let prev;
    do {
        prev = s;
        // leading wrappers
        s = s.replace(/^[<("'\u201C\u2018\s]+/, "");
        // trailing wrappers + sentence punctuation, in any order
        s = s.replace(/[>"'\u201D\u2019\s.,;:!?\]]+$/, "");
        // an UNBALANCED trailing ")" is a wrapper; a balanced one is part of the URL
        if (s.endsWith(")") && (s.match(/\)/g) || []).length > (s.match(/\(/g) || []).length) {
            s = s.slice(0, -1);
        }
    } while (s !== prev);
    return s;
}

export function parseDirectUrl(input) {
    const s = unwrapUrlInput(input);
    if (!s || /\s/.test(s)) return null;
    const hasScheme = /^https?:\/\//i.test(s);
    if (!hasScheme) {
        // No scheme: only obvious URL shapes. Bare "node.js" / "e.g." stay searches.
        const looksLikeUrl = /^www\./i.test(s) || /^[^\s/]+\.[a-z]{2,}\/\S*/i.test(s);
        if (!looksLikeUrl) return null;
    }
    try {
        const url = new URL(hasScheme ? s : `https://${s}`);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        return url.toString();
    } catch {
        return null;
    }
}

// Suggest lorebook keys from a page title: strip stop words, keep
// meaningful terms, max 4. User edits in the draft form anyway.
const STOP_WORDS = new Set([
    "the", "a", "an", "of", "and", "or", "to", "in", "for", "on", "from",
    "with", "at", "by", "is", "are", "was", "were", "how", "why", "what",
    "when", "top", "best", "guide", "wiki", "fandom",
]);

export function suggestKeys(title) {
    return String(title || "")
        .replace(/[|–—:]/g, " ")
        .split(/\s+/)
        .map(w => w.replace(/[^\p{L}\p{N}']/gu, ""))
        .filter(w => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()))
        .slice(0, 4);
}

// ---------- Wizard evidence-quote verification (Stage 14) ----------

//比对 normalization: lowercase + strip all whitespace/punctuation.
// Exact inclusion of the raw quote wins outright; normalized inclusion
// = "fuzzy" (paraphrase-level); anything else = "missing".
const QUOTE_STRIP = /[\s\p{P}]+/gu;

function normalizeForQuoteCompare(text) {
    return String(text ?? "").toLowerCase().replace(QUOTE_STRIP, "");
}

/**
 * Verify an evidence quote against pasted source texts.
 * @param {string} quote Verbatim quote claimed by the LLM
 * @param {string[]} sourceTexts Pasted source texts
 * @returns {"verified"|"fuzzy"|"missing"}
 */
export function verifyQuote(quote, sourceTexts) {
    const q = String(quote ?? "").trim();
    if (normalizeForQuoteCompare(q).length < 10) return "missing"; // too short to prove anything
    const joined = (sourceTexts || []).join("\n");
    if (joined.includes(q)) return "verified";
    const nq = normalizeForQuoteCompare(q);
    const nj = normalizeForQuoteCompare(joined);
    return nj.includes(nq) ? "fuzzy" : "missing";
}
// ---------- Inline icons (Stage 24) ----------
// Lucide paths, inlined — no icon CDN inside SillyTavern.
const ICON_PATHS = {
    hammer: '<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>',
    book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    wand: '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',
    pull: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>',
    network: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
    palette: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    compass: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z"/>',
    panelLeft: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>',
    panelLeftClose: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
    panelRight: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    sparkles: '<path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z"/>',
    reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    checks: '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    chevLeft: '<path d="m15 18-6-6 6-6"/>',
    chevRight: '<path d="m9 18 6-6-6-6"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2"/>',
    arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    compare: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>',
    compress: '<path d="m4 14 6 0 0 6"/><path d="m20 10-6 0 0-6"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
    fileText: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    checkCircle: '<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>',
    gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
};

export function icon(name, cls = "") {
    return `<svg class="lf-ic${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
}

// Keys as pills — shared by proposals and the draft deck (accent cycles in CSS)
export function keysHtml(keys) {
    return keys.length ? `<div class="lf-keys">${keys.map(k => `<span>${escapeHtml(k)}</span>`).join("")}</div>` : "";
}
