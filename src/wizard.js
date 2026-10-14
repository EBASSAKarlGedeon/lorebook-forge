// Lorebook Wizard (center pane): the conversational lorebook builder.
// Stage 12: shell only — canon rules + pasted sources, persisted.
// Chat + LLM extraction arrive in later stages; this module will grow
// a chat area above the sources, so the layout is built for that.
import { extensionName } from "./config.js";
import { escapeHtml } from "./helpers.js";
import { getWizardSession, setCanonRules, addSource, deleteSource } from "./wizardData.js";

function sourceCardHtml(s) {
    const preview = String(s.text).replace(/\s+/g, " ").trim().slice(0, 180);
    return `
        <div class="lf-source" data-id="${escapeHtml(s.id)}">
            <div class="lf-source-head">
                <div class="lf-source-title">${escapeHtml(s.title)}</div>
                <span class="lf-source-chars">${(s.text.length / 1024).toFixed(1)} KB</span>
                <button class="menu_button lf-source-delete" type="button" title="Remove source">✕</button>
            </div>
            <div class="lf-source-preview">${escapeHtml(preview)}…</div>
        </div>
    `;
}

export function renderWizard() {
    const root = $("#lf_wizard");
    if (!root.length) return;
    const w = getWizardSession();
    const totalChars = w.sources.reduce((n, s) => n + s.text.length, 0);

    root.html(`
        <div class="lf-wizard-header">
            <span class="lf-wizard-logo">✨</span>
            <span class="lf-wizard-name">Lorebook Wizard</span>
            <span class="lf-wizard-meta">${w.sources.length} source${w.sources.length === 1 ? "" : "s"} · ${(totalChars / 1024).toFixed(1)} KB</span>
        </div>
        <div class="lf-wizard-body">
            <div class="lf-wizard-section">
                <label class="lf-settings-label">Canon rules — sent with every AI call in this session</label>
                <textarea class="text_pole lf-wizard-canon" rows="3"
                    placeholder="e.g. Manga canon only. Ignore anime-original arcs, filler and movies. If sources conflict, the manga wins.">${escapeHtml(w.canonRules)}</textarea>
            </div>
            <div class="lf-wizard-section">
                <label class="lf-settings-label">Add source — paste page text</label>
                <input class="text_pole lf-text-input lf-source-title-input" type="text"
                       placeholder="Source title (e.g. 'Eldoria wiki — Geography section')" />
                <textarea class="text_pole lf-source-text-input" rows="6"
                          placeholder="Paste the source text here…"></textarea>
                <div class="lf-draft-form-actions">
                    <button class="menu_button lf-source-add" type="button">Add source</button>
                </div>
            </div>
            <div class="lf-wizard-sources">
                ${w.sources.length
                    ? w.sources.map(sourceCardHtml).join("")
                    : `<div class="lf-search-status">No sources yet — paste one above. (Chat + AI extraction arrive in the next stage.)</div>`}
            </div>
        </div>
    `);

    // Canon rules: save on input (saveSettingsDebounced handles the debounce)
    root.find(".lf-wizard-canon").on("input", function () {
        setCanonRules($(this).val());
    });

    root.find(".lf-source-add").on("click", function () {
        const title = String(root.find(".lf-source-title-input").val()).trim();
        const text = String(root.find(".lf-source-text-input").val());
        if (!text.trim()) {
            toastr.warning("Paste some source text first.", "Lorebook Forge");
            return;
        }
        const src = addSource({ title, text });
        console.log(`[${extensionName}] Wizard source added: "${src.title}" (${src.text.length} chars)`);
        toastr.success(`Source added: "${src.title}"`, "Lorebook Forge");
        renderWizard();
    });

    root.find(".lf-source-delete").on("click", function () {
        deleteSource($(this).closest(".lf-source").data("id"));
        renderWizard();
    });
}

export function initWizard() {
    renderWizard();
    console.log(`[${extensionName}] Wizard initialized (${getWizardSession().sources.length} sources)`);
}
