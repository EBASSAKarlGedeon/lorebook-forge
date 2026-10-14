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