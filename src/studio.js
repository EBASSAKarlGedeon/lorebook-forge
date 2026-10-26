// The Studio overlay: full-screen workspace.
// Stage 25 layout (v1/v2 convergence): one header (brand + lorebook pill +
// workspace tabs + deck toggle + theme picker + export + close) over TWO
// full-bleed columns — ONE active center tab (Wizard, Proposals, Search,
// Map) | the Lorebook Deck (sources with their staged entries nested
// inside, batch commit, export). Web search lives in the Search tab header.
// Every pane owns a single full-height scroll region. Themes are
// CSS-variable presets switched via data-theme on the root, persisted in
// extension settings.
// Cross-module asks arrive as DOM events on the root (avoids circular
// imports): research.js → "lf-show-reader", wizard.js → "lf-show-center",
// "lf-show-sources" (focus the deck).
import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "./config.js";
import { icon } from "./helpers.js";
import { initResearch, getPageCache, closeReaderOverlay } from "./research.js";
import { renderDraftsList, initDraftsDeck } from "./drafts.js";
import { initWizard } from "./wizard.js";
import { renderGraph } from "./graph.js";

let studioRoot = null;
const railState = { research: true, drafts: true };

// Swatch = the preset's signature accent (shown in the picker)
const THEMES = [
    { id: "obsidian-cyber",   label: "Obsidian Cyber",   swatch: "#7aa2f7" },
    { id: "tavern-parchment", label: "Tavern Parchment", swatch: "#f59e0b" },
    { id: "neon-cyberpunk",   label: "Neon Cyberpunk",   swatch: "#ff007f" },
    { id: "royal-velvet",     label: "Royal Velvet",     swatch: "#c084fc" },
    { id: "emerald-codex",    label: "Emerald Codex",    swatch: "#10b981" },
    { id: "night-forge",      label: "Night Forge",      swatch: "#e08e3c" },
];

export function isStudioOpen() {
    return !!studioRoot;
}

// Esc peels one layer at a time: modal → theme menu → the Studio itself.
// The reader overlay guards unsaved edits and owns a running batch, so it is
// closed through closeReaderOverlay() rather than a bare DOM removal.
function onStudioEsc(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    const modal = studioRoot?.querySelector(".lf-modal-backdrop");
    if (modal) {
        if (modal.classList.contains("lf-reader-overlay")) {
            if (modal.hasAttribute("data-dirty") &&
                !window.confirm("Discard your edits and close the reader?")) return;
            closeReaderOverlay();
        } else {
            modal.remove();
        }
        return;
    }
    if (studioRoot?.querySelector(".lf-theme-menu.open")) return toggleThemeMenu(false);
    closeStudio();
}

export function closeStudio() {
    document.removeEventListener("keydown", onStudioEsc);
    document.removeEventListener("click", onOutsideClick);
    if (studioRoot) {
        studioRoot.remove();
        studioRoot = null;
        console.log(`[${extensionName}] Studio closed`);
    }
}

export function setStudioStatus(text) {
    if (studioRoot) {
        studioRoot.querySelector("#lf_studio_status").textContent = text;
    }
}

function toggleSidePanel(name, force) {
    if (!studioRoot) return;
    railState[name] = force ?? !railState[name];
    studioRoot.querySelector(`.lf-panel-${name}`).classList.toggle("lf-panel-hidden", !railState[name]);
    const btn = studioRoot.querySelector(`#lf_toggle_${name}`);
    btn.classList.toggle("active", railState[name]);
    btn.setAttribute("aria-pressed", String(railState[name]));
}

// ---- Deck focus: the wizard (and drafts) ask the deck to come forward ----
function focusDeck() {
    if (!studioRoot) return;
    toggleSidePanel("drafts", true);
    const body = studioRoot.querySelector(".lf-panel-drafts .lf-panel-body");
    if (body) body.scrollTo({ top: 0, behavior: "smooth" });
}

// ---- Theme engine ----
function applyTheme(id) {
    const theme = THEMES.find(t => t.id === id) || THEMES[0];
    studioRoot.dataset.theme = theme.id;
    studioRoot.querySelector("#lf_theme_label").textContent = theme.label;
    for (const item of studioRoot.querySelectorAll(".lf-theme-item")) {
        item.setAttribute("aria-checked", String(item.dataset.theme === theme.id));
    }
    return theme;
}

function toggleThemeMenu(open) {
    const menu = studioRoot?.querySelector(".lf-theme-menu");
    if (!menu) return;
    const on = open ?? !menu.classList.contains("open");
    menu.classList.toggle("open", on);
    studioRoot.querySelector("#lf_theme_btn").setAttribute("aria-expanded", String(on));
}

function onOutsideClick(e) {
    if (!e.target.closest?.(".lf-theme-picker")) toggleThemeMenu(false);
}

// ---- Center workspace tabs: radio behavior — exactly one pane visible ----
const CENTER_TABS = {
    wizard:    { pane: "#lf_wizard",         tab: "#lf_tab_wizard" },
    proposals: { pane: "#lf_proposals_pane", tab: "#lf_tab_proposals" },
    reader:    { pane: "#lf_reader_pane",     tab: "#lf_tab_reader" },
    // Fresh render every activation — the page cache may have grown since
    graph:     { pane: "#lf_graph_pane",      tab: "#lf_tab_graph", onShow: () => renderGraph(getPageCache()) },
};

function showCenter(name) {
    if (!studioRoot || !CENTER_TABS[name]) return;
    for (const [key, { pane, tab }] of Object.entries(CENTER_TABS)) {
        const on = key === name;
        studioRoot.querySelector(pane).classList.toggle("lf-hidden", !on);
        const tabEl = studioRoot.querySelector(tab);
        tabEl.classList.toggle("active", on);
        tabEl.setAttribute("aria-selected", String(on));
    }
    CENTER_TABS[name].onShow?.();
}

// Drag-to-resize the drafts panel; width persists in settings.
function initDraftsResizer() {
    const handle = studioRoot.querySelector("#lf_drafts_resize");
    handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        studioRoot.classList.add("lf-resizing");
        const onMove = (ev) => {
            // Panel is flush with the window's right edge (full-bleed columns)
            const width = Math.min(600, Math.max(260, window.innerWidth - ev.clientX));
            studioRoot.style.setProperty("--lf-drafts-w", `${Math.round(width)}px`);
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            studioRoot.classList.remove("lf-resizing");
            const s = extension_settings[extensionName];
            s.draftsPanelWidth = Math.round(parseFloat(studioRoot.style.getPropertyValue("--lf-drafts-w")) || 340);
            saveSettingsDebounced();
            console.log(`[${extensionName}] Drafts panel width saved: ${s.draftsPanelWidth}px`);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });
}

function buildStudio() {
    const el = document.createElement("div");
    el.id = "lf_studio_root";
    el.innerHTML = `
        <div class="lf-studio-page">
            <header class="lf-studio-header">
                <div class="lf-studio-title">
                    <span class="lf-studio-logo">${icon("hammer")}</span>
                    <span class="lf-studio-name">Lorebook Forge</span>
                    <span class="lf-studio-sub">Studio</span>
                </div>
                <button id="lf_book_pill" class="lf-book-pill" type="button" title="Update target — click to manage sources">
                    ${icon("book")}<span class="lf-book-pill-label">Lorebook</span>
                    <span id="lf_book_pill_name" class="lf-book-pill-name">none</span>
                    <span id="lf_book_pill_kb" class="lf-book-pill-kb"></span>
                </button>
                <nav class="lf-tabs" role="tablist">
                    <button id="lf_tab_wizard" class="lf-tab active" type="button" role="tab" aria-selected="true">${icon("wand")}Wizard</button>
                    <button id="lf_tab_proposals" class="lf-tab" type="button" role="tab" aria-selected="false">${icon("pull")}Proposals<span class="lf-tab-badge lf-hidden"></span></button>
                    <button id="lf_tab_reader" class="lf-tab" type="button" role="tab" aria-selected="false">${icon("search")}Search</button>
                    <button id="lf_tab_graph" class="lf-tab" type="button" role="tab" aria-selected="false">${icon("network")}Canon Map</button>
                </nav>
                <div class="lf-header-actions">
                    <div id="lf_context_chip" class="lf-context-chip lf-hidden" title="Token estimate of the active sources staged for the Wizard">
                        ${icon("database", "lf-ic-sm")}<span>Context: <strong class="lf-mono"></strong> tok</span>
                    </div>
                    <button id="lf_toggle_research" class="lf-icon-btn active" type="button" aria-pressed="true" title="Toggle Canon Research & Sources rail">${icon("panelLeft")}</button>
                    <button id="lf_toggle_drafts" class="lf-icon-btn active" type="button" aria-pressed="true" title="Toggle Lorebook Deck">${icon("panelRight")}</button>
                    <div class="lf-theme-picker">
                        <button id="lf_theme_btn" class="lf-ghost-btn" type="button" aria-haspopup="menu" aria-expanded="false">
                            ${icon("palette")}<span id="lf_theme_label"></span>${icon("chevron", "lf-ic-sm")}
                        </button>
                        <div class="lf-theme-menu" role="menu">
                            <div class="lf-theme-menu-label">Studio themes</div>
                            ${THEMES.map(t => `
                                <button class="lf-theme-item" type="button" role="menuitemradio" aria-checked="false" data-theme="${t.id}">
                                    <span class="lf-theme-swatch" style="--sw:${t.swatch}"></span>${t.label}${icon("check", "lf-theme-check")}
                                </button>`).join("")}
                        </div>
                    </div>
                    <button class="lf-ghost-btn lf-export-json" type="button" title="Download staged drafts as a SillyTavern lorebook (.json)">${icon("download")}Export JSON</button>
                    <button id="lf_settings_gear" class="lf-icon-btn" type="button" title="Open Lorebook Forge settings in the Extensions panel">${icon("gear")}</button>
                    <button class="lf-studio-close lf-icon-btn" type="button" title="Close (Esc)">${icon("x")}</button>
                </div>
            </header>
            <div class="lf-studio-main">
                <aside class="lf-panel lf-panel-research">
                    <div class="lf-panel-header">
                        ${icon("compass", "lf-ic-accent")}<span>Canon Research &amp; Sources</span>
                        <button class="lf-icon-btn lf-panel-collapse" type="button" data-panel="research" title="Collapse">${icon("panelLeftClose")}</button>
                    </div>
                    <div class="lf-rail-search">
                        <div class="lf-search-field">
                            ${icon("search")}
                            <input id="lf_rail_search" class="text_pole lf-text-input" type="text" placeholder="Search the web, or paste a URL…" autocomplete="off" />
                            <button id="lf_rail_search_go" class="lf-rail-go" type="button" title="Search with the Reader">Go</button>
                        </div>
                        <div class="lf-rail-filters">
                            <span class="lf-rail-filters-label">Quick Filters:</span>
                            <button class="lf-rail-filter" type="button" data-filter="magic" title="Sources matching magic / law">Magic Laws</button>
                            <button class="lf-rail-filter" type="button" data-filter="chars" title="Sources matching char / person">Characters</button>
                            <button class="lf-rail-filter" type="button" data-filter="relics" title="Sources matching relic / artifact / item">Relics</button>
                        </div>
                    </div>
                    <div class="lf-rail-body">
                        <div class="lf-rail-sources-head">
                            <span>Active Context Sources (<span id="lf_rail_count">0</span>)</span>
                            <button id="lf_rail_addsource" class="lf-rail-add" type="button">${icon("plus", "lf-ic-sm")}Add Source</button>
                        </div>
                        <div id="lf_rail_sources" class="lf-rail-sources"></div>
                    </div>
                    <div class="lf-rail-footer">
                        <div class="lf-recon-row">
                            <span>Reconciliation Status</span>
                            <span id="lf_recon_value" class="lf-recon-value">—</span>
                        </div>
                        <div class="lf-recon-track"><div id="lf_recon_bar" class="lf-recon-fill"></div></div>
                        <div class="lf-recon-line">${icon("sparkles", "lf-ic-sm")}<span id="lf_recon_text">No key conflicts detected in active sources.</span></div>
                    </div>
                </aside>
                <section class="lf-center">
                    <div id="lf_wizard" class="lf-pane lf-wizard"></div>
                    <section id="lf_proposals_pane" class="lf-pane lf-proposals-pane lf-hidden">
                        <div class="lf-pane-header">
                            <span class="lf-tile">${icon("pull")}</span>
                            <span class="lf-pane-title">Proposals</span>
                            <span id="lf_proposals_count" class="lf-chip"></span>
                            <span class="lf-pane-hint">Every card carries an evidence quote, checked against this session's chat and sources.</span>
                        </div>
                        <div id="lf_grounding" class="lf-grounding lf-grounding-pane"></div>
                        <div id="lf_proposals_scroll" class="lf-proposals-scroll">
                            <div id="lf_proposals" class="lf-proposal-grid"></div>
                        </div>
                    </section>
                    <section class="lf-pane lf-reader-pane lf-hidden" id="lf_reader_pane">
                        <div class="lf-pane-header">
                            <span class="lf-tile">${icon("search")}</span>
                            <span class="lf-pane-title">Search</span>
                            <div class="lf-search-row lf-reader-search">
                                <span class="lf-search-field">
                                    ${icon("search")}
                                    <input id="lf_search_query" class="text_pole lf-text-input" type="text" placeholder="Search the web, or paste a URL…" autocomplete="off" />
                                </span>
                                <button id="lf_search_btn" class="menu_button" type="button">Go</button>
                            </div>
                        </div>
                        <div class="lf-reader-col">
                            <div id="lf_search_results" class="lf-search-results"></div>
                            <div class="lf-reader-empty">
                                <div class="lf-reader-empty-icon">📖</div>
                                <h3>Search</h3>
                                <p>Search the web or paste a URL.<br>Read opens the page in an overlay.</p>
                            </div>
                        </div>
                    </section>
                    <div class="lf-pane lf-graph-pane lf-hidden" id="lf_graph_pane">
                        <div id="lf_graph"></div>
                    </div>
                </section>
                <aside class="lf-panel lf-panel-drafts">
                    <div id="lf_drafts_resize" class="lf-drafts-resize" title="Drag to resize"></div>
                    <div class="lf-panel-header">
                        ${icon("layers", "lf-ic-accent2")}<span>Lorebook Deck</span>
                        <span id="lf_drafts_count" class="lf-count"></span>
                        <button class="lf-icon-btn lf-panel-collapse" type="button" data-panel="drafts" title="Collapse">${icon("panelRight")}</button>
                    </div>
                    <div class="lf-deck-toolbar">
                        <button class="lf-ghost-btn lf-deck-addsource" type="button">${icon("plus", "lf-ic-sm")}Add source</button>
                        <button class="lf-ghost-btn lf-deck-import" type="button">${icon("download", "lf-ic-sm")}Import lorebook</button>
                        <button class="lf-ghost-btn lf-deck-canon" type="button">${icon("compare", "lf-ic-sm")}Canon rules</button>
                    </div>
                    <div id="lf_deck_addsource" class="lf-deck-form" style="display:none;"></div>
                    <div id="lf_deck_import" class="lf-deck-form" style="display:none;"></div>
                    <div id="lf_deck_canon" class="lf-deck-form" style="display:none;"></div>
                    <div class="lf-batchbar">
                        <label class="lf-batch-all"><input id="lf_drafts_all" type="checkbox" /> Select all</label>
                        <span id="lf_drafts_selected" class="lf-batch-count"></span>
                        <button id="lf_batch_commit" class="menu_button lf-btn-good" type="button" title="Commit every ticked draft to one lorebook">${icon("checks")}Commit selected</button>
                    </div>
                    <div id="lf_batch_form" class="lf-commit-form lf-batch-form" style="display:none;"></div>
                    <div class="lf-panel-body">
                        <div id="lf_drafts_list" class="lf-drafts-list"></div>
                    </div>
                    <div class="lf-panel-footer">
                        <button class="menu_button lf-btn-primary lf-export-json" type="button">${icon("download")}Export staged → JSON</button>
                    </div>
                </aside>
            </div>
            <footer class="lf-studio-statusbar">
                <span class="lf-status-dot"></span>
                <span id="lf_studio_status">Ready — scrape the web in the Reader; agreed Wizard entries land in Entries.</span>
            </footer>
        </div>
    `;

    el.querySelector(".lf-studio-close").addEventListener("click", closeStudio);
    for (const name of Object.keys(CENTER_TABS)) {
        el.querySelector(CENTER_TABS[name].tab).addEventListener("click", () => showCenter(name));
    }
    el.querySelector("#lf_toggle_drafts").addEventListener("click", () => toggleSidePanel("drafts"));
    el.querySelector("#lf_toggle_research").addEventListener("click", () => toggleSidePanel("research"));
    // v1 settings gear: jump to this extension's drawer in the Extensions
    // panel and open it. If the panel isn't mounted, say so and stay here.
    el.querySelector("#lf_settings_gear").addEventListener("click", () => {
        const drawer = document.querySelector("#extensions_settings2 .lorebook-forge-settings, #extensions_settings .lorebook-forge-settings");
        if (!drawer) {
            toastr.info("The Extensions panel isn't mounted — open it from the ST extensions menu, then use the gear again.", "Lorebook Forge");
            return;
        }
        const toggle = drawer.querySelector(".inline-drawer-toggle");
        if (toggle) $(toggle).trigger("click");
        drawer.scrollIntoView({ behavior: "smooth" });
        closeStudio();
    });
    for (const btn of el.querySelectorAll(".lf-panel-collapse")) {
        btn.addEventListener("click", () => toggleSidePanel(btn.dataset.panel, false));
    }
    el.querySelector("#lf_book_pill").addEventListener("click", focusDeck);

    el.querySelector("#lf_theme_btn").addEventListener("click", () => toggleThemeMenu());
    for (const item of el.querySelectorAll(".lf-theme-item")) {
        item.addEventListener("click", () => {
            const theme = applyTheme(item.dataset.theme);
            extension_settings[extensionName].theme = theme.id;
            saveSettingsDebounced();
            toggleThemeMenu(false);
            setStudioStatus(`Theme: ${theme.label}`);
        });
    }

    // research.js asks for the Reader tab; wizard.js and drafts.js ask for
    // the deck — native DOM events on the root (no circular imports).
    el.addEventListener("lf-show-reader", () => showCenter("reader"));
    el.addEventListener("lf-show-center", (e) => showCenter(e.detail));
    el.addEventListener("lf-show-sources", focusDeck);

    return el;
}

export function openStudio() {
    if (studioRoot) return;
    studioRoot = buildStudio();
    document.body.appendChild(studioRoot);

    // Restore persisted panel width + theme (older settings lack `theme`)
    const s = extension_settings[extensionName];
    studioRoot.style.setProperty("--lf-drafts-w", `${Number(s.draftsPanelWidth) || 340}px`);
    applyTheme(s.theme);

    // Restore the panels the user collapsed before closing (railState
    // persists across Studio reopen within the session)
    for (const name of Object.keys(railState)) {
        if (!railState[name]) toggleSidePanel(name, false);
    }

    initResearch();        // wires search + the reader overlay (fresh DOM each open)
    initDraftsDeck();      // batch bar + export (fresh DOM each open)
    renderDraftsList();    // drafts into the panel
    initWizard();          // wizard + sources + proposals (fresh DOM each open)
    initDraftsResizer();   // drag handle on the drafts panel

    document.addEventListener("keydown", onStudioEsc);
    document.addEventListener("click", onOutsideClick);
    console.log(`[${extensionName}] Studio opened`);
}
