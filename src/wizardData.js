// Wizard session storage: the ONLY module that reads/writes the wizard
// session in extension_settings. Stage 13: canon rules, sources, chat.
import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "./config.js";

export function getWizardSession() {
    const s = extension_settings[extensionName];
    if (!s.wizard || typeof s.wizard !== "object") {
        s.wizard = { canonRules: "", sources: [], messages: [] };
    }
    if (typeof s.wizard.canonRules !== "string") s.wizard.canonRules = "";
    if (!Array.isArray(s.wizard.sources)) s.wizard.sources = [];
    if (!Array.isArray(s.wizard.messages)) s.wizard.messages = [];
    if (typeof s.wizard.lorebookTarget !== "string") s.wizard.lorebookTarget = "";
    if (!Array.isArray(s.wizard.proposals)) s.wizard.proposals = [];
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

// ---------- Chat history (Stage 13) ----------

export function pushWizardMessage(role, text) {
    const w = getWizardSession();
    const msg = {
        role: role === "assistant" ? "assistant" : "user",
        text: String(text ?? ""),
        ts: Date.now(),
    };
    w.messages.push(msg);
    saveSettingsDebounced();
    return msg;
}

export function clearWizardMessages() {
    const w = getWizardSession();
    w.messages = [];
    w.proposals = [];
    saveSettingsDebounced();
}

export function setLorebookTarget(name) {
    const w = getWizardSession();
    w.lorebookTarget = String(name ?? "").trim();
    saveSettingsDebounced();
}

// ---------- Entry proposals (Stage 14) ----------

export function addWizardProposals(items) {
    const w = getWizardSession();
    const proposals = (items || [])
        .filter(e => String(e?.content ?? "").trim())
        .map(e => ({
            id: crypto.randomUUID(),
            action: e?.action === "update" ? "update" : "new",
            target: String(e?.target ?? "").trim(),
            title: String(e?.title || "Untitled").trim(),
            keys: Array.isArray(e?.keys) ? e.keys.map(k => String(k).trim()).filter(Boolean) : [],
            content: String(e?.content ?? "").trim(),
            quote: String(e?.quote ?? "").trim(),
            status: "pending", // pending | accepted | rejected
            createdAt: Date.now(),
        }));
    w.proposals.push(...proposals); // chronological — rendered in order
    saveSettingsDebounced();
    return proposals;
}

export function updateWizardProposal(id, status) {
    const w = getWizardSession();
    const p = w.proposals.find(p => p.id === id);
    if (p) {
        p.status = status;
        saveSettingsDebounced();
    }
    return p;
}
