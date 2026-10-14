// Lorebook Forge — entry point.
// NOTE: the Open Studio button is wired HERE, not in settings.js,
// to avoid a circular import (studio → research → settings → studio).
import { loadExtensionSettings } from "../../../extensions.js";
import { extensionName, extensionFolderPath } from "./src/config.js";
import { initSettings } from "./src/settings.js";
import { openStudio } from "./src/studio.js";

jQuery(async () => {
    console.log(`[${extensionName}] Loading...`);
    try {
        loadExtensionSettings(extensionName);
        const settingsHtml = await $.get(`${extensionFolderPath}/example.html`);
        $("#extensions_settings2").append(settingsHtml);

        initSettings();
        $("#lf_open_studio").on("click", openStudio);

        console.log(`[${extensionName}] ✅ Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] ❌ Failed to load:`, error);
    }
});
