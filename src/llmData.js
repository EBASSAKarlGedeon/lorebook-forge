// LLM distillation: the ONLY module that talks to the AI.
// Uses the active ST connection profile via generateQuietPrompt —
// background generation, nothing written to any chat.
import { getContext } from "../../../../extensions.js";
import { extensionName } from "./config.js";

const DISTILL_RESPONSE_TOKENS = 4000; // ~6 entries x 200 words, JSON overhead

const DISTILL_SYSTEM_PROMPT = `You are a lorebook editor for SillyTavern roleplay. You convert raw source material (wiki articles, web pages) into World Info lorebook entries.

Rules:
- Extract canonical, roleplay-relevant knowledge: people, places, factions, events, concepts, relationships.
- Write content as compact factual lore for an AI to use as context. No meta commentary, no "according to the source", no addressing the reader.
- Prefer several focused entries over one giant entry. Typically 1-8 entries depending on material.
- Keys = exact trigger terms (names, aliases, titles). Keep them short.
- Ignore site navigation, ads, table-of-contents, edit links, and template noise.
- If sources conflict, prefer the more detailed/reliable one.

Output STRICT JSON only — no markdown fences, no commentary before or after. Schema:
[{"title": "Entry Title", "keys": ["key1", "key2"], "content": "Lore text..."}]`;

// Strip reasoning-model thinking blocks. Prefers ST's own utility
// (public/scripts/reasoning.js), falls back to a regex on older builds.
async function stripReasoning(text) {
    try {
        const mod = await import("../../../../reasoning.js");
        if (typeof mod.removeReasoningFromString === "function") {
            return mod.removeReasoningFromString(text);
        }
    } catch { /* older ST — regex fallback below */ }
    return String(text).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// LLMs love wrapping JSON in fences or adding chatter. Find the JSON anyway.
function extractJsonArray(text) {
    let t = String(text ?? "").trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    try { return JSON.parse(t); } catch { /* keep digging */ }
    const candidates = [t.indexOf("["), t.indexOf("{")].filter(i => i !== -1);
    if (!candidates.length) return null;
    const start = Math.min(...candidates);
    const end = Math.max(t.lastIndexOf("]"), t.lastIndexOf("}"));
    if (end <= start) return null;
    try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

/**
 * Distill source material into lorebook entry proposals.
 * @param {{title: string, url: string, raw: string, content: string}[]} sources
 * @param {string} topic Optional focus instruction from the user
 * @returns {Promise<{title: string, keys: string[], content: string}[]>}
 */
export async function distillSources({ sources, topic }) {
    const ctx = getContext();
    if (typeof ctx.generateQuietPrompt !== "function") {
        throw new Error("generateQuietPrompt not available in this ST version");
    }
    if (!Array.isArray(sources) || sources.length === 0) {
        throw new Error("No sources selected");
    }

    const material = sources.map((s, i) =>
        `### SOURCE ${i + 1}: ${s.title}${s.url ? ` (${s.url})` : ""}\n${s.raw || s.content || ""}`);
    const quietPrompt = `Research focus: ${topic || sources[0].title || "general lore"}

Source material:

${material.join("\n\n")}

Convert the source material into lorebook entries now. Strict JSON array only.`;

    console.log(`[${extensionName}] Distilling ${sources.length} source(s), ${quietPrompt.length} chars of material → LLM (${DISTILL_RESPONSE_TOKENS} token budget)`);
    const t0 = Date.now();

    let reply = await ctx.generateQuietPrompt({
        quietPrompt,
        systemPrompt: DISTILL_SYSTEM_PROMPT,
        responseLength: DISTILL_RESPONSE_TOKENS,
    });

    reply = await stripReasoning(reply);
    console.log(`[${extensionName}] LLM replied in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${reply.length} chars. First 500:\n`, reply.slice(0, 500));

    const parsed = extractJsonArray(reply);
    if (!parsed) {
        console.error(`[${extensionName}] Failed to parse JSON from LLM reply`);
        throw new Error("LLM reply was not valid JSON — check console for the raw reply");
    }

    const entries = (Array.isArray(parsed) ? parsed : [parsed])
        .map(e => ({
            title: String(e?.title || "Untitled").trim(),
            keys: Array.isArray(e?.keys) ? e.keys.map(k => String(k).trim()).filter(Boolean) : [],
            content: String(e?.content || "").trim(),
        }))
        .filter(e => e.content);

    console.log(`[${extensionName}] Parsed ${entries.length} entries:`, entries.map(e => e.title));
    if (!entries.length) throw new Error("LLM returned no usable entries");
    return entries;
}
