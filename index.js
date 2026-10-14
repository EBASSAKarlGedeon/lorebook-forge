import { loadExtensionSettings } from "../../../extensions.js";
import { extensionName, extensionFolderPath } from "./src/config.js";
import { initSettings } from "./src/settings.js";

jQuery(async () => {
    console.log(`[${extensionName}] Loading...`);
    try {
        loadExtensionSettings(extensionName);
        const settingsHtml = await $.get(`${extensionFolderPath}/example.html`);
        $("#extensions_settings2").append(settingsHtml);
        initSettings();
        console.log(`[${extensionName}] ✅ Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] ❌ Failed to load:`, error);
    }
});
