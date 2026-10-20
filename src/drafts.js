// Entry drafts: research basket awaiting commit to a lorebook.
// Storage lives in extension_settings — survives refresh.
// Stage 24 (v2 Draft Deck): batch select + commit, a modal inspector with
// the WorldInfo fields (secondary keys, logic, position, depth, order,
// scan depth, probability), and SillyTavern JSON export.
import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "./config.js";
import { escapeHtml, icon, keysHtml } from "./helpers.js";
import { listLorebooks, commitDraftToLorebook, draftToEntry, draftsToWorldJson } from "./wiData.js";

// Ticked draft ids — kept across re-renders (cleared on delete)
const selected = new Set();

export function getDrafts() {
    const s = extension_settings[extensionName];
    if (!Array.isArray(s.drafts)) s.drafts = [];
    return s.drafts;
}

export function saveDraft({ title, keys, content, sourceUrl, sourceTitle, sourceRaw, origin }){
    const drafts = getDrafts();
    const draft = {
        id: crypto.randomUUID(),
        title: String(title || "Untitled").trim(),
        keys: Array.isArray(keys) ? keys.map(k => String(k).trim()).filter(Boolean) : [],
        content: String(content || "").trim(),
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

// ---------- Deck ----------

function updateBatchBar() {
    const drafts = getDrafts();
    const n = drafts.filter(d => selected.has(d.id)).length;
    $("#lf_drafts_selected").text(n ? `${n} selected` : "");
    $("#lf_drafts_all").prop("checked", n > 0 && n === drafts.length).prop("indeterminate", n > 0 && n < drafts.length);
    $("#lf_batch_commit").prop("disabled", !n);
}

function exportJson() {
    const drafts = getDrafts();
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

// Static deck chrome (batch bar, export buttons) — wired once per Studio open
export function initDraftsDeck() {
    $("#lf_drafts_all").on("change", function () {
        const on = $(this).prop("checked");
        for (const d of getDrafts()) on ? selected.add(d.id) : selected.delete(d.id);
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
    $("#lf_batch_commit").on("click", () => {
        const form = $("#lf_batch_form");
        if (form.is(":visible") && form.children().length) return form.slideUp(100).html("");
        mountCommitForm(form, getDrafts().filter(d => selected.has(d.id)));
    });
    $("#lf_studio_root .lf-export-json").on("click", exportJson);
}

export function renderDraftsList() {
    const container = $("#lf_drafts_list");
    if (!container.length) return;
    const drafts = getDrafts();
    $("#lf_drafts_count").text(drafts.length ? `${drafts.length} card${drafts.length === 1 ? "" : "s"}` : "");
    if (drafts.length === 0) {
        container.html(`<div class="lf-search-status">No drafts yet — read a page, then "Make Entry Draft", or stage a Wizard proposal.</div>`);
        updateBatchBar();
        return;
    }
    container.html(drafts.map(d => {
        const wi = wiOf(d);
        const pos = POSITIONS.find(p => p[0] === wi.position)?.[1] ?? "?";
        const logic = LOGICS.find(l => l[0] === wi.selectiveLogic)?.[1] ?? "?";
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
                ${wi.keysecondary.length ? `<span title="Selective logic">${logic} +${wi.keysecondary.length}</span>` : ""}
                ${wi.probability < 100 ? `<span>${wi.probability}%</span>` : ""}
                ${wi.constant ? `<span class="lf-meta-on">constant</span>` : ""}
                ${wi.disable ? `<span class="lf-meta-off">disabled</span>` : ""}
                ${d.committedTo ? `<span class="lf-meta-good" title="Committed">✓ ${escapeHtml(d.committedTo)}</span>` : ""}
            </div>
            <div class="lf-draft-meta" title="${escapeHtml(d.sourceUrl)}">${escapeHtml(d.sourceTitle || d.sourceUrl)} · ${new Date(d.createdAt).toLocaleString()}</div>
            <div class="lf-draft-actions">
                <button class="menu_button lf-btn-good lf-draft-commit" type="button" title="Commit to a lorebook">Commit</button>
                <button class="menu_button lf-draft-edit" type="button" title="Inspect & edit WorldInfo fields">Edit</button>
                <button class="menu_button lf-draft-towizard" type="button" title="Send this draft to the Wizard as a source">→ Wizard</button>
                <button class="menu_button lf-btn-bad lf-draft-delete" type="button">Delete</button>
            </div>
            <div class="lf-commit-form" data-id="${escapeHtml(d.id)}" style="display:none;"></div>
        </div>`;
    }).join(""));
    updateBatchBar();

    container.find(".lf-draft-delete").on("click", function () {
        deleteDraft($(this).closest(".lf-draft").data("id"));
        renderDraftsList();
    });
    // Decoupled from wizard.js via a DOM event (avoids drafts↔wizard cycle)
    container.find(".lf-draft-towizard").on("click", function () {
        const id = $(this).closest(".lf-draft").data("id");
        const draft = getDrafts().find(d => d.id === id);
        if (!draft) return;
        document.dispatchEvent(new CustomEvent("lf-wizard-add-source", {
            detail: { title: `Draft: ${draft.title}`, text: draft.content },
        }));
        console.log(`[${extensionName}] Draft "${draft.title}" sent to Wizard`);
    });
    container.find(".lf-draft-commit").on("click", function () {
        const id = $(this).closest(".lf-draft").data("id");
        hideAllDraftForms(id);
        const form = $(`#lf_drafts_list .lf-commit-form[data-id="${CSS.escape(id)}"]`);
        if (form.is(":visible") && form.children().length) form.slideUp(100).html("");
        else mountCommitForm(form, getDrafts().filter(d => d.id === id));
    });
    container.find(".lf-draft-edit").on("click", function () {
        openInspector($(this).closest(".lf-draft").data("id"));
    });
}
