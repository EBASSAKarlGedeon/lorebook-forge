// The Studio overlay: full-screen workspace.
// Stage 24 layout (v2): one header (brand + lorebook pill + workspace tabs +
// panel toggles + theme picker + export + close) over three full-bleed
// columns — Research & Sources | ONE active center tab (Wizard, Proposals,
// Reader, Map) | Staging & Draft Deck. Every pane owns a single
// full-height scroll region. Themes are CSS-variable presets switched via
// data-theme on the root, persisted in extension settings.
// Cross-module asks arrive as DOM events on the root (avoids circular
// imports): research.js → "lf-show-reader", wizard.js → "lf-show-center",
// "lf-show-sources".
import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "./config.js";
import { icon } from "./helpers.js";
import { initResearch, getPageCache } from "./research.js";
import { renderDraftsList, initDraftsDeck } from "./drafts.js";
import { initDistiller } from "./distiller.js";
import { initWizard } from "./wizard.js";
import { renderGraph } from "./graph.js";

let studioRoot = null;
const railState = { search: true, drafts: true };

// Swatch = the preset's signature accent (shown in the picker)
const THEMES = [
    { id: "obsidian-cyber",   label: "Obsidian Cyber",   swatch: "#7aa2f7" },
    { id: "tavern-parchment", label: "Tavern Parchment", swatch: "#a4471a" },
    { id: "neon-cyberpunk",   label: "Neon Cyberpunk",   swatch: "#ff2a8a" },
    { id: "royal-velvet",     label: "Royal Velvet",     swatch: "#e2b84b" },
    { id: "emerald-codex",    label: "Emerald Codex",    swatch: "#2fd08f" },
    { id: "night-forge",      label: "Night Forge",      swatch: "#e08e3c" },
];

export function isStudioOpen() {
    return !!studioRoot;
}

// Esc peels one layer at a time: modal → theme menu → the Studio itself
function onStudioEsc(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    const modal = studioRoot?.querySelector(".lf-modal-backdrop");
    if (modal) return modal.remove();
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

// ---- Left panel sub-tabs: Web search / Sources & Canon ----
function showLeftTab(name) {
    if (!studioRoot) return;
    toggleSidePanel("search", true);
    for (const btn of studioRoot.querySelectorAll(".lf-subtab")) {
        const on = btn.dataset.sub === name;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-selected", String(on));
    }
    for (const body of studioRoot.querySelectorAll(".lf-panel-search [data-subpane]")) {
        body.classList.toggle("lf-hidden", body.dataset.subpane !== name);
    }
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
                </button>
                <nav class="lf-tabs" role="tablist">
                    <button id="lf_tab_wizard" class="lf-tab active" type="button" role="tab" aria-selected="true">${icon("wand")}Wizard</button>
                    <button id="lf_tab_proposals" class="lf-tab" type="button" role="tab" aria-selected="false">${icon("pull")}Proposals<span class="lf-tab-badge lf-hidden"></span></button>
                    <button id="lf_tab_reader" class="lf-tab" type="button" role="tab" aria-selected="false">${icon("book")}Reader</button>
                    <button id="lf_tab_graph" class="lf-tab" type="button" role="tab" aria-selected="false">${icon("network")}Canon Map</button>
                </nav>
                <div class="lf-header-actions">
                    <button id="lf_toggle_search" class="lf-icon-btn active" type="button" aria-pressed="true" title="Toggle research panel">${icon("panelLeft")}</button>
                    <button id="lf_toggle_drafts" class="lf-icon-btn active" type="button" aria-pressed="true" title="Toggle draft deck">${icon("panelRight")}</button>
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
                    <button class="lf-studio-close lf-icon-btn" type="button" title="Close (Esc)">${icon("x")}</button>
                </div>
            </header>
            <div class="lf-studio-main">
                <aside class="lf-panel lf-panel-search">
                    <div class="lf-panel-header">
                        ${icon("compass", "lf-ic-accent")}<span>Canon Research &amp; Sources</span>
                        <button class="lf-icon-btn lf-panel-collapse" type="button" data-panel="search" title="Collapse">${icon("panelLeft")}</button>
                    </div>
                    <div class="lf-subtabs" role="tablist">
                        <button class="lf-subtab active" type="button" role="tab" aria-selected="true" data-sub="web">${icon("search")}Web</button>
                        <button class="lf-subtab" type="button" role="tab" aria-selected="false" data-sub="sources">${icon("layers")}Sources<span id="lf_sources_count" class="lf-count"></span></button>
                    </div>
                    <div class="lf-panel-body" data-subpane="web">
                        <div class="lf-search-row">
                            <span class="lf-search-field">
                                ${icon("search")}
                                <input id="lf_search_query" class="text_pole lf-text-input" type="text" placeholder="Search web, wikis, fandoms…" autocomplete="off" />
                            </span>
                            <button id="lf_search_btn" class="menu_button" type="button">Go</button>
                        </div>
                        <div id="lf_search_results" class="lf-search-results"></div>
                    </div>
                    <div id="lf_sources" class="lf-panel-body lf-sources-pane lf-hidden" data-subpane="sources"></div>
                    <div id="lf_grounding" class="lf-grounding"></div>
                </aside>
                <section class="lf-center">
                    <div id="lf_wizard" class="lf-pane lf-wizard"></div>
                    <section id="lf_proposals_pane" class="lf-pane lf-proposals-pane lf-hidden">
                        <div class="lf-pane-header">
                            <span class="lf-tile">${icon("pull")}</span>
                            <span class="lf-pane-title">Proposals</span>
                            <span id="lf_proposals_count" class="lf-chip"></span>
                            <span class="lf-pane-hint">Every card carries an evidence quote, verified against this session's sources.</span>
                        </div>
                        <div id="lf_proposals_scroll" class="lf-proposals-scroll">
                            <div id="lf_proposals" class="lf-proposal-grid"></div>
                        </div>
                    </section>
                    <div class="lf-pane lf-reader-pane lf-hidden" id="lf_reader_pane">
                        <div id="lf_reader">
                            <div class="lf-reader-empty">
                                <div class="lf-reader-empty-icon">📖</div>
                                <h3>Reader</h3>
                                <p>Search in the Research panel, then click "Read" on a result.<br>Page content appears here, ready to become a draft.</p>
                            </div>
                        </div>
                    </div>
                    <div class="lf-pane lf-graph-pane lf-hidden" id="lf_graph_pane">
                        <div id="lf_graph"></div>
                    </div>
                </section>
                <aside class="lf-panel lf-panel-drafts">
                    <div id="lf_drafts_resize" class="lf-drafts-resize" title="Drag to resize"></div>
                    <div class="lf-panel-header">
                        ${icon("layers", "lf-ic-accent2")}<span>Staging &amp; Draft Deck</span>
                        <span id="lf_drafts_count" class="lf-count"></span>
                        <button class="lf-icon-btn lf-panel-collapse" type="button" data-panel="drafts" title="Collapse">${icon("panelRight")}</button>
                    </div>
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
                <span id="lf_studio_status">Ready — paste sources into the Wizard, or research the web.</span>
            </footer>
        </div>
    `;

    el.querySelector(".lf-studio-close").addEventListener("click", closeStudio);
    for (const name of Object.keys(CENTER_TABS)) {
        el.querySelector(CENTER_TABS[name].tab).addEventListener("click", () => showCenter(name));
    }
    el.querySelector("#lf_toggle_search").addEventListener("click", () => toggleSidePanel("search"));
    el.querySelector("#lf_toggle_drafts").addEventListener("click", () => toggleSidePanel("drafts"));
    for (const btn of el.querySelectorAll(".lf-panel-collapse")) {
        btn.addEventListener("click", () => toggleSidePanel(btn.dataset.panel, false));
    }
    for (const btn of el.querySelectorAll(".lf-subtab")) {
        btn.addEventListener("click", () => showLeftTab(btn.dataset.sub));
    }
    el.querySelector("#lf_book_pill").addEventListener("click", () => showLeftTab("sources"));

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

    // research.js asks for the Reader tab, wizard.js for a center tab or the
    // Sources sub-tab — native DOM events on the root (no circular imports).
    el.addEventListener("lf-show-reader", () => showCenter("reader"));
    el.addEventListener("lf-show-center", (e) => showCenter(e.detail));
    el.addEventListener("lf-show-sources", () => showLeftTab("sources"));

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

    initResearch();        // wires search + reader (fresh DOM each open)
    initDraftsDeck();      // batch bar + export (fresh DOM each open)
    renderDraftsList();    // drafts into the panel
    initDistiller();       // distill bar (guarded against duplicates)
    initWizard();          // wizard + sources + proposals (fresh DOM each open)
    initDraftsResizer();   // drag handle on the drafts panel

    document.addEventListener("keydown", onStudioEsc);
    document.addEventListener("click", onOutsideClick);
    console.log(`[${extensionName}] Studio opened`);
}
