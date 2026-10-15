// Pure helpers: no imports, no side effects.

export function escapeHtml(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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