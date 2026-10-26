// The Lorebook Deck (right rail): Rulebook-style source cards with their
// staged entries NESTED inside, batch commit, export JSON.
// Stage 25 (v1/v2 convergence): sources, canon rules and lorebook import
// moved here from the Wizard tab (scraping stages SOURCES now, and Wizard
// proposals stage into them via saveDraft's sourceId + pickSource).
// Storage lives in extension_settings — survives refresh.
import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "./config.js";
import { escapeHtml, icon, keysHtml } from "./helpers.js";
import { getWizardSession, setCanonRules, setLorebookTarget,
         addSource, deleteSource, toggleSourceActive, getActiveSessionId } from "./wizardData.js";
import { listLorebooks, loadLorebookEntries, lorebookToSourceText,
         commitDraftToLorebook, draftToEntry, draftsToWorldJson } from "./wiData.js";

// Ticked draft ids — kept across re-renders (cleared on delete and on session change)
const selected = new Set();

// The `selected` Set is module-global, so a session switch must clear it —
// otherwise ids from the previous session leak into the new one's batch bar.
export function clearSelection() {
    selected.clear();
}

// One-time migration: entries staged before they were session-scoped have
// no sessionId. Attribute each to the session that owns its source (matched
// by sourceId), otherwise to the first session.
let migratedDraftSessions = false;
function migrateDraftSessions(drafts) {
    getActiveSessionId(); // ensureSessions() — legacy installs get their session created first
    const s = extension_settings[extensionName];
    const sessions = Array.isArray(s.wizardSessions) ? s.wizardSessions : [];
    if (!sessions.length) return;
    const firstId = sessions[0].id;
    let changed = false;
    for (const d of drafts) {
        if (d.sessionId) continue;
        const owner = d.sourceId
            ? sessions.find(sess => Array.isArray(sess.wizard?.sources) &&
                  sess.wizard.sources.some(src => src.id === d.sourceId))
            : null;
        d.sessionId = owner ? owner.id : firstId;
        changed = true;
    }
    if (changed) {
        saveSettingsDebounced();
        console.log(`[${extensionName}] Migrated draft sessions (${drafts.length} drafts)`);
    }
}

export function getDrafts() {
    const s = extension_settings[extensionName];
    if (!Array.isArray(s.drafts)) s.drafts = [];
    if (!migratedDraftSessions) {
        migratedDraftSessions = true;
        migrateDraftSessions(s.drafts);
    }
    return s.drafts;
}

// Entries belonging to the ACTIVE wizard session — what the deck shows.
export function getSessionDrafts() {
    const id = getActiveSessionId();
    return getDrafts().filter(d => d.sessionId === id);
}

export function saveDraft({ title, keys, content, sourceId, sourceUrl, sourceTitle, sourceRaw, origin }){
    const drafts = getDrafts();
    const draft = {
        id: crypto.randomUUID(),
        sessionId: getActiveSessionId(),
        title: String(title || "Untitled").trim(),
        keys: Array.isArray(keys) ? keys.map(k => String(k).trim()).filter(Boolean) : [],
        content: String(content || "").trim(),
        sourceId: String(sourceId || ""), // deck source this entry nests in
        sourceUrl: String(sourceUrl || ""),
        sourceTitle: String(sourceTitle || ""),
        sourceRaw: String(sourceRaw || ""),
        origin: origin === "ai" ? "ai" : "research",
        createdAt: Date.now(),
    };
    drafts.unshift(draft);
    saveSettingsDebounced();
    console.log(`[${extensionName}] Draft saved: "${draft.title}" (${drafts.length} total)`);
    return draft;
}

export function deleteDraft(id) {
    const drafts = getDrafts();
    const i = drafts.findIndex(d => d.id === id);
    if (i !== -1) {
        console.log(`[${extensionName}] Draft deleted: "${drafts[i].title}"`);
        drafts.splice(i, 1);
        selected.delete(id);
        saveSettingsDebounced();
    }
}

// Stage 15: in-place edit. Only touches the fields given.
// Stage 24: `wi` merges WorldInfo overrides (see WI_FIELDS in wiData.js).
export function updateDraft(id, { title, keys, content, wi }) {
    const drafts = getDrafts();
    const d = drafts.find(x => x.id === id);
    if (!d) return null;
    if (title !== undefined) d.title = String(title || d.title).trim();
    if (keys !== undefined) d.keys = keys.map(k => String(k).trim()).filter(Boolean);
    if (content !== undefined) d.content = String(content ?? d.content);
    if (wi !== undefined) d.wi = { ...d.wi, ...wi };
    saveSettingsDebounced();
    console.log(`[${extensionName}] Draft updated: "${d.title}"`);
    return d;
}

const splitKeys = (str) => String(str).split(",").map(k => k.trim()).filter(Boolean);

// ---------- WorldInfo vocab (values = ST's numeric enums) ----------

const POSITIONS = [
    [0, "↑Char", "Before character defs"],
    [1, "↓Char", "After character defs"],
    [2, "↑AN", "Before author's note"],
    [3, "↓AN", "After author's note"],
    [4, "@D", "At chat depth"],
    [5, "↑EM", "Before example messages"],
    [6, "↓EM", "After example messages"],
];
const LOGICS = [[0, "AND ANY"], [3, "AND ALL"], [2, "NOT ANY"], [1, "NOT ALL"]];

// Draft's effective WI values (draft overrides on top of entry defaults)
function wiOf(d) {
    const e = draftToEntry(d, 0, 0);
    return { order: e.order, position: e.position, depth: e.depth, selectiveLogic: e.selectiveLogic, keysecondary: e.keysecondary,
             scanDepth: e.scanDepth, probability: e.probability, constant: e.constant, disable: e.disable };
}

// ---------- Commit UI ----------

// Closes every open per-card commit form (except one, optional)
function hideAllDraftForms(exceptId) {
    $("#lf_drafts_list .lf-commit-form").each(function () {
        if (!exceptId || $(this).data("id") !== exceptId) {
            $(this).stop(true, true).slideUp(100).html("");
        }
    });
}

// Lorebook picker + Commit, mounted into `form`. Commits `drafts` one by
// one (each commit is a load+save of the book, so sequential on purpose).
async function mountCommitForm(form, drafts) {
    form.html(`<div class="lf-search-status">Loading lorebooks…</div>`).slideDown(100);

    let books = [];
    try {
        books = await listLorebooks();
    } catch (err) {
        console.error(`[${extensionName}] Lorebook list failed:`, err);
        form.html(`<div class="lf-search-status">Failed to list lorebooks: ${escapeHtml(err.message)}</div>`);
        return;
    }

    const label = drafts.length === 1 ? "Commit" : `Commit ${drafts.length}`;
    form.html(`
        <select class="text_pole lf-commit-target">
            ${books.map(b => `<option value="${escapeHtml(b.file_id)}">${escapeHtml(b.name)}</option>`).join("")}
            <option value="__new__">➕ New lorebook…</option>
        </select>
        <input class="text_pole lf-text-input lf-commit-newname" type="text"
               placeholder="New lorebook name" style="display:none;" />
        <div class="lf-draft-form-actions">
            <button class="menu_button lf-commit-cancel" type="button">Cancel</button>
            <button class="menu_button lf-btn-good lf-commit-go" type="button">${label}</button>
        </div>
    `);

    const target = form.find(".lf-commit-target");
    const newName = form.find(".lf-commit-newname");
    target.on("change", () => {
        newName.toggle(target.val() === "__new__");
        if (target.val() === "__new__") newName.focus();
    });

    form.find(".lf-commit-cancel").on("click", () => form.slideUp(100).html(""));
    form.find(".lf-commit-go").on("click", async function () {
        const btn = $(this).prop("disabled", true).text("Committing…");
        const bookName = target.val() === "__new__"
            ? String(newName.val()).trim()
            : target.val();
        if (!bookName) {
            toastr.warning("Enter a lorebook name.", "Lorebook Forge");
            btn.prop("disabled", false).text(label);
            return;
        }
        let done = 0;
        let result = null;
        for (const draft of drafts) {
            try {
                result = await commitDraftToLorebook(draft, bookName);
                draft.committedTo = result.name;
                done++;
            } catch (err) {
                console.error(`[${extensionName}] Commit failed:`, err);
                toastr.error(`Commit of "${draft.title}" failed: ${err.message}`, "Lorebook Forge");
            }
        }
        saveSettingsDebounced();
        if (done) {
            toastr.success(`${done === 1 ? `"${drafts[0].title}"` : `${done} drafts`} committed to "${result.name}" (${result.total} entries). Verify in the World Info editor.`, "Lorebook Forge");
            form.slideUp(100).html("");
            renderDraftsList();
        } else {
            btn.prop("disabled", false).text(label);
        }
    });
}

// ---------- Inspector modal ----------

function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function readInspector(m) {
    const scan = String(m.find(".lf-in-scan").val()).trim();
    return {
        title: String(m.find(".lf-in-title").val()),
        keys: splitKeys(m.find(".lf-in-keys").val()),
        content: String(m.find(".lf-in-content").val()),
        wi: {
            keysecondary: splitKeys(m.find(".lf-in-keys2").val()),
            selectiveLogic: Number(m.find(".lf-in-logic").val()),
            position: Number(m.find(".lf-in-position").val()),
            depth: clampInt(m.find(".lf-in-depth").val(), 0, 1000, 4),
            order: clampInt(m.find(".lf-in-order").val(), 0, 100000, 100),
            scanDepth: scan === "" ? null : clampInt(scan, 0, 1000, null), // blank = global setting
            probability: clampInt(m.find(".lf-in-prob").val(), 0, 100, 100),
            constant: m.find(".lf-in-constant").prop("checked"),
            disable: m.find(".lf-in-disable").prop("checked"),
        },
    };
}

function openInspector(draftId) {
    const draft = getDrafts().find(d => d.id === draftId);
    const root = $("#lf_studio_root");
    if (!draft || !root.length) return;
    const wi = wiOf(draft);

    const modal = $(`
        <div class="lf-modal-backdrop">
            <div class="lf-modal" role="dialog" aria-modal="true" aria-labelledby="lf_modal_title">
                <div class="lf-modal-head">
                    <span class="lf-tile">${icon("pencil")}</span>
                    <div>
                        <h3 id="lf_modal_title">Inspect WorldInfo entry</h3>
                        <div class="lf-modal-sub">${escapeHtml(draft.sourceTitle || draft.sourceUrl || "Draft")}</div>
                    </div>
                    <button class="lf-icon-btn lf-modal-close" type="button" title="Close (Esc)">${icon("x")}</button>
                </div>
                <div class="lf-modal-body">
                    <div class="lf-modal-main">
                        <label class="lf-field"><span>Entry title <i>(comment)</i></span>
                            <input class="text_pole lf-in-title" value="${escapeHtml(draft.title)}" /></label>
                        <label class="lf-field"><span>Primary keys <i>comma-separated</i></span>
                            <input class="text_pole lf-in-keys lf-mono" value="${escapeHtml(draft.keys.join(", "))}" /></label>
                        <div class="lf-in-keys-preview"></div>
                        <label class="lf-field"><span>Secondary keys <i>optional filter, combined by the logic below</i></span>
                            <input class="text_pole lf-in-keys2 lf-mono" value="${escapeHtml(wi.keysecondary.join(", "))}" /></label>
                        <label class="lf-field lf-field-grow"><span>Content <i class="lf-in-tokens"></i></span>
                            <textarea class="text_pole lf-in-content lf-mono" rows="10">${escapeHtml(draft.content)}</textarea></label>
                    </div>
                    <div class="lf-modal-side">
                        <div class="lf-side-label">Activation</div>
                        <label class="lf-field"><span>Selective logic</span>
                            <select class="text_pole lf-in-logic">${LOGICS.map(([v, l]) => `<option value="${v}"${v === wi.selectiveLogic ? " selected" : ""}>${l}</option>`).join("")}</select></label>
                        <label class="lf-field"><span>Scan depth <i>blank = global</i></span>
                            <input class="text_pole lf-in-scan lf-mono" type="number" min="0" value="${wi.scanDepth ?? ""}" /></label>
                        <label class="lf-field"><span>Probability %</span>
                            <input class="text_pole lf-in-prob lf-mono" type="number" min="0" max="100" value="${wi.probability}" /></label>
                        <label class="lf-check"><input type="checkbox" class="lf-in-constant"${wi.constant ? " checked" : ""} /> Constant <i>(always on)</i></label>
                        <label class="lf-check"><input type="checkbox" class="lf-in-disable"${wi.disable ? " checked" : ""} /> Disabled</label>
                        <div class="lf-side-label">Insertion</div>
                        <label class="lf-field"><span>Position</span>
                            <select class="text_pole lf-in-position">${POSITIONS.map(([v, s, l]) => `<option value="${v}"${v === wi.position ? " selected" : ""}>${s} — ${l}</option>`).join("")}</select></label>
                        <div class="lf-field-pair">
                            <label class="lf-field"><span>Order</span>
                                <input class="text_pole lf-in-order lf-mono" type="number" min="0" value="${wi.order}" /></label>
                            <label class="lf-field"><span>Depth</span>
                                <input class="text_pole lf-in-depth lf-mono" type="number" min="0" value="${wi.depth}" /></label>
                        </div>
                        <details class="lf-json-preview">
                            <summary>SillyTavern JSON</summary>
                            <pre></pre>
                        </details>
                    </div>
                </div>
                <div class="lf-modal-foot">
                    <button class="menu_button lf-modal-cancel" type="button">Cancel</button>
                    <button class="menu_button lf-btn-primary lf-modal-save" type="button">${icon("check")}Save changes</button>
                </div>
            </div>
        </div>
    `).appendTo(root);

    // Live feedback: key pills, token estimate, depth only matters for @D, JSON preview
    const refresh = () => {
        const v = readInspector(modal);
        modal.find(".lf-in-keys-preview").html(keysHtml(v.keys));
        modal.find(".lf-in-tokens").text(`${v.content.length.toLocaleString()} chars · ~${Math.ceil(v.content.length / 4).toLocaleString()} tok`);
        modal.find(".lf-in-depth").prop("disabled", v.wi.position !== 4);
        modal.find(".lf-json-preview pre").text(JSON.stringify(draftToEntry({ ...draft, ...v, wi: v.wi }, 0, 0), null, 2));
    };
    modal.on("input change", refresh);
    refresh();

    const close = () => modal.remove();
    modal.on("mousedown", (e) => { if (e.target === modal[0]) close(); });
    modal.find(".lf-modal-close, .lf-modal-cancel").on("click", close);
    modal.find(".lf-modal-save").on("click", () => {
        const v = readInspector(modal);
        if (!v.content.trim()) {
            toastr.warning("Draft content is empty.", "Lorebook Forge");
            return;
        }
        updateDraft(draftId, v);
        close();
        renderDraftsList();
        toastr.success(`Draft updated: "${v.title.trim() || draft.title}"`, "Lorebook Forge");
    });
    modal.find(".lf-in-title").trigger("focus");
}

// ---------- Source cards (v1-style) ----------

function sourceIcon(s) {
    if (s.title.startsWith("Lorebook: ")) return icon("book", "lf-ic-accent3");
    if (s.title.startsWith("Draft: ")) return icon("pencil", "lf-ic-accent");
    return icon("globe", "lf-ic-accent2");
}

function sourceCardHtml(s, drafts) {
    const nested = drafts.filter(d => d.sourceId === s.id);
    const preview = String(s.text).replace(/\s+/g, " ").trim().slice(0, 400);
    const kb = (s.text.length / 1024).toFixed(1);
    return `
        <div class="lf-source" data-id="${escapeHtml(s.id)}">
            <div class="lf-source-head">
                <input type="checkbox" class="lf-source-check" title="Include this source in AI context (extraction + chat)"${s.active !== false ? " checked" : ""} />
                ${sourceIcon(s)}
                <div class="lf-source-title" title="Click to expand/collapse the source preview">${escapeHtml(s.title)}</div>
                <span class="lf-chip${nested.length ? "" : " lf-chip-dim"}" title="Entries staged against this source">${nested.length || ""}</span>
                <button class="lf-icon-btn lf-source-delete" type="button" title="Remove source">${icon("x")}</button>
            </div>
            <div class="lf-source-preview">${escapeHtml(preview)}…</div>
            <div class="lf-source-foot">
                <span>${kb} KB · ~${Math.ceil(s.text.length / 4).toLocaleString()} tok</span>
                <span class="lf-source-state${s.active !== false ? "" : " off"}">${s.active !== false ? "In context" : "Excluded"}</span>
            </div>
            ${nested.length ? `
            <div class="lf-source-entries">
                ${nested.map(draftCardHtml).join("")}
            </div>` : ""}
        </div>
    `;
}

function draftCardHtml(d) {
    const wi = wiOf(d);
    const pos = POSITIONS.find(p => p[0] === wi.position)?.[1] ?? "?";
    return `
    <div class="lf-draft${selected.has(d.id) ? " selected" : ""}${d.committedTo ? " committed" : ""}" data-id="${escapeHtml(d.id)}">
        <div class="lf-draft-head">
            <input type="checkbox" class="lf-draft-check" title="Select for distill, batch commit or export"${selected.has(d.id) ? " checked" : ""} />
            <div class="lf-draft-title">${escapeHtml(d.title)}</div>
            ${d.origin === "ai" ? `<span class="lf-ai-badge">${icon("sparkles", "lf-ic-sm")}AI</span>` : ""}
        </div>
        ${keysHtml(d.keys)}
        <div class="lf-draft-preview">${escapeHtml(d.content)}</div>
        <div class="lf-entry-meta">
            <span title="Insertion order">#${wi.order}</span>
            <span title="Position">${pos}${wi.position === 4 ? ` d${wi.depth}` : ""}</span>
            ${wi.probability < 100 ? `<span>${wi.probability}%</span>` : ""}
            ${wi.constant ? `<span class="lf-meta-on">constant</span>` : ""}
            ${wi.disable ? `<span class="lf-meta-off">disabled</span>` : ""}
            ${d.committedTo ? `<span class="lf-meta-good" title="Committed">✓ ${escapeHtml(d.committedTo)}</span>` : ""}
        </div>
        <div class="lf-draft-actions">
            <button class="menu_button lf-btn-good lf-draft-commit" type="button" title="Commit to a lorebook">Commit</button>
            <button class="menu_button lf-draft-edit" type="button" title="Inspect &amp; edit WorldInfo fields">Edit</button>
            <button class="menu_button lf-draft-wizard" type="button" title="Load this draft into the Wizard">${icon("wand", "lf-ic-sm")}Wizard</button>
            <button class="menu_button lf-btn-bad lf-draft-delete" type="button" title="Delete draft">${icon("trash", "lf-ic-sm")}Delete</button>
        </div>
        <div class="lf-commit-form" data-id="${escapeHtml(d.id)}" style="display:none;"></div>
    </div>`;
}

// Loose entries (no live source) — Wizard extractions without attribution,
// or entries whose source was deleted: they keep their content and commit fine.
function looseSectionHtml(drafts) {
    return `
        <div class="lf-source lf-source-loose">
            <div class="lf-source-head">
                ${icon("sparkles", "lf-ic-accent")}
                <div class="lf-source-title">Loose entries</div>
                <span class="lf-chip" title="Entries not tied to a staged source">${drafts.length || ""}</span>
            </div>
            <div class="lf-source-preview">Staged without a live source — Wizard extractions with unattributed evidence, or entries whose source was removed.</div>
            <div class="lf-source-entries">
                ${drafts.map(draftCardHtml).join("")}
            </div>
        </div>
    `;
}

// ---------- Deck ----------

function updateBatchBar() {
    const drafts = getSessionDrafts();
    const n = drafts.filter(d => selected.has(d.id)).length;
    $("#lf_drafts_selected").text(n ? `${n} selected` : "");
    $("#lf_drafts_all").prop("checked", n > 0 && n === drafts.length).prop("indeterminate", n > 0 && n < drafts.length);
    $("#lf_batch_commit").prop("disabled", !n);
}

// Header lorebook pill mirrors the wizard session's update target
function renderBookPill() {
    const target = getWizardSession().lorebookTarget;
    $("#lf_book_pill_name").text(target || "none");
    $("#lf_book_pill").toggleClass("is-set", !!target);
}

export function exportJson() {
    const drafts = getSessionDrafts();
    const chosen = drafts.filter(d => selected.has(d.id));
    const list = chosen.length ? chosen : drafts;
    if (!list.length) {
        toastr.warning("No drafts to export yet.", "Lorebook Forge");
        return;
    }
    const blob = new Blob([JSON.stringify(draftsToWorldJson(list), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `lorebook-forge-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toastr.success(`Exported ${list.length} entr${list.length === 1 ? "y" : "ies"} — import via World Info → Import.`, "Lorebook Forge");
}

// Static deck chrome (toolbar forms, batch bar, export) — wired once per Studio open
export function initDraftsDeck() {
    // ---- Toolbar: three slide-open forms (content kept across toggles) ----
    const toggleForm = (btnSel, formSel, focusSel) => {
        $(btnSel).on("click", () => {
            const form = $(formSel);
            const shown = form.is(":visible");
            $("#lf_deck_addsource, #lf_deck_import, #lf_deck_canon").not(form).slideUp(120);
            form.stop(true, true).slideToggle(120, () => {
                if (!shown) form.find(focusSel).first().trigger("focus");
            });
        });
    };
    toggleForm(".lf-deck-addsource", "#lf_deck_addsource", ".lf-deck-src-title");
    toggleForm(".lf-deck-import", "#lf_deck_import", ".lf-deck-lb-select");
    toggleForm(".lf-deck-canon", "#lf_deck_canon", ".lf-deck-canon-rules");

    // ---- Add source (paste) ----
    $("#lf_deck_addsource").html(`
        <label class="lf-settings-label">Source title</label>
        <input class="text_pole lf-text-input lf-deck-src-title" type="text"
               placeholder="Source title (e.g. 'Eldoria wiki — Geography section')" />
        <label class="lf-settings-label">Text</label>
        <textarea class="text_pole lf-deck-src-text" rows="6" placeholder="Paste the source text here…"></textarea>
        <div class="lf-draft-form-actions">
            <button class="menu_button lf-btn-primary lf-deck-src-add" type="button">${icon("plus", "lf-ic-sm")}Stage source</button>
        </div>
    `);
    $("#lf_deck_addsource .lf-deck-src-add").on("click", () => {
        const wrap = $("#lf_deck_addsource");
        const title = String(wrap.find(".lf-deck-src-title").val()).trim();
        const text = String(wrap.find(".lf-deck-src-text").val());
        if (!text.trim()) {
            toastr.warning("Paste some source text first.", "Lorebook Forge");
            return;
        }
        const src = addSource({ title, text });
        console.log(`[${extensionName}] Deck source added: "${src.title}" (${src.text.length} chars)`);
        toastr.success(`Source staged: "${src.title}"`, "Lorebook Forge");
        // Form content persists (toggle re-opens it) — just reset the fields
        wrap.slideUp(120).find(".lf-deck-src-title, .lf-deck-src-text").val("");
        renderDraftsList();
    });

    // ---- Canon rules ----
    $("#lf_deck_canon").html(`
        <label class="lf-settings-label">Canon rules <span class="lf-dim">— sent with every AI call</span></label>
        <textarea class="text_pole lf-deck-canon-rules" rows="3"
            placeholder="e.g. Manga canon only. Ignore anime-original arcs, filler and movies. If sources conflict, the manga wins."></textarea>
    `);
    $("#lf_deck_canon .lf-deck-canon-rules").on("input", function () {
        setCanonRules($(this).val());
    });
    // ---- Import lorebook: entries become one source + the update target ----
    $("#lf_deck_import").html(`
        <label class="lf-settings-label">Lorebook</label>
        <select class="text_pole lf-deck-lb-select"><option value="">Loading lorebooks…</option></select>
        <div class="lf-draft-form-actions">
            <button class="menu_button lf-deck-lb-import" type="button">${icon("download", "lf-ic-sm")}Import entries as source</button>
        </div>
        <div class="lf-search-status lf-deck-lb-target"></div>
    `);
    // Select options load once per Studio open; target note + binding refresh
    // on every renderDraftsList (renderImportForm).
    listLorebooks().then(books => {
        $("#lf_deck_import .lf-deck-lb-select").html(
            `<option value="">— pick a lorebook —</option>` +
            books.map(b => `<option value="${escapeHtml(b.file_id)}">${escapeHtml(b.name)}</option>`).join(""));
    }).catch(err => {
        console.error(`[${extensionName}] Lorebook list failed:`, err);
        $("#lf_deck_import .lf-deck-lb-select").html(`<option value="">(failed to list lorebooks)</option>`);
    });

    $("#lf_batch_commit").on("click", () => {
        const form = $("#lf_batch_form");
        if (form.is(":visible") && form.children().length) return form.slideUp(100).html("");
        mountCommitForm(form, getDrafts().filter(d => selected.has(d.id)));
    });
    $("#lf_studio_root .lf-export-json").on("click", exportJson);

    // Batch "select all" ticks every .lf-draft-check (nested cards included)
    $("#lf_drafts_all").on("change", function () {
        const on = $(this).prop("checked");
        for (const d of getSessionDrafts()) on ? selected.add(d.id) : selected.delete(d.id);
        $("#lf_drafts_list .lf-draft-check").prop("checked", on);
        $("#lf_drafts_list .lf-draft").toggleClass("selected", on);
        updateBatchBar();
    });
    $("#lf_drafts_list").on("change", ".lf-draft-check", function () {
        const card = $(this).closest(".lf-draft");
        const on = $(this).prop("checked");
        on ? selected.add(card.data("id")) : selected.delete(card.data("id"));
        card.toggleClass("selected", on);
        updateBatchBar();
    });
    // Source context checkbox (v1 "include in prompt" toggle)
    $("#lf_drafts_list").on("change", ".lf-source-check", function () {
        const srcEl = $(this).closest(".lf-source");
        if (!srcEl.data("id")) return; // loose section has none
        const active = toggleSourceActive(String(srcEl.data("id")));
        srcEl.toggleClass("off", !active);
        srcEl.find(".lf-source-state").toggleClass("off", !active).text(active ? "In context" : "Excluded");
    });
    // Card header click expands/collapses the source preview
    $("#lf_drafts_list").on("click", ".lf-source-head", function (e) {
        if ($(e.target).closest(".lf-source-check, .lf-source-delete, .lf-chip").length) return;
        $(this).closest(".lf-source").toggleClass("open");
    });
    $("#lf_drafts_list").on("click", ".lf-source-delete", function () {
        const srcEl = $(this).closest(".lf-source");
        const src = getWizardSession().sources.find(s => s.id === String(srcEl.data("id")));
        if (!src) return;
        if (!window.confirm(`Remove source "${src.title}"? Entries staged against it stay, but become Loose.`)) return;
        deleteSource(String(srcEl.data("id")));
        renderDraftsList();
        console.log(`[${extensionName}] Source removed: "${src.title}"`);
    });
    $("#lf_drafts_list").on("click", ".lf-draft-delete", function () {
        deleteDraft($(this).closest(".lf-draft").data("id"));
        renderDraftsList();
    });
    $("#lf_drafts_list").on("click", ".lf-draft-commit", function () {
        const id = $(this).closest(".lf-draft").data("id");
        hideAllDraftForms(id);
        const form = $(`#lf_drafts_list .lf-commit-form[data-id="${CSS.escape(id)}"]`);
        if (form.is(":visible") && form.children().length) form.slideUp(100).html("");
        else mountCommitForm(form, getDrafts().filter(d => d.id === id));
    });
    $("#lf_drafts_list").on("click", ".lf-draft-edit", function () {
        openInspector($(this).closest(".lf-draft").data("id"));
    });
    // v1 "Wizard" button: load a staged draft into the Wizard composer
    $("#lf_drafts_list").on("click", ".lf-draft-wizard", function () {
        sendDraftToWizard($(this).closest(".lf-draft").data("id"));
    });

    // ---- v1 left rail (Canon Research & Sources) wiring ----
    // Search: Go click or Enter → the real Reader search (SearXNG)
    const railSearch = () => {
        const q = String($("#lf_rail_search").val() || "").trim();
        if (!q) return;
        document.getElementById("lf_studio_root")?.dispatchEvent(new CustomEvent("lf-show-reader"));
        $("#lf_search_query").val(q);
        $("#lf_search_btn").trigger("click");
    };
    $("#lf_rail_search_go").on("click", railSearch);
    $("#lf_rail_search").on("keydown", function (e) {
        if (e.key === "Enter") {
            e.preventDefault();
            railSearch();
        }
    });
    // Quick filter chips: radio behavior — click the active one to clear
    $(".lf-rail-filter").on("click", function () {
        const f = String($(this).data("filter"));
        railFilter = railFilter === f ? null : f;
        $(".lf-rail-filter").removeClass("active");
        if (railFilter) $(this).addClass("active");
        renderResearchRail();
    });
    // Add Source: focus the deck's slide-open paste form (never toggles it closed)
    $("#lf_rail_addsource").on("click", () => {
        document.getElementById("lf_studio_root")?.dispatchEvent(new CustomEvent("lf-show-sources"));
        const form = $("#lf_deck_addsource");
        if (form.length && !form.is(":visible")) $(".lf-deck-addsource").trigger("click");
        $(".lf-deck-src-title").trigger("focus");
    });
    // Rail checkbox → same context toggle the deck uses, then refresh both
    $("#lf_rail_sources").on("change", ".lf-rail-check", function () {
        toggleSourceActive(String($(this).closest(".lf-rail-card").data("id")));
        renderDraftsList();
    });
}

export function renderDraftsList() {
    const container = $("#lf_drafts_list");
    if (!container.length) return;
    const w = getWizardSession();
    const drafts = getSessionDrafts();
    const totalEntryText = drafts.reduce((n, d) => n + d.content.length, 0);
    $("#lf_book_pill_kb").text(totalEntryText ? `${(totalEntryText / 1024).toFixed(1)} KB` : "");
    $("#lf_drafts_count").text(w.sources.length
        ? `${w.sources.length} source${w.sources.length === 1 ? "" : "s"} · ${totalEntryText ? `${(totalEntryText / 1024).toFixed(1)} KB` : "0 entries"}`
        : "");

    if (!w.sources.length && !drafts.length) {
        container.html(`
            <div class="lf-pane-empty">
                <div class="lf-reader-empty-icon">🗂</div>
                <h3>The deck is empty</h3>
                <p>Add a source, import a lorebook,<br>or scrape a page in the Reader —<br>staged entries nest inside their source here.</p>
            </div>
        `);
    } else {
        const loose = drafts.filter(d => !d.sourceId || !w.sources.some(s => s.id === d.sourceId));
        container.html(`
            ${w.sources.map(s => sourceCardHtml(s, drafts)).join("")}
            ${loose.length ? looseSectionHtml(loose) : ""}
        `);
    }
    renderBookPill();
    updateBatchBar();
    renderCanonRules();
    renderImportForm();
    renderResearchRail();
}

// Canon-rules + import forms: forms persist across renders, so only their
// STATE (canon value, target note, import binding) is refreshed per render.
function renderCanonRules() {
    $("#lf_deck_canon .lf-deck-canon-rules").val(getWizardSession().canonRules);
}

function renderImportForm() {
    const targetNote = $("#lf_deck_import .lf-deck-lb-target");
    const select = $("#lf_deck_import .lf-deck-lb-select");
    const target = getWizardSession().lorebookTarget;
    targetNote.text(target ? `Update target set: ${target} — Wizard updates land in this book.` : "No update target — importing sets it.");
    $("#lf_deck_import .lf-deck-lb-import").off("click.lflb").on("click.lflb", async function () {
        const btn = $(this).prop("disabled", true);
        const name = String(select.val() || "").trim();
        try {
            if (!name) {
                toastr.warning("Pick a lorebook first.", "Lorebook Forge");
                return;
            }
            const sourceTitle = `Lorebook: ${name}`;
            if (getWizardSession().sources.some(s => s.title === sourceTitle)) {
                toastr.warning(`"${name}" is already imported as a source.`, "Lorebook Forge");
                return;
            }
            const entries = await loadLorebookEntries(name);
            const text = lorebookToSourceText(name, entries);
            addSource({ title: sourceTitle, text });
            setLorebookTarget(name);
            console.log(`[${extensionName}] Lorebook imported: "${name}" (${Object.keys(entries).length} entries, ${text.length} chars)`);
            toastr.success(`"${name}" imported — ${Object.keys(entries).length} entries became a source. Update target set.`, "Lorebook Forge");
            renderDraftsList();
        } catch (err) {
            console.error(`[${extensionName}] Lorebook import failed:`, err);
            toastr.error(`Import failed: ${err.message}`, "Lorebook Forge");
        } finally {
            btn.prop("disabled", false);
        }
    });
}

// ---------- v1 left rail: Canon Research & Sources ----------
// A compact mirror of the deck's sources: filterable cards + the
// Reconciliation Status meter. The rail renders from the SAME wizard
// session sources the deck owns, so renderDraftsList() refreshes it.

// Quick-filter chips: case-insensitive regex over source titles
const RAIL_FILTERS = {
    magic:  /magic|law/i,
    chars:  /char|person/i,
    relics: /relic|artifact|item/i,
};
let railFilter = null;

// Last verdict counts renderProposals() computed — the rail meter and the
// Proposals grounding bar can never disagree.
const recon = { counts: { verified: 0, fuzzy: 0, missing: 0 }, total: 0 };

// Shared with wizard.js — called from renderProposals() with the same
// verdict counts renderGrounding() uses.
export function updateResearchRail(counts, total) {
    recon.counts = counts || { verified: 0, fuzzy: 0, missing: 0 };
    recon.total = Number(total) || 0;
    renderReconMeter();
}

function renderReconMeter() {
    const val = $("#lf_recon_value");
    if (!val.length) return;
    if (!recon.total) {
        val.text("—");
        $("#lf_recon_bar").css("width", "0%");
        $("#lf_recon_text").text("No key conflicts detected in active sources.");
        return;
    }
    const pct = Math.round(recon.counts.verified / recon.total * 100);
    val.text(`${pct}% Verified`);
    $("#lf_recon_bar").css("width", `${pct}%`);
    $("#lf_recon_text").text(recon.counts.missing === 0
        ? "No key conflicts detected in active sources."
        : `${recon.counts.missing} unverified — review in Proposals.`);
}

function railSourceCardHtml(s) {
    const active = s.active !== false;
    const preview = String(s.text).replace(/\s+/g, " ").trim().slice(0, 220);
    return `
        <div class="lf-rail-card" data-id="${escapeHtml(s.id)}">
            <div class="lf-rail-card-head">
                ${sourceIcon(s)}
                <span class="lf-rail-card-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</span>
                <input type="checkbox" class="lf-rail-check" title="Include this source in AI context (extraction + chat)"${active ? " checked" : ""} />
            </div>
            <div class="lf-rail-card-preview">${preview ? escapeHtml(preview) : "<i>(empty source)</i>"}</div>
            <div class="lf-rail-card-foot">
                <span>${(s.text.length / 1024).toFixed(1)} KB · ~${Math.ceil(s.text.length / 4).toLocaleString()} tok</span>
                <span class="lf-rail-state${active ? "" : " off"}">${active ? `${icon("checkCircle", "lf-ic-sm")}Indexed` : "Excluded"}</span>
            </div>
        </div>
    `;
}

function renderResearchRail() {
    const list = $("#lf_rail_sources");
    if (!list.length) return;
    const sources = getWizardSession().sources;
    const rx = railFilter ? RAIL_FILTERS[railFilter] : null;
    const shown = rx ? sources.filter(s => rx.test(s.title)) : sources;
    $("#lf_rail_count").text(shown.length);
    list.html(shown.length
        ? shown.map(railSourceCardHtml).join("")
        : `<div class="lf-rail-empty">${railFilter
            ? "No sources match this filter."
            : "No sources staged yet — scrape a page in the Reader, or use Add Source."}</div>`);
    renderReconMeter();
}

// v1 "Wizard" button: load a staged draft into the Wizard composer for iteration
function sendDraftToWizard(id) {
    const d = getDrafts().find(x => x.id === String(id));
    if (!d) return;
    const text = [
        "Refine this staged draft entry:",
        "",
        `Title: ${d.title}`,
        `Keys: ${d.keys.join(", ")}`,
        "Content:",
        d.content,
    ].join("\n");
    $("#lf_wizard_input").val(text);
    document.getElementById("lf_studio_root")?.dispatchEvent(
        new CustomEvent("lf-show-center", { detail: "wizard" }));
    requestAnimationFrame(() => $("#lf_wizard_input").trigger("focus"));
    toastr.info(`"${d.title}" loaded into the Wizard.`, "Lorebook Forge");
}
