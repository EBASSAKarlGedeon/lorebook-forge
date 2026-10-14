import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { defaultSettings, extensionName } from "./config.js";

export function getSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }
    return extension_settings[extensionName];
}

export function initSettings() {
    const settings = getSettings();

    const html = `
        <div class="lf-settings-block">
            <label class="lf-settings-label" for="lf_searxng_url">SearXNG base URL</label>
            <input id="lf_searxng_url" class="text_pole lf-text-input" type="text"
                   placeholder="http://localhost:8888"
                   value="${settings.searxngUrl}" />
            <div class="lf-settings-hint">Your self-hosted SearXNG instance (Docker). Used by web research. Default: http://localhost:8888</div>
        </div>
    `;
    $(".lorebook-forge-settings .inline-drawer-content").append(html);

    $("#lf_searxng_url").on("input", function () {
        settings.searxngUrl = String($(this).val()).trim();
        saveSettingsDebounced();
        console.debug(`[${extensionName}] searxngUrl = "${settings.searxngUrl}"`);
    });
}
