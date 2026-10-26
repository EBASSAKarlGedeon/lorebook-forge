// Lorebook Forge — entry point.
// NOTE: the Open Studio button is wired HERE, not in settings.js,
// to avoid a circular import (studio → research → settings → studio).
import { loadExtensionSettings } from "../../../extensions.js";
import { eventSource, event_types } from "../../../../script.js";
import { extensionName, extensionFolderPath } from "./src/config.js";
import { initSettings } from "./src/settings.js";
import { openStudio } from "./src/studio.js";

// Entry point in the native Worlds/Lorebooks panel header: a hammer icon
// right before the "?" docs link. Target verified from the user's pasted
// DOM: #WorldInfo > h3.margin0 > a.notes-link (fa-circle-question).
function addWorldInfoButton() {
    if ($("#lf_world_button").length) return; // duplicate-mount guard
    const anchor = $("#WorldInfo h3 a.notes-link");
    if (!anchor.length) {
        console.warn(`[${extensionName}] Worlds/Lorebooks header link not found — markup differs in this ST version.`);
        return;
    }
    const button = $(`
        <div id="lf_world_button" class="fa-solid fa-hammer interactable" tabindex="0" role="button"
             title="Lorebook Forge Studio — research, entries, commit"></div>
    `);
    anchor.before(button);
    button.on("click", openStudio);
    console.log(`[${extensionName}] World Info header button added (before the ? link)`);
}

jQuery(async () => {
    console.log(`[${extensionName}] Loading...`);
    try {
        loadExtensionSettings(extensionName);
        const settingsHtml = await $.get(`${extensionFolderPath}/example.html`);
        $("#extensions_settings2").append(settingsHtml);

        initSettings();
        $("#lf_open_studio").on("click", openStudio);
        addWorldInfoButton();

        // Safety net: if the panel mounts later than we do, retry once
        if (!$("#lf_world_button").length && event_types.APP_READY) {
            eventSource.once(event_types.APP_READY, addWorldInfoButton);
        }

        console.log(`[${extensionName}] ✅ Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] ❌ Failed to load:`, error);
    }
});
