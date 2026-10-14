// The Studio overlay: full-screen workspace.
// Layout: header / [rail | search panel | center (wizard | reader) | drafts panel] / status bar.
// Center panes are INDEPENDENT toggles (wand = Wizard, book = Reader),
// like the side panels. Reading a search result auto-shows the Reader
// (research.js asks via the "lf-show-reader" DOM event — avoids a
// circular studio→research→studio import).
import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "./config.js";
import { initResearch } from "./research.js";
import { renderDraftsList } from "./drafts.js";
import { initDistiller } from "./distiller.js";
import { initWizard } from "./wizard.js";

let studioRoot = null;
const railState = { search: true, drafts: true, wizard: true, reader: false };

export function isStudioOpen() {
    return !!studioRoot;
}

function onStudioEsc(e) {
    if (e.key === "Escape") {
        e.preventDefault();
        closeStudio();
    }
}

export function closeStudio() {
    document.removeEventListener("keydown", onStudioEsc);
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

function toggleSidePanel(name) {
    if (!studioRoot) return;
    railState[name] = !railState[name];
    studioRoot.querySelector(`.lf-panel-${name}`).classList.toggle("lf-panel-hidden", !railState[name]);
    studioRoot.querySelector(`#lf_rail_${name}`).classList.toggle("active", railState[name]);
}

const CENTER_PANES = {
    wizard: { pane: "#lf_wizard", button: "#lf_rail_wizard" },
    reader: { pane: "#lf_reader_pane", button: "#lf_rail_reader" },
};

function toggleCenter(name) {
    if (!studioRoot) return;
    railState[name] = !railState[name];
    const { pane, button } = CENTER_PANES[name];
    studioRoot.querySelector(pane).classList.toggle("lf-hidden", !railState[name]);
    studioRoot.querySelector(button).classList.toggle("active", railState[name]);
    updateCenterEmpty();
}

// Tiny hint when BOTH center panes are toggled off
function updateCenterEmpty() {
    const anyVisible = railState.wizard || railState.reader;
    studioRoot.querySelector("#lf_center_empty")?.classList.toggle("lf-hidden", anyVisible);
}

// research.js fired "lf-show-reader" — make sure the Reader is visible
function onShowReader() {
    if (!railState.reader) toggleCenter("reader");
}

// Drag-to-resize the drafts panel; width persists in settings.
function initDraftsResizer() {
    const handle = studioRoot.querySelector("#lf_drafts_resize");
    handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        studioRoot.classList.add("lf-resizing");
        const onMove = (ev) => {
            // Panel's right edge sits ~14px from the window edge (main padding)
            const width = Math.min(560, Math.max(240, window.innerWidth - ev.clientX - 14));
            studioRoot.style.setProperty("--lf-drafts-w", `${Math.round(width)}px`);
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            studioRoot.classList.remove("lf-resizing");
            const s = extension_settings[extensionName];
            s.draftsPanelWidth = Math.round(parseFloat(studioRoot.style.getPropertyValue("--lf-drafts-w")) || 300);
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
                    <span class="lf-studio-logo">⚒️</span>
                    <span class="lf-studio-name">Lorebook Forge</span>
                    <span class="lf-studio-sub">Studio</span>
                </div>
                <button class="lf-studio-close" type="button" title="Close (Esc)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </header>
            <div class="lf-studio-main">
                <nav class="lf-rail">
                    <div class="lf-rail-brand" title="Lorebook Forge">LF</div>
                    <button id="lf_rail_wizard" class="lf-rail-btn active" type="button" title="Toggle Lorebook Wizard">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21l9-9"/><path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8L19 13"/><path d="M15 9h.01"/></svg>
                    </button>
                    <button id="lf_rail_reader" class="lf-rail-btn" type="button" title="Toggle Reader">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
                    </button>
                    <button id="lf_rail_search" class="lf-rail-btn active" type="button" title="Toggle research panel">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    </button>
                    <button id="lf_rail_drafts" class="lf-rail-btn active" type="button" title="Toggle drafts panel">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                    </button>
                    <div class="lf-rail-sep"></div>
                    <button id="lf_rail_distill" class="lf-rail-btn" type="button" title="Distill selected sources with AI">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z"/></svg>
                    </button>
                </nav>
                <section class="lf-panel lf-panel-search">
                    <div class="lf-panel-header">Research</div>
                    <div class="lf-panel-body">
                        <div class="lf-search-row">
                            <input id="lf_search_query" class="text_pole lf-text-input" type="text" placeholder="Search the web…" autocomplete="off" />
                            <button id="lf_search_btn" class="menu_button" type="button">Go</button>
                        </div>
                        <div id="lf_search_results" class="lf-search-results"></div>
                    </div>
                </section>
                <section class="lf-center">
                    <div id="lf_wizard" class="lf-wizard"></div>
                    <div class="lf-reader-pane lf-hidden" id="lf_reader_pane">
                        <div id="lf_reader">
                            <div class="lf-reader-empty">
                                <div class="lf-reader-empty-icon">📖</div>
                                <h3>Reader</h3>
                                <p>Search in the Research panel, then click "Read" on a result.<br>Page content appears here, ready to become a draft.</p>
                            </div>
                        </div>
                    </div>
                    <div id="lf_center_empty" class="lf-center-empty lf-hidden">
                        <div class="lf-reader-empty-icon">🧭</div>
                        <h3>Nothing here</h3>
                        <p>Toggle the Wizard (wand) or Reader (book) from the rail.</p>
                    </div>
                </section>
                <section class="lf-panel lf-panel-drafts">
                    <div id="lf_drafts_resize" class="lf-drafts-resize" title="Drag to resize"></div>
                    <div class="lf-panel-header">Drafts</div>
                    <div class="lf-panel-body">
                        <div id="lf_drafts_list" class="lf-drafts-list"></div>
                    </div>
                </section>
            </div>
            <footer class="lf-studio-statusbar">
                <span id="lf_studio_status">Ready — paste sources into the Wizard, or research the web.</span>
            </footer>
        </div>
    `;

    el.querySelector(".lf-studio-close").addEventListener("click", closeStudio);
    el.querySelector("#lf_rail_wizard").addEventListener("click", () => toggleCenter("wizard"));
    el.querySelector("#lf_rail_reader").addEventListener("click", () => toggleCenter("reader"));
    el.querySelector("#lf_rail_search").addEventListener("click", () => toggleSidePanel("search"));
    el.querySelector("#lf_rail_drafts").addEventListener("click", () => toggleSidePanel("drafts"));
    el.querySelector("#lf_rail_distill").addEventListener("click", () => {
        if (!railState.drafts) toggleSidePanel("drafts");
        const topic = el.querySelector("#lf_distill_bar .lf-distill-topic");
        if (topic) topic.focus();
        else toastr.info("Drafts panel not ready yet.", "Lorebook Forge");
    });
    // research.js asks for the reader via a native DOM event on the root
    el.addEventListener("lf-show-reader", onShowReader);

    return el;
}

export function openStudio() {
    if (studioRoot) return;
    studioRoot = buildStudio();
    document.body.appendChild(studioRoot);

    // Restore persisted drafts panel width
    const s = extension_settings[extensionName];
    studioRoot.style.setProperty("--lf-drafts-w", `${Number(s.draftsPanelWidth) || 300}px`);

    initResearch();        // wires search + reader (fresh DOM each open)
    renderDraftsList();    // drafts into the panel
    initDistiller();       // distill bar (guarded against duplicates)
    initWizard();          // wizard center pane
    initDraftsResizer();   // drag handle on the drafts panel

    document.addEventListener("keydown", onStudioEsc);
    console.log(`[${extensionName}] Studio opened`);
}
