// The Studio overlay: full-screen workspace shell.
// Stage 9 = shell only. Later stages migrate research/drafts/graph into it.
import { extensionName } from "./config.js";

let studioRoot = null; // this module OWNS the overlay element ref

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

export function openStudio() {
    if (studioRoot) return;
    studioRoot = document.createElement("div");
    studioRoot.id = "lf_studio_root";
    studioRoot.innerHTML = `
        <div class="lf-studio-header">
            <div class="lf-studio-title">
                <span class="lf-studio-logo">⚒️</span>
                <span class="lf-studio-name">Lorebook Forge</span>
                <span class="lf-studio-sub">Studio</span>
            </div>
            <button class="lf-studio-close" type="button" title="Close (Esc)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
        <div class="lf-studio-body">
            <div class="lf-studio-placeholder">
                <div class="lf-studio-placeholder-icon">🗺️</div>
                <h3>The Studio</h3>
                <p>The research workspace, entry editor and lorebook map will live here.<br>Next stages move them in, one at a time.</p>
            </div>
        </div>
    `;
    document.body.appendChild(studioRoot);
    studioRoot.querySelector(".lf-studio-close").addEventListener("click", closeStudio);
    document.addEventListener("keydown", onStudioEsc);
    console.log(`[${extensionName}] Studio opened`);
}
