// Distillation UI: source selection (checkboxes on drafts) + topic + button.
// One-way dependency: distiller → drafts (never the reverse).
import { extensionName } from "./config.js";
import { escapeHtml } from "./helpers.js";
import { getDrafts, saveDraft, renderDraftsList } from "./drafts.js";
import { distillSources } from "./llmData.js";

export function initDistiller() {
    const container = $("#lf_drafts_list");
    if (!container.length) return;

    if ($("#lf_distill_bar").length) return; // already mounted (Studio reopen guard)
    const bar = $(`
        <div id="lf_distill_bar" class="lf-distill-bar">
            <input class="text_pole lf-text-input lf-distill-topic" type="text"
                   placeholder="Focus / topic (optional — e.g. 'combat lore only')" />
            <button class="menu_button lf-distill-go" type="button">✨ Distill selected → AI</button>
            <div class="lf-distill-status lf-search-status" style="display:none;"></div>
        </div>
    `);
    container.before(bar);

    bar.find(".lf-distill-go").on("click", async function () {
        const btn = $(this);
        const status = bar.find(".lf-distill-status");

        const selected = getDrafts().filter(d => $(`#lf_drafts_list .lf-draft[data-id="${CSS.escape(d.id)}"] .lf-draft-check`).prop("checked"));
        if (selected.length === 0) {
            toastr.warning("Tick at least one draft's checkbox first.", "Lorebook Forge");
            return;
        }

        const topic = String(bar.find(".lf-distill-topic").val()).trim();
        btn.prop("disabled", true).text("Distilling…");
        status.show().text(`Sending ${selected.length} source(s) to the AI (${selected.reduce((n, d) => n + (d.sourceRaw || d.content).length, 0).toLocaleString()} chars)…`);

        try {
            const entries = await distillSources({
                sources: selected.map(d => ({ title: d.title, url: d.sourceUrl, raw: d.sourceRaw, content: d.content })),
                topic,
            });
            const origin = `AI · ${selected.map(d => d.title).join(" + ")}`;
            for (const e of entries) {
                saveDraft({
                    title: e.title,
                    keys: e.keys.length ? e.keys : [e.title],
                    content: e.content,
                    sourceUrl: selected[0].sourceUrl,
                    sourceTitle: origin,
                    sourceRaw: "", // AI output is already curated — don't re-feed it
                    origin: "ai",
                });
            }
            renderDraftsList();
            toastr.success(`AI proposed ${entries.length} entries — review them in the drafts list.`, "Lorebook Forge");
            status.show().text(`✅ ${entries.length} AI entries added below (marked ✨). Edit or commit like any draft.`);
        } catch (err) {
            console.error(`[${extensionName}] Distillation failed:`, err);
            toastr.error(`Distillation failed: ${err.message}`, "Lorebook Forge");
            status.show().text(`❌ ${err.message}`);
        } finally {
            btn.prop("disabled", false).text("✨ Distill selected → AI");
        }
    });
}
