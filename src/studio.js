// The Studio overlay: full-screen research workspace.
// Layout: header / [icon rail | research panel | reader | drafts panel] / status bar.
import { extensionName } from "./config.js";
import { initResearch } from "./research.js";
import { renderDraftsList } from "./drafts.js";
import { initDistiller } from "./distiller.js";

let studioRoot = null;
const railState = { search: true, drafts: true };

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

function togglePanel(name) {
    if (!studioRoot) return;
    railState[name] = !railState[name];
    studioRoot.querySelector(`.lf-panel-${name}`).classList.toggle("lf-panel-hidden", !railState[name]);
    studioRoot.querySelector(`#lf_rail_${name}`).classList.toggle("active", railState[name]);
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
                <section class="lf-reader-pane">
                    <div id="lf_reader">
                        <div class="lf-reader-empty">
                            <div class="lf-reader-empty-icon">📖</div>
                            <h3>Reader</h3>
                            <p>Search in the Research panel, then click "Read" on a result.<br>Page content appears here, ready to become a draft.</p>
                        </div>
                    </div>
                </section>
                <section class="lf-panel lf-panel-drafts">
                    <div class="lf-panel-header">Drafts</div>
                    <div class="lf-panel-body">
                        <div id="lf_drafts_list" class="lf-drafts-list"></div>
                    </div>
                </section>
            </div>
            <footer class="lf-studio-statusbar">
                <span id="lf_studio_status">Ready — search, read, draft, distill, commit.</span>
            </footer>
        </div>
    `;

    el.querySelector(".lf-studio-close").addEventListener("click", closeStudio);
    el.querySelector("#lf_rail_search").addEventListener("click", () => togglePanel("search"));
    el.querySelector("#lf_rail_drafts").addEventListener("click", () => togglePanel("drafts"));
    el.querySelector("#lf_rail_distill").addEventListener("click", () => {
        if (!railState.drafts) togglePanel("drafts");
        const topic = el.querySelector("#lf_distill_bar .lf-distill-topic");
        if (topic) topic.focus();
        else toastr.info("Drafts panel not ready yet.", "Lorebook Forge");
    });

    return el;
}

export function openStudio() {
    if (studioRoot) return;
    studioRoot = buildStudio();
    document.body.appendChild(studioRoot);

    initResearch();        // wires search + reader (fresh DOM each open)
    renderDraftsList();    // drafts into the panel
    initDistiller();       // distill bar (guarded against duplicates)

    document.addEventListener("keydown", onStudioEsc);
    console.log(`[${extensionName}] Studio opened`);
}
