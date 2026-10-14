// Wizard session storage: the ONLY module that reads/writes the wizard
// session in extension_settings. Stage 12: single session, canon rules
// + pasted sources. (Multi-session manager comes later.)
import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "./config.js";

export function getWizardSession() {
    const s = extension_settings[extensionName];
    if (!s.wizard || typeof s.wizard !== "object") s.wizard = { canonRules: "", sources: [] };
    if (typeof s.wizard.canonRules !== "string") s.wizard.canonRules = "";
    if (!Array.isArray(s.wizard.sources)) s.wizard.sources = [];
    return s.wizard;
}

export function setCanonRules(text) {
    const w = getWizardSession();
    w.canonRules = String(text ?? "");
    saveSettingsDebounced();
}

export function addSource({ title, text }) {
    const w = getWizardSession();
    if (!String(text ?? "").trim()) throw new Error("Source text is empty");
    const source = {
        id: crypto.randomUUID(),
        title: String(title || "Untitled source").trim(),
        text: String(text ?? ""),
        addedAt: Date.now(),
    };
    w.sources.unshift(source);
    saveSettingsDebounced();
    return source;
}

export function deleteSource(id) {
    const w = getWizardSession();
    const i = w.sources.findIndex(s => s.id === id);
    if (i !== -1) {
        w.sources.splice(i, 1);
        saveSettingsDebounced();
    }
}
