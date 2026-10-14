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

    const entry = makeDefaultEntry({
        uid: newUid,
        key: draft.keys.length ? draft.keys : [draft.title],
        // Provenance lives in the comment — visible in the native editor
        comment: draft.sourceUrl
            ? `${draft.title} — LF source: ${draft.sourceUrl}`
            : draft.title,
        content: draft.content,
        displayIndex: newDisplayIndex,
    });
    data.entries[newUid] = entry;

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
