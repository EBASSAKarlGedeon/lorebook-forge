// Drawer settings (Extensions panel): Studio launcher + SearXNG config.
// The research workspace itself lives in the Studio overlay (studio.js).
import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { defaultSettings, extensionName } from "./config.js";
import { testSearxngConnection } from "./searchData.js";
import { clampContextTokens } from "./helpers.js";

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
            <button id="lf_open_studio" class="menu_button" type="button">⚒️ Open Lorebook Forge Studio</button>
        </div>
        <div class="lf-settings-block">
            <label class="lf-settings-label" for="lf_searxng_url">SearXNG base URL</label>
            <input id="lf_searxng_url" class="text_pole lf-text-input" type="text"
                   placeholder="http://localhost:8888"
                   value="${settings.searxngUrl}" />
            <div class="lf-settings-hint">Your self-hosted SearXNG instance (Docker). Used by web research. Default: http://localhost:8888</div>
        </div>
        <div class="lf-settings-block">
            <label class="lf-settings-label" for="lf_chat_context_tokens">Wizard chat context (tokens)</label>
            <input id="lf_chat_context_tokens" class="text_pole lf-text-input" type="number"
                   min="2000" max="1000000" step="1000"
                   value="${clampContextTokens(settings.chatContextTokens)}" />
            <div class="lf-settings-hint">How much of the wizard conversation is sent with each reply (about 4 characters per token). Older messages are never deleted: raising this brings them back. Default: 64000.</div>
        </div>
        <div class="lf-settings-block">
            <button id="lf_test_connection" class="menu_button" type="button">Test SearXNG connection</button>
        </div>
    `;
    $(".lorebook-forge-settings .inline-drawer-content").append(html);

    $("#lf_searxng_url").on("input", function () {
        settings.searxngUrl = String($(this).val()).trim();
        saveSettingsDebounced();
        console.debug(`[${extensionName}] searxngUrl = "${settings.searxngUrl}"`);
    });

    $("#lf_chat_context_tokens").on("input", function () {
        settings.chatContextTokens = clampContextTokens($(this).val());
        saveSettingsDebounced();
    });

    $("#lf_test_connection").on("click", async function () {
        const btn = $(this);
        btn.prop("disabled", true);
        try {
            const html = await testSearxngConnection(getSettings().searxngUrl);
            const kb = (html.length / 1024).toFixed(1);
            toastr.success(`SearXNG responded — ${kb} KB of results HTML.`, "Lorebook Forge");
        } catch (err) {
            console.error(`[${extensionName}] Connection test failed:`, err);
            toastr.error(`Connection failed: ${err.message}. Is the Docker container running?`, "Lorebook Forge");
        } finally {
            btn.prop("disabled", false);
        }
    });
}
