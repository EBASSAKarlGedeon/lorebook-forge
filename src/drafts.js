// Entry drafts: created from research, awaiting commit to a lorebook (Stage 7).
// Storage lives in extension_settings — survives refresh, no files touched.
import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "./config.js";
import { escapeHtml } from "./helpers.js";

export function getDrafts() {
    const s = extension_settings[extensionName];
    if (!Array.isArray(s.drafts)) s.drafts = [];
    return s.drafts;
}

export function saveDraft({ title, keys, content, sourceUrl, sourceTitle }) {
    const drafts = getDrafts();
    const draft = {
        id: crypto.randomUUID(),
        title: String(title || "Untitled").trim(),
        keys: Array.isArray(keys) ? keys.map(k => String(k).trim()).filter(Boolean) : [],
        content: String(content || "").trim(),
        sourceUrl: String(sourceUrl || ""),
        sourceTitle: String(sourceTitle || ""),
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
        saveSettingsDebounced();
    }
}

// Renders the drafts list into #lf_drafts_list (drawer). Call after any change.
export function renderDraftsList() {
    const container = $("#lf_drafts_list");
    if (!container.length) return;
    const drafts = getDrafts();
    if (drafts.length === 0) {
        container.html(`<div class="lf-search-status">No drafts yet — read a page, then "Make Entry Draft".</div>`);
        return;
    }
    container.html(drafts.map(d => `
        <div class="lf-draft" data-id="${escapeHtml(d.id)}">
            <div class="lf-draft-title">${escapeHtml(d.title)}</div>
            ${d.keys.length ? `<div class="lf-draft-keys">${d.keys.map(k => `<span>${escapeHtml(k)}</span>`).join("")}</div>` : ""}
            <div class="lf-draft-meta" title="${escapeHtml(d.sourceUrl)}">${escapeHtml(d.sourceTitle || d.sourceUrl)} · ${new Date(d.createdAt).toLocaleString()}</div>
            <button class="menu_button lf-draft-delete" type="button">Delete</button>
        </div>
    `).join(""));
    container.find(".lf-draft-delete").on("click", function () {
        deleteDraft($(this).closest(".lf-draft").data("id"));
        renderDraftsList();
    });
}
