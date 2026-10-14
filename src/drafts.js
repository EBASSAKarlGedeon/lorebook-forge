// Entry drafts: research basket awaiting commit to a lorebook.
// Storage lives in extension_settings — survives refresh.
// (Later, the LLM distillation stage will feed from this basket too.)
import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "./config.js";
import { escapeHtml } from "./helpers.js";
import { listLorebooks, commitDraftToLorebook } from "./wiData.js";

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

// ---------- Commit UI (Stage 7) ----------

function hideAllCommitForms(exceptId) {
    $("#lf_drafts_list .lf-commit-form").each(function () {
        if (!exceptId || $(this).data("id") !== exceptId) {
            $(this).stop(true, true).slideUp(100).html("");
        }
    });
}

async function showCommitForm(draftId) {
    const draft = getDrafts().find(d => d.id === draftId);
    if (!draft) return;
    const form = $(`#lf_drafts_list .lf-commit-form[data-id="${CSS.escape(draftId)}"]`);
    form.html(`<div class="lf-search-status">Loading lorebooks…</div>`).slideDown(100);

    let books = [];
    try {
        books = await listLorebooks();
    } catch (err) {
        console.error(`[${extensionName}] Lorebook list failed:`, err);
        form.html(`<div class="lf-search-status">Failed to list lorebooks: ${escapeHtml(err.message)}</div>`);
        return;
    }

    form.html(`
        <select class="text_pole lf-commit-target">
            ${books.map(b => `<option value="${escapeHtml(b.file_id)}">${escapeHtml(b.name)}</option>`).join("")}
            <option value="__new__">➕ New lorebook…</option>
        </select>
        <input class="text_pole lf-text-input lf-commit-newname" type="text"
               placeholder="New lorebook name" style="display:none;" />
        <div class="lf-draft-form-actions">
            <button class="menu_button lf-commit-cancel" type="button">Cancel</button>
            <button class="menu_button lf-commit-go" type="button">Commit</button>
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
        let bookName = target.val() === "__new__"
            ? String(newName.val()).trim()
            : target.val();
        if (!bookName) {
            toastr.warning("Enter a lorebook name.", "Lorebook Forge");
            btn.prop("disabled", false).text("Commit");
            return;
        }
        try {
            const result = await commitDraftToLorebook(draft, bookName);
            toastr.success(`"${draft.title}" committed to "${result.name}" (${result.total} entries). Verify in the World Info editor.`, "Lorebook Forge");
            form.slideUp(100).html("");
        } catch (err) {
            console.error(`[${extensionName}] Commit failed:`, err);
            toastr.error(`Commit failed: ${err.message}`, "Lorebook Forge");
            btn.prop("disabled", false).text("Commit");
        }
    });
}

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
            <div class="lf-draft-actions">
                <button class="menu_button lf-draft-commit" type="button">Commit to lorebook</button>
                <button class="menu_button lf-draft-delete" type="button">Delete</button>
            </div>
            <div class="lf-commit-form" data-id="${escapeHtml(d.id)}" style="display:none;"></div>
        </div>
    `).join(""));

    container.find(".lf-draft-delete").on("click", function () {
        deleteDraft($(this).closest(".lf-draft").data("id"));
        renderDraftsList();
    });
    container.find(".lf-draft-commit").on("click", function () {
        const id = $(this).closest(".lf-draft").data("id");
        hideAllCommitForms(id);
        const form = $(`#lf_drafts_list .lf-commit-form[data-id="${CSS.escape(id)}"]`);
        if (form.is(":visible") && form.children().length) form.slideUp(100).html("");
        else showCommitForm(id);
    });
}
