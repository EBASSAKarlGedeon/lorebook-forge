// Lorebook (World Info) data: the ONLY module that reads/writes lorebooks.
// Read path: ctx.loadWorldInfo / saveWorldInfo (verified in st-context.js).
// Server contract (verified in src/endpoints/worldinfo.js):
//   POST /api/worldinfo/list → [{ file_id, name, extensions }]
//   POST /api/worldinfo/edit { name, data } → data must contain `entries`;
//   everything else is stored as-is.
import { getContext } from "../../../../extensions.js";
import { extensionName } from "./config.js";

export async function listLorebooks() {
    const response = await fetch("/api/worldinfo/list", {
        method: "POST",
        headers: getContext().getRequestHeaders(),
        cache: "no-cache",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return Array.isArray(data) ? data : []; // [{ file_id, name, extensions }]
}

// Full default entry. Field set matches real ST lorebook files (shape we
// already handled in the landing-page project); if the native editor shows
// an odd default anywhere, we align the field name from what it displays.
function makeDefaultEntry(overrides) {
    return {
        uid: 0,
        key: [],
        keysecondary: [],
        comment: "",
        content: "",
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order: 100,
        position: 0,
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: "",
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: "",
        role: 0,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        displayIndex: 0,
        ...overrides,
    };
}

// WorldInfo fields a draft may carry in `draft.wi` (Stage 24 inspector).
// Anything else on the entry comes from makeDefaultEntry.
export const WI_FIELDS = ["keysecondary", "selectiveLogic", "order", "position", "depth", "scanDepth", "probability", "constant", "disable"];

// One draft → one full ST entry. Shared by commit and JSON export.
export function draftToEntry(draft, uid, displayIndex) {
    const wi = draft.wi || {};
    return makeDefaultEntry({
        uid,
        key: draft.keys.length ? draft.keys : [draft.title],
        // Provenance lives in the comment — visible in the native editor
        comment: draft.sourceUrl
            ? `${draft.title} — LF source: ${draft.sourceUrl}`
            : draft.title,
        content: draft.content,
        displayIndex,
        ...Object.fromEntries(WI_FIELDS.filter(f => wi[f] !== undefined).map(f => [f, wi[f]])),
    });
}

// Drafts → a standalone lorebook file, importable via ST's World Info import.
export function draftsToWorldJson(drafts) {
    return { entries: Object.fromEntries(drafts.map((d, i) => [i, draftToEntry(d, i, i)])) };
}

// Commit a draft as a NEW entry. Additive only — existing entries untouched.
// Loading a non-existent lorebook returns a dummy {entries:{}} (server
// allowDummy), so committing to a fresh name CREATES the lorebook.
export async function commitDraftToLorebook(draft, lorebookName) {
    const ctx = getContext();
    if (typeof ctx.loadWorldInfo !== "function" || typeof ctx.saveWorldInfo !== "function") {
        throw new Error("World Info API not available in this ST version");
    }

    const data = (await ctx.loadWorldInfo(lorebookName)) || { entries: {} };
    if (!data.entries || typeof data.entries !== "object") data.entries = {};

    const existing = Object.values(data.entries);
    const uids = existing.map(e => Number(e.uid)).filter(Number.isFinite);
    const newUid = uids.length ? Math.max(...uids) + 1 : 0;
    const displayIndexes = existing.map(e => Number(e.displayIndex)).filter(Number.isFinite);
    const newDisplayIndex = displayIndexes.length ? Math.max(...displayIndexes) + 1 : 0;

    data.entries[newUid] = draftToEntry(draft, newUid, newDisplayIndex);

    await ctx.saveWorldInfo(lorebookName, data);

    // Refresh ST's native lorebook dropdown so the new book shows up
    if (typeof ctx.updateWorldInfoList === "function") {
        try { await ctx.updateWorldInfoList(lorebookName); } catch (e) {
            console.warn(`[${extensionName}] updateWorldInfoList failed (non-fatal):`, e);
        }
    }

    const total = Object.keys(data.entries).length;
    console.log(`[${extensionName}] Committed "${draft.title}" → "${lorebookName}" (uid ${newUid}, ${total} entries total)`);
    return { name: lorebookName, uid: newUid, total };
}

// ---------- Updater mode (Stage 16a) ----------

// Reads a lorebook's entries. Returns the raw entries object.
export async function loadLorebookEntries(name) {
    const ctx = getContext();
    if (typeof ctx.loadWorldInfo !== "function") {
        throw new Error("World Info API not available in this ST version");
    }
    const data = await ctx.loadWorldInfo(name);
    const entries = data?.entries;
    if (!entries || typeof entries !== "object" || Object.keys(entries).length === 0) {
        throw new Error("Lorebook is empty or unreadable");
    }
    return entries;
}

// Entries → source text, in display order. Existing entries are labeled
// so the LLM knows it is looking at CURRENT STATE, not new material.
// Titles come from the memo/comment field (LF commits append provenance
// there — "Title — LF source: url" — so we strip that suffix).
export function lorebookToSourceText(name, entries) {
    const cleanTitle = entryDisplayTitle;
    const list = Object.values(entries)
        .sort((a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0));
    const parts = list.map((e, i) => {
        const keys = Array.isArray(e.key) && e.key.length ? e.key.join(", ") : "constant";
        return `## Entry ${i + 1}: "${cleanTitle(e.comment)}" (keys: ${keys})\n${String(e.content ?? "").trim()}`;
    });
    return `EXISTING LOREBOOK: "${name}" — the entries below ALREADY EXIST in the user's lorebook. ` +
        `They are current state, not new material. When other sources extend or contradict them, ` +
        `propose an UPDATE targeting that entry's title rather than a duplicate.\n\n${parts.join("\n\n")}`;
}

// ---------- Stage 16b: apply update proposals in place ----------

// Display title of an entry = its comment with LF provenance suffixes stripped.
// Handles both "Title — LF source: url" (Stage 7 commits) and
// "Title — LF update YYYY-MM-DD" (Stage 16b updates).
export function entryDisplayTitle(comment) {
    return String(comment || "")
        .split(/\s+[—–-]\s+LF (source|update)[\s\S]*$/)[0].trim() || "(untitled)";
}

// Find the entry titled `entryTitle` in `lorebookName` and replace its
// content/keys in place. Everything else (uid, order, position, flags,
// displayIndex) is preserved. Fails loudly with the available titles on
// no-match, and refuses ambiguous matches.
export async function applyUpdateToLorebook(lorebookName, entryTitle, { content, keys }) {
    const ctx = getContext();
    if (typeof ctx.loadWorldInfo !== "function" || typeof ctx.saveWorldInfo !== "function") {
        throw new Error("World Info API not available in this ST version");
    }
    const title = String(entryTitle ?? "").trim();
    if (!title) throw new Error("Proposal has no target title");

    const data = (await ctx.loadWorldInfo(lorebookName)) || { entries: {} };
    if (!data.entries || typeof data.entries !== "object") data.entries = {};

    const matches = Object.values(data.entries)
        .filter(e => entryDisplayTitle(e.comment).toLowerCase() === title.toLowerCase());

    if (matches.length === 0) {
        const available = Object.values(data.entries)
            .map(e => entryDisplayTitle(e.comment)).slice(0, 12).join(" | ");
        throw new Error(`No entry titled "${title}" in "${lorebookName}". Available: ${available}`);
    }
    if (matches.length > 1) {
        throw new Error(`"${lorebookName}" has ${matches.length} entries titled "${title}" — rename the duplicates in the World Info editor first`);
    }

    const entry = matches[0];
    if (Array.isArray(keys) && keys.length) {
        entry.key = keys.map(k => String(k).trim()).filter(Boolean);
    }
    entry.content = String(content ?? entry.content);
    entry.comment = `${title} — LF update ${new Date().toISOString().slice(0, 10)}`;

    await ctx.saveWorldInfo(lorebookName, data);
    if (typeof ctx.updateWorldInfoList === "function") {
        try { await ctx.updateWorldInfoList(lorebookName); } catch (e) {
            console.warn(`[${extensionName}] updateWorldInfoList failed (non-fatal):`, e);
        }
    }
    console.log(`[${extensionName}] Update applied: "${title}" in "${lorebookName}" (uid ${entry.uid})`);
    return { lorebook: lorebookName, uid: entry.uid, title };
}