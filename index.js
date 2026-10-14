import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "lorebook-forge"; // ⚠️ MUST match folder name exactly
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

jQuery(async () => {
    console.log(`[${extensionName}] Loading...`);
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/example.html`);
        $("#extensions_settings2").append(settingsHtml);
        loadExtensionSettings(extensionName);
        console.log(`[${extensionName}] ✅ Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] ❌ Failed to load:`, error);
    }
});
