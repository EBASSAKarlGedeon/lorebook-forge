// Research workspace (Studio): search panel + central reader + draft form.
// Moved out of the drawer (settings.js) — the drawer is now just a launcher.
import { extensionName } from "./config.js";
import { escapeHtml, suggestKeys } from "./helpers.js";
import { searchSearxng, fetchPageText } from "./searchData.js";
import { saveDraft, renderDraftsList } from "./drafts.js";
import { getSettings } from "./settings.js";

// Full extracted text per URL. Deliberately survives Studio close/reopen,
// so a page read earlier can still be drafted after reopening.
const pageCache = new Map(); // url -> { text, title, raw }

function setStatus(text) {
    $("#lf_studio_status").text(text);
}

function resultItemHtml(result) {
    const engines = result.engines.length
        ? `<div class="lf-result-engines">${result.engines.map(e => `<span>${escapeHtml(e)}</span>`).join("")}</div>`
        : "";
    return `
        <div class="lf-result" data-url="${escapeHtml(result.url)}">
            <a class="lf-result-title" href="${escapeHtml(result.url)}" target="_blank" rel="noreferrer">${escapeHtml(result.title)}</a>
            <div class="lf-result-url">${escapeHtml(result.url)}</div>
            <div class="lf-result-snippet">${escapeHtml(result.snippet)}</div>
            <div class="lf-result-actions">
                <button class="menu_button lf-read-btn" type="button">Read</button>
            </div>
            ${engines}
        </div>
    `;
}

function showDraftForm(readerEl, url) {
    const cached = pageCache.get(url);
    if (!cached) return;
    const form = readerEl.find(".lf-draft-form");
    const keys = suggestKeys(cached.title);
    form.html(`
        <label class="lf-settings-label">Title</label>
        <input class="text_pole lf-text-input lf-draft-title" value="${escapeHtml(cached.title)}" />
        <label class="lf-settings-label">Keys (comma-separated — what triggers this entry in chat)</label>
        <input class="text_pole lf-text-input lf-draft-keys" value="${escapeHtml(keys.join(", "))}" />
        <label class="lf-settings-label">Content</label>
        <textarea class="text_pole lf-draft-content" rows="8">${escapeHtml(cached.text)}</textarea>
        <div class="lf-draft-form-actions">
            <button class="menu_button lf-draft-save" type="button">Save Draft</button>
        </div>
    `);
    form.slideDown(150);
    form.find(".lf-draft-save").on("click", () => {
        const draft = {
            title: form.find(".lf-draft-title").val(),
            keys: String(form.find(".lf-draft-keys").val()).split(",").map(k => k.trim()).filter(Boolean),
            content: form.find(".lf-draft-content").val(),
            sourceUrl: url,
            sourceTitle: cached.title,
            sourceRaw: cached.raw || cached.text,
        };
        if (!String(draft.content).trim()) {
            toastr.warning("Draft content is empty.", "Lorebook Forge");
            return;
        }
        saveDraft(draft);
        renderDraftsList();
        toastr.success(`Draft saved: "${draft.title}" — see the Drafts panel.`, "Lorebook Forge");
        setStatus(`Draft saved: "${draft.title}"`);
        form.slideUp(150);
    });
}

async function onReadClick(event) {
    const btn = $(event.currentTarget);
    const resultEl = btn.closest(".lf-result");
    const url = resultEl.data("url");

    btn.prop("disabled", true).text("Loading…");
    try {
        const { text, title, raw, route } = await fetchPageText(url);
        const kb = (text.length / 1024).toFixed(1);
        pageCache.set(url, { text, title, raw });

        // Highlight the result currently loaded in the reader
        $("#lf_search_results .lf-result").removeClass("active");
        resultEl.addClass("active");

        const reader = $("#lf_reader");
        reader.html(`
            <div class="lf-reader-content">
                <div class="lf-reader-meta">${kb} KB · ${escapeHtml(route)}
                    <button class="menu_button lf-draft-btn" type="button">Make Entry Draft</button>
                </div>
                <pre class="lf-reader-text">${escapeHtml(text)}</pre>
                <div class="lf-draft-form" style="display:none;"></div>
            </div>
        `);
        reader.find(".lf-draft-btn").on("click", () => showDraftForm(reader, url));
        setStatus(`Read "${title}" — ${kb} KB via ${route}`);
    } catch (err) {
        console.error(`[${extensionName}] Page read failed:`, err);
        toastr.error(`Could not read page: ${err.message}`, "Lorebook Forge");
        setStatus(`Read failed: ${err.message}`);
    } finally {
        btn.prop("disabled", false).text("Read");
    }
}

async function runSearch() {
    const query = String($("#lf_search_query").val()).trim();
    const resultsEl = $("#lf_search_results");
    if (!query) return;
    $("#lf_search_btn").prop("disabled", true);
    resultsEl.html(`<div class="lf-search-status">Searching…</div>`);
    try {
        const results = await searchSearxng(getSettings().searxngUrl, query);
        const shown = results.slice(0, 10);
        resultsEl.html(shown.length
            ? shown.map(resultItemHtml).join("") +
              (results.length > shown.length
                  ? `<div class="lf-search-status">${results.length} results — showing first 10</div>`
                  : "")
            : `<div class="lf-search-status">No results found.</div>`);
        resultsEl.find(".lf-read-btn").on("click", onReadClick);
        setStatus(`${results.length} results for "${query}"`);
    } catch (err) {
        console.error(`[${extensionName}] Search failed:`, err);
        resultsEl.html(`<div class="lf-search-status">Search failed: ${escapeHtml(err.message)}</div>`);
        setStatus(`Search failed: ${err.message}`);
    } finally {
        $("#lf_search_btn").prop("disabled", false);
    }
}

export function initResearch() {
    $("#lf_search_btn").on("click", runSearch);
    $("#lf_search_query").on("keydown", (e) => {
        if (e.key === "Enter") runSearch();
    });
    console.log(`[${extensionName}] Research workspace initialized`);
}

// Nothing to tear down — the page cache deliberately survives so
// reopening the Studio keeps previously read pages draftable.
export function teardownResearch() { }
