// LLM distillation: the ONLY module that talks to the AI.
// Uses the active ST connection profile via generateQuietPrompt —
// background generation, nothing written to any chat.
import { getContext } from "../../../../extensions.js";
import { extensionName } from "./config.js";

// Preset-free LLM call. generateRaw (verified in st-context.js; used by
// ST's own Summarize/Expressions extensions) sends ONLY our system prompt
// + prompt — no active chat preset, no jailbreak, no persona, no history.
// Falls back to generateQuietPrompt on older builds (preset may leak there).
async function callLLM({ systemPrompt, prompt, responseLength }) {
    const ctx = getContext();
    if (typeof ctx.generateRaw === "function") {
        return ctx.generateRaw({ prompt, systemPrompt, responseLength });
    }
    console.warn(`[${extensionName}] generateRaw unavailable — falling back to generateQuietPrompt (the active preset may leak into the reply)`);
    if (typeof ctx.generateQuietPrompt !== "function") {
        throw new Error("No LLM generation API available in this ST version");
    }
    return ctx.generateQuietPrompt({ quietPrompt: prompt, systemPrompt, responseLength });
}

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
    return String(text).replace(/ thinking[\s\S]*?<\/think>/gi, "").trim();
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

    let reply = await callLLM({
        prompt: quietPrompt,
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

// 4000 (was 1200): generateRaw maps responseLength straight onto the request's
// max_tokens (verified in ST source: st-context → TempResponseLength.save →
// openai.js ships it raw), and thinking models like GLM spend reasoning tokens
// out of that SAME budget before the answer starts. At 1200 the reasoning ate
// most of it and answers clipped mid-sentence. 4000 covers reasoning + a
// full entry draft in one reply.
const WIZARD_CHAT_TOKENS = 4000;
const SOURCE_MATERIAL_CAP = 160_000; // soft cap on pasted material per call
const HISTORY_TURNS = 24;            // transcript window sent with each call

const WIZARD_CHAT_SYSTEM = `You are the Lorebook Wizard — a focused assistant inside SillyTavern that helps the user turn pasted source material into World Info lorebook entries through conversation.

Behavior:
- Ground every factual claim in the SOURCE MATERIAL provided. If something isn't in the sources, say so plainly instead of inventing it.
- The user's CANON RULES override the sources whenever they conflict.
- Be concise and concrete. No filler, no restating the question.
- This is a working session, not a roleplay chat.`;

// Per-source "does it fit the cap?" decision, in storage order (newest first;
// oldest fall off the cap). Single source of truth shared by
// buildSourceMaterial (what the AI actually sees) and omittedSourceTitles
// (the UI warning chip), so the two can never disagree about which sources
// were dropped.
function capDecisions(sources) {
    let budget = SOURCE_MATERIAL_CAP;
    return sources.map(s => {
        const included = s.text.length <= budget;
        if (included) budget -= s.text.length;
        return { source: s, included };
    });
}

// Returns { material, omitted }. `omitted` is the list of source titles that
// did NOT fit the cap — surfaced by the caller as a status line / warning chip
// instead of being dropped silently.
function buildSourceMaterial(sources) {
    const parts = [];
    const omitted = [];
    for (const { source: s, included } of capDecisions(sources)) {
        if (included) {
            parts.push(`### SOURCE: ${s.title}\n${s.text}`);
        } else {
            parts.push(`### SOURCE: ${s.title}\n[omitted from this call — material cap reached]`);
            omitted.push(s.title);
        }
    }
    if (omitted.length) {
        console.warn(`[${extensionName}] ${omitted.length} source(s) over the ${SOURCE_MATERIAL_CAP} char cap were omitted from this call: ${omitted.join(", ")}`);
    }
    return { material: parts.join("\n\n"), omitted };
}

// Which active sources would NOT fit the per-call material cap right now.
// Exported for the Wizard header's "N sources omitted from AI context" chip —
// same math buildSourceMaterial uses, so the chip always matches the request.
export function omittedSourceTitles(sources) {
    return capDecisions(sources).filter(d => !d.included).map(d => d.source.title);
}

/**
 * One conversational turn. Stateless by design: canon rules + sources go in
 * the system prompt, the recent transcript + new message in the user prompt.
 * @param {{canonRules: string, sources: Array, history: Array, message: string}} args
 * @returns {Promise<{reply: string, omitted: string[]}>} assistant reply
 *          (reasoning already stripped) + titles of any sources dropped by the
 *          material cap, for the caller to surface.
 */
export async function wizardChat({ canonRules, sources, history, message }) {
    const canon = String(canonRules ?? "").trim();
    const { material, omitted } = buildSourceMaterial(sources);
    const systemPrompt = `${WIZARD_CHAT_SYSTEM}

CANON RULES (user-defined, override sources):
${canon || "(none set yet)"}

SOURCE MATERIAL:
${sources.length ? material : "(none pasted yet — answer from the conversation alone, and say clearly when you're missing sources)"}`;

    const transcript = (history || []).slice(-HISTORY_TURNS)
        .map(m => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.text}`)
        .join("\n\n");

    const quietPrompt = `${transcript ? `CONVERSATION SO FAR\n${transcript}\n\n` : ""}NEW MESSAGE\nUser: ${message}`;

    console.log(`[${extensionName}] Wizard chat call: system ${systemPrompt.length} chars, prompt ${quietPrompt.length} chars, ${sources.length} source(s)${omitted.length ? `, ${omitted.length} omitted (cap)` : ""}`);
    const t0 = Date.now();

    let reply = await callLLM({
        prompt: quietPrompt,
        systemPrompt,
        responseLength: WIZARD_CHAT_TOKENS,
    });

    reply = await stripReasoning(reply);
    console.log(`[${extensionName}] Wizard replied in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${reply.length} chars`);
    // Budget-exhaustion tell: prose clipped mid-sentence ends with no terminal
    // punctuation. Console-only signal — makes a recurrence instantly visible.
    if (reply.trim() && !/[.!?:;"”')\]}…]/.test(reply.trim().at(-1))) {
        console.warn(`[${extensionName}] Wizard reply looks cut off — the ${WIZARD_CHAT_TOKENS}-token budget may have been eaten by reasoning + answer`);
    }
    return { reply, omitted };
}

// ---------- Wizard extraction (Stage 14) ----------

const EXTRACT_RESPONSE_TOKENS = 4000;

const WIZARD_EXTRACT_SYSTEM = `You are the extraction engine of the Lorebook Wizard. You convert SOURCE MATERIAL into World Info lorebook entry proposals.

Rules:
- Propose entries only for lore actually present in the sources.
- Every entry MUST include a "quote" field: a VERBATIM passage copied character-for-character from the source material (at least 15 words) that directly supports the entry's content.
- If you cannot find a verbatim supporting passage, do NOT propose an entry for it. No quote, no entry.
- Keys = exact trigger terms (names, aliases, titles), short.
- Content = compact factual lore for an AI to use as roleplay context. No meta commentary, no addressing the reader.
- Prefer several focused entries over one giant entry. Typically 3-8 entries per extraction.
- CANON RULES override the sources on conflict.
- If the SOURCE MATERIAL contains an EXISTING LOREBOOK (current state), do NOT re-propose its entries unchanged. If other material revises, extends, or corrects one of those entries, propose it with "action": "update" and "target" set to that existing entry's exact title. Genuinely new lore gets "action": "new".
- If an EXTRACTION FOCUS is given, propose only entries within that scope.

Output STRICT JSON only — no markdown fences, no commentary before or after. Schema:
[{"action": "new", "target": null, "title": "Entry Title", "keys": ["key1"], "content": "Lore text...", "quote": "verbatim text copied from the sources"}]
("action" is "new" or "update"; "target" is the existing entry's title — required for updates, null for new entries.)`;

/**
 * Extract entry proposals from the session's sources.
 * @param {{canonRules: string, sources: Array, focus?: string}} args
 * @returns {Promise<{items: Array, omitted: string[]}>} raw proposal items +
 *          titles of any sources dropped by the material cap.
 */
export async function wizardExtract({ canonRules, sources, focus, lorebookTarget }) {
    const canon = String(canonRules ?? "").trim();
    const target = String(lorebookTarget ?? "").trim();
    const { material, omitted } = buildSourceMaterial(sources);
    const systemPrompt = `${WIZARD_EXTRACT_SYSTEM}
${target ? `\nUPDATE TARGET: the existing lorebook "${target}" is loaded among the sources. Updates you accept here will later be applied to "${target}" directly, so keep "target" titles EXACTLY as they appear in the EXISTING LOREBOOK section.\n` : ""}

CANON RULES (user-defined, override sources):
${canon || "(none set)"}

SOURCE MATERIAL:
${sources.length ? material : "(none pasted — return an empty [])"}`;

    const prompt = `${focus ? `EXTRACTION FOCUS:\n${focus}\n\n` : ""}Propose lorebook entries from the source material now. Strict JSON array only.`;

    console.log(`[${extensionName}] Extraction call: ${sources.length} source(s), focus: "${focus || "(all)"}"${target ? `, target: "${target}"` : ""}${omitted.length ? `, ${omitted.length} omitted (cap)` : ""}`);
    const t0 = Date.now();

    const reply = await callLLM({ prompt, systemPrompt, responseLength: EXTRACT_RESPONSE_TOKENS });
    const clean = await stripReasoning(reply);
    console.log(`[${extensionName}] Extraction replied in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${clean.length} chars`);

    const parsed = extractJsonArray(clean);
    if (!parsed) {
        console.error(`[${extensionName}] Extraction JSON parse failed. First 500 chars:\n`, clean.slice(0, 500));
        throw new Error("Extraction reply was not valid JSON — check console for the raw reply");
    }
    const items = (Array.isArray(parsed) ? parsed : [parsed]);
    console.log(`[${extensionName}] Parsed ${items.length} proposal(s), ${items.filter(i => i?.quote).length} with quotes`);
    return { items, omitted };
}
