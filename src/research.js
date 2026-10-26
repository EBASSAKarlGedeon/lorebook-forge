// Research workspace (Studio): search + results, and the READER OVERLAY.
// The overlay IS the reader: an editable page view (title + text) that also
// hosts the wiki-link chips, category enumeration, ⚡ Read all and the staging
// footer, all inside one .lf-modal-wide. The Reader tab is now search +
// results only — "Read", pasted URLs and Canon Map clicks open the overlay.
// pageCache keeps the PRISTINE fetched text (the graph and re-reads rely on
// it); the user's edits live only in the overlay textarea and are never
// written back into the cache.
import { extensionName } from "./config.js";
import { escapeHtml, parseDirectUrl, icon } from "./helpers.js";
import { searchSearxng, fetchPageText, collectWikiLinks, enumerateCategory } from "./searchData.js";
import { addSource } from "./wizardData.js";
import { renderDraftsList } from "./drafts.js";
import { getSettings } from "./settings.js";
import { saveSettingsDebounced } from "../../../../../script.js";

// Full extracted text per URL. Deliberately survives Studio close/reopen,
// so a page read earlier can still be drafted after reopening.
const pageCache = new Map(); // url -> { text, title, raw }

function setStatus(text) {
    $("#lf_studio_status").text(text);
    // The status bar is covered by the backdrop while the overlay is open —
    // mirror the message into the overlay's own footer line.
    if (overlayEl) overlayEl.find(".lf-overlay-status").text(text);
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

// `modal` is the reader overlay — the batch buttons live inside it.
async function runBatchRead(modal, urls) {
    const setBtns = (label, running) =>
        modal.find(".lf-batch-btn").text(label).toggleClass("lf-batch-running", running);

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

// ---------- Reader overlay ----------
// The overlay replaces the Reader body: the only place pages render. It is
// editable and stages sources; the pristine text always comes from pageCache.

let overlayToken = 0;   // increments per load; stale fetch results are dropped
let overlayEl = null;   // the .lf-modal-backdrop while open, else null

// Link + category chips — same markup/classes the old Reader used.
function linkChipHtml(l) {
    const isCat = l.title.startsWith("Category:");
    return `<button class="menu_button lf-reader-link${isCat ? " lf-cat-chip" : ""}" type="button"
        data-url="${escapeHtml(l.url)}" data-title="${escapeHtml(l.title)}"${isCat ? ' data-cat="1"' : ""}
        title="${isCat ? "Enumerate this category" : escapeHtml(l.url)}">${isCat ? "📁 " : ""}${escapeHtml(l.label)}</button>`;
}

// ---------- Resizable link / category strips ----------
// Both strips are rebuilt on every read, so each new one is observed. The
// height lives in one root variable (--lf-links-h) and is saved in settings:
// a size chosen once holds for every page and across Studio reopens.
const LINKS_H_MIN = 48;
const LINKS_H_MAX = 480;
const linksObserver = typeof ResizeObserver === "function" ? new ResizeObserver(entries => {
    const s = getSettings();
    for (const { target } of entries) {
        const h = Math.round(target.getBoundingClientRect().height);
        if (!h || h === s.readerLinksH) continue; // 0 = hidden strip
        s.readerLinksH = Math.min(LINKS_H_MAX, Math.max(LINKS_H_MIN, h));
        document.getElementById("lf_studio_root")?.style.setProperty("--lf-links-h", `${s.readerLinksH}px`);
        saveSettingsDebounced();
    }
}) : null;

function watchLinksStrips(scope) {
    scope.find(".lf-reader-links-scroll").each((_, el) => linksObserver?.observe(el));
}

function renderLinksStrip(modal, wikiLinks) {
    const strip = modal.find(".lf-reader-links");
    if (!wikiLinks.length) {
        strip.hide().empty();
        return;
    }
    strip.prop("open", true).html(`
        <summary class="lf-reader-links-label">
            <span class="lf-reader-links-title">Wiki links on this page (${wikiLinks.length})</span>
            <button class="menu_button lf-batch-btn" type="button" title="Read every un-cached link above, ~1/sec">⚡ Read all</button>
        </summary>
        <div class="lf-reader-links-scroll">
            ${wikiLinks.map(linkChipHtml).join("")}
        </div>
    `).show();
    watchLinksStrips(strip);
}

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
    watchLinksStrips(holder);
}

function enumerateCategoryInto(modal, title, linkUrl) {
    const origin = new URL(linkUrl).origin;
    const holder = modal.find(".lf-cat-members");
    setStatus(`Enumerating "${title}"…`);
    holder.html(`<div class="lf-search-status">Enumerating…</div>`).slideDown(150);
    enumerateCategory(origin, title)
        .then(({ pages, subcats }) => {
            if (overlayEl !== modal) return; // overlay closed meanwhile
            renderCategoryMembers(holder, { pages, subcats });
            setStatus(`Category "${title}": ${pages.length} pages, ${subcats.length} subcategories`);
        })
        .catch(err => {
            console.error(`[${extensionName}] Category enumeration failed:`, err);
            toastr.error(`Could not enumerate "${title}": ${err.message}`, "Lorebook Forge");
            holder.slideUp(150);
            setStatus(`Category failed: ${err.message}`);
        });
}

function updateTokenCounter(modal) {
    const len = String(modal.find(".lf-src-text").val() ?? "").length;
    modal.find(".lf-src-tokens").text(`${len.toLocaleString()} chars · ~${Math.ceil(len / 4).toLocaleString()} tok`);
}

// Re-enable "Stage source" after an edit or a fresh page load — prevents
// double-staging the same page.
function armStage(modal) {
    modal.find(".lf-overlay-stage").prop("disabled", false).html(`${icon("plus", "lf-ic-sm")}Stage source`);
}

// Close path used by ✕ / Cancel (and by Esc after its own confirm). Stops a
// running batch so no fetches continue once the buttons are gone.
export function closeReaderOverlay() {
    if (!overlayEl) return;
    if (batchRunning) batchStop = true;
    overlayToken++;            // drop any in-flight fetch
    overlayEl.remove();
    overlayEl = null;
}

function buildReaderOverlay() {
    const modal = $(`
        <div class="lf-modal-backdrop lf-reader-overlay">
            <div class="lf-modal lf-modal-wide" role="dialog" aria-modal="true" aria-labelledby="lf_reader_overlay_title">
                <div class="lf-modal-head">
                    <span class="lf-tile">${icon("globe", "lf-ic-accent2")}</span>
                    <div class="lf-overlay-heading">
                        <input id="lf_reader_overlay_title" class="text_pole lf-src-title" type="text" placeholder="Source title" />
                        <div class="lf-modal-sub"><span class="lf-src-route">Reading…</span></div>
                    </div>
                    <button class="lf-icon-btn lf-modal-close" type="button" title="Close (Esc)">${icon("x")}</button>
                </div>
                <div class="lf-modal-body lf-source-editor">
                    <label class="lf-field lf-field-grow"><span>Text <i class="lf-src-tokens"></i></span>
                        <textarea class="text_pole lf-src-text lf-mono"></textarea></label>
                    <details class="lf-reader-links" open style="display:none;"></details>
                    <div class="lf-cat-members" style="display:none;"></div>
                </div>
                <div class="lf-modal-foot">
                    <span class="lf-overlay-status"></span>
                    <button class="menu_button lf-modal-cancel" type="button">Cancel</button>
                    <button class="menu_button lf-btn-primary lf-overlay-stage" type="button">${icon("plus", "lf-ic-sm")}Stage source</button>
                </div>
            </div>
        </div>
    `);

    // Edits mark the overlay dirty (Esc then confirms) and re-arm staging.
    modal.on("input", ".lf-src-text", () => {
        modal.attr("data-dirty", "1");
        updateTokenCounter(modal);
        armStage(modal);
    });
    modal.on("input", ".lf-src-title", () => {
        modal.attr("data-dirty", "1");
        armStage(modal);
    });

    // ✕ / Cancel close it. Backdrop click deliberately does NOT — a stray
    // click would destroy long edits.
    modal.find(".lf-modal-close, .lf-modal-cancel").on("click", closeReaderOverlay);
    modal.find(".lf-overlay-stage").on("click", () => stageFromOverlay(modal));

    // Delegated chip + batch handlers live ON the overlay, so they are removed
    // with it (no stacking across opens). off-before-on kept for safety.
    modal.off("click.lfchips").on("click.lfchips", ".lf-reader-link", function () {
        const btn = $(this);
        const linkUrl = String(btn.data("url"));
        if (btn.data("cat")) {
            enumerateCategoryInto(modal, String(btn.data("title")), linkUrl);
            return;
        }
        openInReader(linkUrl); // same overlay; confirms first if there are edits
    });
    modal.off("click.lfbatch").on("click.lfbatch", ".lf-batch-btn", function (e) {
        e.preventDefault();      // the ⚡ button sits in a <summary>; don't toggle it
        e.stopPropagation();
        const urls = [...modal.find(".lf-reader-link").not("[data-cat]")].map(el => String($(el).data("url")));
        if (!urls.length) return;
        runBatchRead(modal, [...new Set(urls)]);
    });

    return modal;
}

function stageFromOverlay(modal) {
    const title = String(modal.find(".lf-src-title").val() ?? "").trim();
    const text = String(modal.find(".lf-src-text").val() ?? "");
    if (!text.trim()) {
        toastr.warning("Source text is empty — nothing to stage.", "Lorebook Forge");
        return;
    }
    let source;
    try {
        source = addSource({ title, text });
    } catch (err) {
        console.error(`[${extensionName}] Stage source failed:`, err);
        toastr.error(`Could not stage source: ${err.message}`, "Lorebook Forge");
        return;
    }
    renderDraftsList();
    // The overlay is NOT the wizard — ask the shell to refresh it via the event.
    document.getElementById("lf_studio_root")?.dispatchEvent(
        new CustomEvent("lf-sources-changed", { detail: { source } }));
    // Keep the overlay open for more crawling; lock staging until the next edit.
    modal.removeAttr("data-dirty");
    modal.find(".lf-overlay-stage").prop("disabled", true).html(`${icon("check", "lf-ic-sm")}Staged`);
    setStatus(`Source staged: "${source.title}"`);
    toastr.success(`Source staged: "${source.title}" — it is in the Sources rail.`, "Lorebook Forge");
}

function fillOverlay(modal, url, entry) {
    const { text, title, route, html, links } = entry;
    const kb = (text.length / 1024).toFixed(1);
    const wikiLinks = links || (html ? collectWikiLinks(html, url) : []);

    modal.attr("data-url", url);
    modal.attr("data-route", `${kb} KB · ${route}`);
    modal.find(".lf-src-title").val(title);
    modal.find(".lf-src-text").val(text);
    modal.find(".lf-src-route").text(`${kb} KB · ${route}`);
    updateTokenCounter(modal);
    renderLinksStrip(modal, wikiLinks);
    modal.find(".lf-cat-members").hide().empty();
    armStage(modal);
    setStatus(`Read "${title}" — ${kb} KB via ${route} · ${wikiLinks.length} wiki link(s)`);
}

// Load a URL into the overlay. `first` marks the very first load after the
// overlay was created — only then does a failure close the overlay.
async function loadIntoOverlay(url, first = false) {
    if (!overlayEl) return;
    const modal = overlayEl;
    const token = ++overlayToken; // any newer load invalidates this one

    modal.find(".lf-overlay-stage").prop("disabled", true);
    modal.find(".lf-src-route").text("Reading…");
    modal.removeAttr("data-dirty");
    setStatus(`Opening "${url}"…`);

    let entry;
    try {
        entry = pageCache.has(url) ? pageCache.get(url) : await fetchAndCache(url);
    } catch (err) {
        if (token !== overlayToken) return; // superseded / closed
        console.error(`[${extensionName}] Page read failed:`, err);
        toastr.error(`Could not read page: ${err.message}`, "Lorebook Forge");
        if (first) {
            closeReaderOverlay();
        } else {
            modal.find(".lf-src-route").text(modal.attr("data-route") || "");
            armStage(modal);
        }
        setStatus(`Read failed: ${err.message}`);
        return;
    }
    // Race guard: a newer load (or a close) superseded this response.
    if (token !== overlayToken || overlayEl !== modal) return;
    fillOverlay(modal, url, entry);
}

// Open a URL in the Reader overlay from anywhere (search "Read", a pasted URL,
// Canon Map clicks). The exported name is kept so graph.js needs no change.
export function openInReader(url) {
    const root = $("#lf_studio_root");
    if (!root.length) return Promise.resolve();
    let first = false;
    if (!overlayEl) {
        overlayEl = buildReaderOverlay().appendTo(root);
        root[0].style.setProperty("--lf-links-h", `${getSettings().readerLinksH || 120}px`);
        first = true;
    } else if (overlayEl.attr("data-dirty") &&
               !window.confirm("Discard your edits and open this page?")) {
        return Promise.resolve();
    }
    return loadIntoOverlay(url, first);
}

// The page cache itself — exported read-only for the graph pane.
export function getPageCache() {
    return pageCache;
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

async function onReadClick(event) {
    const btn = $(event.currentTarget);
    const resultEl = btn.closest(".lf-result");
    const url = resultEl.data("url");
    btn.prop("disabled", true).text("Loading…");
    try {
        await openInReader(url);
    } finally {
        btn.prop("disabled", false).text("Read");
    }
}

async function runSearch() {
    const query = String($("#lf_search_query").val()).trim();
    const resultsEl = $("#lf_search_results");
    if (!query) return;

    // A pasted URL opens the Reader overlay directly — no SearXNG round-trip,
    // and the existing results list is left untouched.
    const direct = parseDirectUrl(query);
    if (direct) {
        setStatus(`Opening ${direct}`);
        openInReader(direct);
        return;
    }

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
