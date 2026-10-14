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

// ---------- Wizard chat (Stage 13) ----------

const WIZARD_CHAT_TOKENS = 1200;
const SOURCE_MATERIAL_CAP = 160_000; // soft cap on pasted material per call
const HISTORY_TURNS = 24;            // transcript window sent with each call

const WIZARD_CHAT_SYSTEM = `You are the Lorebook Wizard — a focused assistant inside SillyTavern that helps the user turn pasted source material into World Info lorebook entries through conversation.

Behavior:
- Ground every factual claim in the SOURCE MATERIAL provided. If something isn't in the sources, say so plainly instead of inventing it.
- The user's CANON RULES override the sources whenever they conflict.
- Be concise and concrete. No filler, no restating the question.
- This is a working session, not a roleplay chat.`;

// Newest sources first (that's storage order); oldest fall off the cap.
function buildSourceMaterial(sources) {
    let budget = SOURCE_MATERIAL_CAP;
    const parts = [];
    let omitted = 0;
    for (const s of sources) {
        if (s.text.length <= budget) {
            parts.push(`### SOURCE: ${s.title}\n${s.text}`);
            budget -= s.text.length;
        } else {
            parts.push(`### SOURCE: ${s.title}\n[omitted from this call — material cap reached]`);
            omitted++;
        }
    }
    if (omitted) console.warn(`[${extensionName}] ${omitted} source(s) over the ${SOURCE_MATERIAL_CAP} char cap were omitted from this call`);
    return parts.join("\n\n");
}

/**
 * One conversational turn. Stateless by design: canon rules + sources go in
 * the system prompt, the recent transcript + new message in the user prompt.
 * @param {{canonRules: string, sources: Array, history: Array, message: string}} args
 * @returns {Promise<string>} assistant reply (reasoning already stripped)
 */
export async function wizardChat({ canonRules, sources, history, message }) {
    const ctx = getContext();
    if (typeof ctx.generateQuietPrompt !== "function") {
        throw new Error("generateQuietPrompt not available in this ST version");
    }

    const canon = String(canonRules ?? "").trim();
    const systemPrompt = `${WIZARD_CHAT_SYSTEM}

CANON RULES (user-defined, override sources):
${canon || "(none set yet)"}

SOURCE MATERIAL:
${sources.length ? buildSourceMaterial(sources) : "(none pasted yet — answer from the conversation alone, and say clearly when you're missing sources)"}`;

    const transcript = (history || []).slice(-HISTORY_TURNS)
        .map(m => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.text}`)
        .join("\n\n");

    const quietPrompt = `${transcript ? `CONVERSATION SO FAR\n${transcript}\n\n` : ""}NEW MESSAGE\nUser: ${message}`;

    console.log(`[${extensionName}] Wizard chat call: system ${systemPrompt.length} chars, prompt ${quietPrompt.length} chars, ${sources.length} source(s)`);
    const t0 = Date.now();

    let reply = await ctx.generateQuietPrompt({
        quietPrompt,
        systemPrompt,
        responseLength: WIZARD_CHAT_TOKENS,
    });

    reply = await stripReasoning(reply);
    console.log(`[${extensionName}] Wizard replied in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${reply.length} chars`);
    return reply;
}