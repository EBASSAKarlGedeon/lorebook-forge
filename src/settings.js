import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { defaultSettings, extensionName } from "./config.js";
import { testSearxngConnection, searchSearxng } from "./searchData.js";
import { escapeHtml } from "./helpers.js";

export function getSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }
    return extension_settings[extensionName];
}

function resultItemHtml(result) {
    const engines = result.engines.length
        ? `<div class="lf-result-engines">${result.engines.map(e => `<span>${escapeHtml(e)}</span>`).join("")}</div>`
        : "";
    return `
        <div class="lf-result">
            <a class="lf-result-title" href="${escapeHtml(result.url)}" target="_blank" rel="noreferrer">${escapeHtml(result.title)}</a>
            <div class="lf-result-url">${escapeHtml(result.url)}</div>
            <div class="lf-result-snippet">${escapeHtml(result.snippet)}</div>
            ${engines}
        </div>
    `;
}

export function initSettings() {
    const settings = getSettings();

    const html = `
        <div class="lf-settings-block">
            <label class="lf-settings-label" for="lf_searxng_url">SearXNG base URL</label>
            <input id="lf_searxng_url" class="text_pole lf-text-input" type="text"
                   placeholder="http://localhost:8888"
                   value="${settings.searxngUrl}" />
            <div class="lf-settings-hint">Your self-hosted SearXNG instance (Docker). Default: http://localhost:8888</div>
        </div>
        <div class="lf-settings-block">
            <button id="lf_test_connection" class="menu_button" type="button">Test SearXNG connection</button>
        </div>
        <div class="lf-settings-block">
            <label class="lf-settings-label" for="lf_search_query">Test search</label>
            <div class="lf-search-row">
                <input id="lf_search_query" class="text_pole lf-text-input" type="text"
                       placeholder="e.g. medieval castles" />
                <button id="lf_search_btn" class="menu_button" type="button">Go</button>
            </div>
            <div id="lf_search_results" class="lf-search-results"></div>
        </div>
    `;
    $(".lorebook-forge-settings .inline-drawer-content").append(html);

    $("#lf_searxng_url").on("input", function () {
        settings.searxngUrl = String($(this).val()).trim();
        saveSettingsDebounced();
        console.debug(`[${extensionName}] searxngUrl = "${settings.searxngUrl}"`);
    });

    $("#lf_test_connection").on("click", async function () {
        const btn = $(this);
        btn.prop("disabled", true);
        try {
            const html = await testSearxngConnection(getSettings().searxngUrl);
            const kb = (html.length / 1024).toFixed(1);
            toastr.success(`SearXNG responded — ${kb} KB of results HTML.`, "Lorebook Forge");
        } catch (err) {
            console.error(`[${extensionName}] Connection test failed:`, err);
            toastr.error(`Connection failed: ${err.message}. Is the Docker container running?`, "Lorebook Forge");
        } finally {
            btn.prop("disabled", false);
        }
    });

    const runSearch = async () => {
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
        } catch (err) {
            console.error(`[${extensionName}] Search failed:`, err);
            resultsEl.html(`<div class="lf-search-status">Search failed: ${escapeHtml(err.message)}</div>`);
        } finally {
            $("#lf_search_btn").prop("disabled", false);
        }
    };

    $("#lf_search_btn").on("click", runSearch);
    $("#lf_search_query").on("keydown", (e) => {
        if (e.key === "Enter") runSearch();
    });
}
