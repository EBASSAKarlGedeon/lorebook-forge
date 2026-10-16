// Research workspace (Studio): search panel + central reader + draft form.
// Moved out of the drawer (settings.js) — the drawer is now just a launcher.
import { extensionName } from "./config.js";
import { escapeHtml, suggestKeys } from "./helpers.js";
import { searchSearxng, fetchPageText, collectWikiLinks, enumerateCategory } from "./searchData.js";
import { saveDraft, renderDraftsList } from "./drafts.js";
import { getSettings } from "./settings.js";

// Full extracted text per URL. Deliberately survives Studio close/reopen,
// so a page read earlier can still be drafted after reopening.
const pageCache = new Map(); // url -> { text, title, raw }

function setStatus(text) {
    $("#lf_studio_status").text(text);
}

// Reset the Reader tab back to its empty state (the ✕ in the title bar).
// pageCache is deliberately NOT touched: the page stays draftable/re-readable.
function closeReader() {
    $("#lf_reader").html(`
        <div class="lf-reader-empty">
            <div class="lf-reader-empty-icon">📖</div>
            <h3>Reader</h3>
            <p>Search in the Research panel, then click "Read" on a result.<br>Page content appears here, ready to become a draft.</p>
        </div>
    `);
    $("#lf_search_results .lf-result").removeClass("active");
    setStatus("Reader closed");
}

// Fetch a page and store it (with its harvested links) in the page cache.
// Single choke point for both single reads and the batch runner.
async function fetchAndCache(url) {
    const fetched = await fetchPageText(url);
    const links = fetched.html ? collectWikiLinks(fetched.html, url) : [];
    const entry = { ...fetched, links };
    pageCache.set(url, entry);
    return entry;
}

// ---------- Stage 20: batch read (crawl hygiene) ----------
// "⚡ Read all" on a link/category strip: serialized ~1 req/s, seen-URLs =
// pageCache, 25-page budget per run, and the button itself is the off-switch.
const BATCH_DELAY_MS = 1000;
const BATCH_BUDGET = 25;
let batchRunning = false;
let batchStop = false;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runBatchRead(urls) {
    const reader = $("#lf_reader");
    const setBtns = (label, running) =>
        reader.find(".lf-batch-btn").text(label).toggleClass("lf-batch-running", running);

    // A click while running means STOP — whichever batch button it lands on.
    if (batchRunning) {
        batchStop = true;
        setStatus("Stopping batch read…");
        return;
    }

    const fresh = urls.filter(u => !pageCache.has(u));
    const alreadyCached = urls.length - fresh.length;
    const queue = fresh.slice(0, BATCH_BUDGET);
    const deferred = fresh.length - queue.length;

    batchRunning = true;
    batchStop = false;
    setBtns("■ Stop", true);
    let ok = 0;
    let failed = 0;
    try {
        for (const [i, url] of queue.entries()) {
            if (batchStop) break;
            setStatus(`Batch read ${i + 1}/${queue.length} — ${ok} ok${failed ? `, ${failed} failed` : ""}`);
            try {
                await fetchAndCache(url);
                ok++;
            } catch (err) {
                failed++;
                console.warn(`[${extensionName}] Batch read failed: ${url} — ${err.message}`);
            }
            if (i < queue.length - 1) await delay(BATCH_DELAY_MS);
        }
    } finally {
        batchRunning = false;
        setBtns("⚡ Read all", false);
    }

    const summary = [
        `${ok} read`,
        failed ? `${failed} failed` : null,
        alreadyCached ? `${alreadyCached} cached` : null,
        deferred ? `${deferred} deferred (budget ${BATCH_BUDGET}/run)` : null,
        batchStop ? "stopped early" : null,
    ].filter(Boolean).join(", ");
    setStatus(`Batch read done — ${summary}. Chip pages now load from cache.`);
    toastr.info(`Batch read done: ${summary}.`, "Lorebook Forge");
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
            <button class="menu_button lf-draft-close" type="button">✕ Close</button>
        </div>
    `);
    form.slideDown(150);
    form.find(".lf-draft-close").on("click", () => form.slideUp(150));
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

// Loads any URL into the Reader pane — from a search result or a wiki-link chip.
// resultEl is optional (the search result to highlight; wiki-link clicks pass none).
async function loadIntoReader(url, resultEl = null) {
    if (resultEl) {
        $("#lf_search_results .lf-result").removeClass("active");
        resultEl.addClass("active");
    }

    // Cache-first: batch-read pages (and re-reads) render instantly.
    let entry;
    if (pageCache.has(url)) {
        entry = pageCache.get(url);
        console.log(`[${extensionName}] Reader cache hit: ${url}`);
    } else {
        entry = await fetchAndCache(url);
    }
    const { text, title, raw, route, html, links } = entry;
    const kb = (text.length / 1024).toFixed(1);

    // Stage 18: links from the rendered HTML (MediaWiki route only —
    // plain HTML reads return no `html` and simply skip the strip).
    const wikiLinks = links || (html ? collectWikiLinks(html, url) : []);

    const reader = $("#lf_reader");
    reader.html(`
        <div class="lf-reader-content">
            <div class="lf-reader-meta">${kb} KB · ${escapeHtml(route)}
                <button class="menu_button lf-draft-btn" type="button">Make Entry Draft</button>
                <button class="menu_button lf-reader-close" type="button" title="Reset the Reader tab">✕</button>
            </div>
            <pre class="lf-reader-text">${escapeHtml(text)}</pre>
            ${wikiLinks.length ? `
            <div class="lf-reader-links">
                <div class="lf-reader-links-label">
                    Wiki links on this page (${wikiLinks.length})
                    <button class="menu_button lf-batch-btn" type="button" title="Read every un-cached link above, ~1/sec">⚡ Read all</button>
                </div>
                <div class="lf-reader-links-scroll">
                    ${wikiLinks.map(l => {
                        const isCat = l.title.startsWith("Category:");
                        return `<button class="menu_button lf-reader-link${isCat ? " lf-cat-chip" : ""}" type="button"
                        data-url="${escapeHtml(l.url)}" data-title="${escapeHtml(l.title)}"${isCat ? ' data-cat="1"' : ""}
                        title="${isCat ? "Enumerate this category" : escapeHtml(l.url)}">${isCat ? "📁 " : ""}${escapeHtml(l.label)}</button>`;
                    }).join("")}
                </div>
            </div>` : ""}
            <div class="lf-cat-members" style="display:none;"></div>
            <div class="lf-draft-form" style="display:none;"></div>
        </div>
    `);
    reader.find(".lf-draft-btn").on("click", () => showDraftForm(reader, url));
    reader.find(".lf-reader-close").on("click", closeReader);
    // Stage 19: render enumerated category members into the holder
    function renderCategoryMembers(holder, { pages, subcats }) {
        if (!pages.length && !subcats.length) {
            holder.html(`<div class="lf-search-status">Category is empty.</div>`);
            return;
        }
        const chip = (item, isCat) => `<button class="menu_button lf-reader-link${isCat ? " lf-cat-chip" : ""}" type="button"
            data-url="${escapeHtml(item.url)}" data-title="${escapeHtml(item.title)}"${isCat ? ' data-cat="1"' : ""}
            title="${escapeHtml(item.url)}">${isCat ? "📁 " : ""}${escapeHtml(item.title.replace(/^Category:/, ""))}</button>`;
        holder.html(`
            <div class="lf-reader-links-label">
                Category members — ${pages.length} page(s) · ${subcats.length} subcategor(y/ies)
                <button class="menu_button lf-batch-btn" type="button" title="Read every un-cached member page, ~1/sec">⚡ Read all</button>
            </div>
            <div class="lf-reader-links-scroll">
                ${subcats.map(s => chip(s, true)).join("")}
                ${pages.map(p => chip(p, false)).join("")}
            </div>
        `);
    }

    // One delegated handler for ALL chips (wiki links + category members):
    // category chips enumerate in place, page chips load into the reader.
    // .lfchips namespace + off-before-on: loadIntoReader re-runs on every
    // read, and #lf_reader persists — without this, handlers stack and a
    // single click fires once per page ever read.
    reader.off("click.lfchips").on("click.lfchips", ".lf-reader-link", function () {
        const btn = $(this);
        const linkUrl = String(btn.data("url"));
        if (btn.data("cat")) {
            const title = String(btn.data("title"));
            const origin = new URL(linkUrl).origin;
            const holder = reader.find(".lf-cat-members");
            setStatus(`Enumerating "${title}"…`);
            holder.html(`<div class="lf-search-status">Enumerating…</div>`).slideDown(150);
            enumerateCategory(origin, title)
                .then(({ pages, subcats }) => {
                    renderCategoryMembers(holder, { pages, subcats });
                    setStatus(`Category "${title}": ${pages.length} pages, ${subcats.length} subcategories`);
                })
                .catch(err => {
                    console.error(`[${extensionName}] Category enumeration failed:`, err);
                    toastr.error(`Could not enumerate "${title}": ${err.message}`, "Lorebook Forge");
                    holder.slideUp(150);
                    setStatus(`Category failed: ${err.message}`);
                });
            return;
        }
        setStatus(`Reading "${btn.text()}"…`);
        loadIntoReader(linkUrl).catch(err => {
            console.error(`[${extensionName}] Wiki-link read failed:`, err);
            toastr.error(`Could not read "${btn.text()}": ${err.message}`, "Lorebook Forge");
            setStatus(`Read failed: ${err.message}`);
        });
    });

    // ⚡ Read all: every un-cached chip URL in this strip (page chips only —
    // category chips would need per-subcat enumeration, not batch fetching).
    reader.off("click.lfbatch").on("click.lfbatch", ".lf-batch-btn", function () {
        const urls = [...reader.find(".lf-reader-link").not("[data-cat]")].map(el => String($(el).data("url")));
        if (!urls.length) return;
        runBatchRead([...new Set(urls)]);
    });

    // Ask the Studio shell to make sure the Reader pane is visible
    document.getElementById("lf_studio_root")?.dispatchEvent(new CustomEvent("lf-show-reader"));
    setStatus(`Read "${title}" — ${kb} KB via ${route} · ${wikiLinks.length} wiki link(s)`);
}

async function onReadClick(event) {
    const btn = $(event.currentTarget);
    const resultEl = btn.closest(".lf-result");
    const url = resultEl.data("url");
    btn.prop("disabled", true).text("Loading…");
    try {
        await loadIntoReader(url, resultEl);
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
