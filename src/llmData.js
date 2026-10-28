// Uses the active ST connection profile via generateQuietPrompt —
// background generation, nothing written to any chat.
import { getContext } from "../../../../extensions.js";
import { extensionName, defaultSettings } from "./config.js";
import { estimateTokens } from "./helpers.js";

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

// ---------- Wizard chat (Stage 13) ----------

// 32000 (was 4000): generateRaw maps responseLength straight onto the request's
// max_tokens (verified in ST source: st-context → TempResponseLength.save →
// openai.js ships it raw), and thinking models like GLM spend reasoning tokens
// out of that SAME budget before the answer starts. At 1200 the reasoning ate
// most of it and answers clipped mid-sentence. 4000 covers reasoning + a
// full entry draft in one reply.
const WIZARD_CHAT_TOKENS = 32000;
const SOURCE_MATERIAL_CAP = 160_000; // soft cap on pasted material per call

const WIZARD_CHAT_SYSTEM = `You are the Lorebook Wizard — a focused assistant inside SillyTavern that helps the user turn pasted source material into World Info lorebook entries through conversation.

Behavior:
- Ground every factual claim in the SOURCE MATERIAL provided. If something isn't in the sources, say so plainly instead of inventing it.
- The user's CANON RULES override the sources whenever they conflict.
- Be concise and concrete. No filler, no restating the question.
- When you draft or revise a lorebook entry, always present the complete entry in this shape: \`ENTRY: <title>\` / \`KEYS: a, b, c\` / \`CONTENT:\` followed by the text. Never show partial diffs. Do not declare an entry final; the user decides.
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

// One transcript line, the unit the chat budget is measured in.
function formatTurn(m) {
    return `${m.role === "assistant" ? "Assistant" : "User"}: ${m.text}`;
}

/**
 * The part of the chat history that fits the token budget. Walks newest →
 * oldest and keeps messages while they fit; the newest message is always kept.
 * Stored messages are never truncated — raising the budget later brings the
 * older ones back. Used by the calls below and by the chat view (divider).
 * @param {Array} messages stored chat messages, chronological
 * @param {number} budgetTokens
 * @returns {{messages: Array, firstIndex: number}} kept messages in order, and
 *          the index in `messages` of the first kept one.
 */
export function selectHistory(messages, budgetTokens) {
    const list = Array.isArray(messages) ? messages : [];
    let used = 0;
    let first = list.length;
    for (let i = list.length - 1; i >= 0; i--) {
        const cost = estimateTokens(formatTurn(list[i]));
        if (first < list.length && used + cost > budgetTokens) break;
        used += cost;
        first = i;
    }
    return { messages: list.slice(first), firstIndex: first };
}

/**
 * One conversational turn. Stateless by design: canon rules + sources go in
 * the system prompt, the recent transcript + new message in the user prompt.
 * @param {{canonRules: string, sources: Array, history: Array, message: string, contextTokens?: number}} args
 * @returns {Promise<{reply: string, omitted: string[]}>} assistant reply
 *          (reasoning already stripped) + titles of any sources dropped by the
 *          material cap, for the caller to surface.
 */
export async function wizardChat({ canonRules, sources, history, message, contextTokens = defaultSettings.chatContextTokens }) {
    const canon = String(canonRules ?? "").trim();
    const { material, omitted } = buildSourceMaterial(sources);
    const systemPrompt = `${WIZARD_CHAT_SYSTEM}

CANON RULES (user-defined, override sources):
${canon || "(none set yet)"}

SOURCE MATERIAL:
${sources.length ? material : "(none pasted yet — answer from the conversation alone, and say clearly when you're missing sources)"}`;

    // The new message is part of this call, so it comes out of the budget first.
    const budget = contextTokens - estimateTokens(message);
    const { messages: kept } = selectHistory(history, budget);
    const transcript = kept.map(formatTurn).join("\n\n");

    const quietPrompt = `${transcript ? `CONVERSATION SO FAR\n${transcript}\n\n` : ""}NEW MESSAGE\nUser: ${message}`;

    console.log(`[${extensionName}] Wizard chat call: system ${systemPrompt.length} chars, prompt ${quietPrompt.length} chars, ${kept.length}/${(history || []).length} turn(s) in context, ${sources.length} source(s)${omitted.length ? `, ${omitted.length} omitted (cap)` : ""}`);
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

// ---------- Wizard extraction (Stage 14, chat-only since 6) ----------

const EXTRACT_RESPONSE_TOKENS = 64000;

// Entries come ONLY from what the user agreed to in the chat. Sources are not
// sent (they were already in the chat); the existing lorebook is, because
// updates must name its entries.
const WIZARD_EXTRACT_SYSTEM = `You are the extraction engine of the Lorebook Wizard. You turn the AGREED part of a wizard chat into World Info lorebook entries.

Rules:
- Output an entry only when the user agreed to it in the chat. Agreement is an explicit approval ("ok", "add it", "use that", "good", "perfect"), or an EXTRACTION FOCUS line that names the entry.
- Use the LATEST version of each entry in the chat, including edits the user requested.
- Copy title, keys and content VERBATIM from the chat. Do not add facts, reword, merge or split.
- Never create entries from the sources alone. Skip entries still under discussion, and entries the user rejected.
- "quote" is a verbatim passage of at least 8 words, copied from the chat message that holds the final version.
- "action": "update" with "target" is allowed only when the chat decided to modify an entry from the EXISTING LOREBOOK. Otherwise use "action": "new" and "target": null.
- If nothing is agreed, return [].
- Output STRICT JSON only — no markdown fences, no commentary before or after. Schema:
[{"action": "new", "target": null, "title": "Entry Title", "keys": ["key1"], "content": "Lore text...", "quote": "verbatim text copied from the chat"}]`;

/**
 * Propose entries from the agreed part of the chat.
 * @param {{canonRules: string, history: Array, sources: Array, focus?: string, lorebookTarget?: string, contextTokens?: number}} args
 * @returns {Promise<{items: Array, omitted: string[]}>} raw proposal items +
 *          titles of any existing-lorebook sources dropped by the material cap.
 */
export async function wizardExtract({ canonRules, history, sources, focus, lorebookTarget, contextTokens = defaultSettings.chatContextTokens }) {
    const canon = String(canonRules ?? "").trim();
    const target = String(lorebookTarget ?? "").trim();
    const existing = (sources || []).filter(s => s.title.startsWith("Lorebook: "));
    const { material, omitted } = buildSourceMaterial(existing);

    const { messages: kept, firstIndex } = selectHistory(history, contextTokens);
    // Numbered by position in the whole chat, so the numbers match what the user sees.
    const transcript = kept
        .map((m, k) => `[#${firstIndex + k + 1} ${m.role === "assistant" ? "Wizard" : "User"}]\n${m.text}`)
        .join("\n\n");
    if (!transcript) return { items: [], omitted };

    const systemPrompt = `${WIZARD_EXTRACT_SYSTEM}
${target ? `\nUPDATE TARGET: the existing lorebook "${target}" is loaded as EXISTING LOREBOOK. Keep "target" titles EXACTLY as they appear there.\n` : ""}
CANON RULES (user-defined, override the chat on conflict):
${canon || "(none set)"}

EXISTING LOREBOOK (current state — used only to resolve updates):
${existing.length ? material : "(none loaded — every entry is \"new\")"}`;

    const prompt = `${focus ? `EXTRACTION FOCUS:\n${focus}\n\n` : ""}CHAT\n${transcript}\n\nPropose the agreed entries now. Strict JSON array only.`;

    console.log(`[${extensionName}] Extraction call: ${kept.length}/${(history || []).length} chat turn(s), focus: "${focus || "(all)"}"${target ? `, target: "${target}"` : ""}${omitted.length ? `, ${omitted.length} omitted (cap)` : ""}`);
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
