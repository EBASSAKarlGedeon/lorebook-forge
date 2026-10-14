// Lorebook Forge — entry point.
// NOTE: the Open Studio button is wired HERE, not in settings.js,
// to avoid a circular import (studio → research → settings → studio).
import { loadExtensionSettings } from "../../../extensions.js";
import { eventSource, event_types } from "../../../../script.js";
import { extensionName, extensionFolderPath } from "./src/config.js";
import { initSettings } from "./src/settings.js";
import { openStudio } from "./src/studio.js";

// Entry point inside the native World Info editor: a hammer icon in the
// action row (#world_popup_bottom_holder — verified in ST's world-info.js:
// it holds #world_popup_new / #world_popup_export / #world_popup_delete /
// #world_duplicate as plain <div class="fa-solid fa-…" title="…"> icons).
function addWorldInfoButton() {
    if ($("#lf_world_button").length) return; // duplicate-mount guard
    const holder = $("#world_popup_bottom_holder");
    if (!holder.length) {
        console.warn(`[${extensionName}] #world_popup_bottom_holder not found — WI editor markup differs in this ST version. Paste its outerHTML (F12) so I can re-target.`);
        return;
    }
    const button = $(`
        <div id="lf_world_button" class="fa-solid fa-hammer"
             title="Lorebook Forge Studio — research, distill, commit"></div>
    `);
    holder.append(button);
    button.on("click", openStudio);
    console.log(`[${extensionName}] World Info editor button added`);
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

        // Safety net: if the WI editor mounts later than we do, retry once
        if (!$("#lf_world_button").length && event_types.APP_READY) {
            eventSource.once(event_types.APP_READY, addWorldInfoButton);
        }

        console.log(`[${extensionName}] ✅ Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] ❌ Failed to load:`, error);
    }
});
