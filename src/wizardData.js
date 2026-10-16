// Wizard session storage: the ONLY module that reads/writes the wizard
// session in extension_settings. Stage 13: canon rules, sources, chat.
// Stage 21: multi-session — sessions live in wizardSessions[], the active
// one is pointed to by wizardSessionId. getWizardSession() keeps its exact
// signature (returns the ACTIVE session's wizard object), so every
// consumer is session-aware with zero changes.
import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "./config.js";

// Migrate the pre-Stage-21 single wizard object (if present) into
// wizardSessions[0] and point the id at it. Idempotent.
function ensureSessions() {
    const s = extension_settings[extensionName];
    if (!Array.isArray(s.wizardSessions)) {
        s.wizardSessions = [];
        // Legacy single wizard (may be undefined on fresh installs) → session 0
        if (s.wizard && typeof s.wizard === "object") {
            s.wizardSessions.push({
                id: crypto.randomUUID(),
                name: "Main",
                createdAt: Date.now(),
                wizard: s.wizard,
            });
        }
        delete s.wizard;
    }
    if (!s.wizardSessions.length) {
        s.wizardSessions.push({
            id: crypto.randomUUID(),
            name: "Main",
            createdAt: Date.now(),
            wizard: { canonRules: "", sources: [], messages: [], lorebookTarget: "", proposals: [] },
        });
    }
    const valid = s.wizardSessions.some(sess => sess.id === s.wizardSessionId);
    if (!valid) s.wizardSessionId = s.wizardSessions[0].id;
}

// Normalize one session's wizard object (missing fields filled, wrong
// types reset) — same job getWizardSession did pre-Stage-21.
function normalizeWizard(w) {
    if (!w || typeof w !== "object") w = {};
    if (typeof w.canonRules !== "string") w.canonRules = "";
    if (!Array.isArray(w.sources)) w.sources = [];
    if (!Array.isArray(w.messages)) w.messages = [];
    if (typeof w.lorebookTarget !== "string") w.lorebookTarget = "";
    if (!Array.isArray(w.proposals)) w.proposals = [];
    return w;
}

export function getWizardSession() {
    ensureSessions();
    const s = extension_settings[extensionName];
    const sess = s.wizardSessions.find(sess => sess.id === s.wizardSessionId);
    sess.wizard = normalizeWizard(sess.wizard);
    return sess.wizard;
}

// ---------- Session management (Stage 21) ----------

export function listWizardSessions() {
    ensureSessions();
    const s = extension_settings[extensionName];
    return s.wizardSessions.map(sess => ({
        id: sess.id,
        name: sess.name,
        createdAt: sess.createdAt,
        active: sess.id === s.wizardSessionId,
        sources: sess.wizard?.sources?.length || 0,
        messages: sess.wizard?.messages?.length || 0,
        proposals: sess.wizard?.proposals?.length || 0,
    }));
}

// Create a new empty session and make it active. Returns its id.
export function createWizardSession(name) {
    ensureSessions();
    const s = extension_settings[extensionName];
    const sess = {
        id: crypto.randomUUID(),
        name: String(name || `Session ${s.wizardSessions.length + 1}`).trim() || `Session ${s.wizardSessions.length + 1}`,
        createdAt: Date.now(),
        wizard: { canonRules: "", sources: [], messages: [], lorebookTarget: "", proposals: [] },
    };
    s.wizardSessions.push(sess);
    s.wizardSessionId = sess.id;
    saveSettingsDebounced();
    return sess.id;
}

// Switch the active session. No-op (returns false) when id is unknown or
// already active. Caller re-renders on true.
export function switchWizardSession(id) {
    ensureSessions();
    const s = extension_settings[extensionName];
    if (s.wizardSessionId === id) return false;
    if (!s.wizardSessions.some(sess => sess.id === id)) return false;
    s.wizardSessionId = id;
    saveSettingsDebounced();
    return true;
}

// Delete a session (never the last one). Switches to the first remaining
// when deleting the active one. Returns true when deleted.
export function deleteWizardSession(id) {
    ensureSessions();
    const s = extension_settings[extensionName];
    if (s.wizardSessions.length <= 1) return false;
    const i = s.wizardSessions.findIndex(sess => sess.id === id);
    if (i === -1) return false;
    const wasActive = s.wizardSessionId === id;
    s.wizardSessions.splice(i, 1);
    if (wasActive) s.wizardSessionId = s.wizardSessions[0].id;
    saveSettingsDebounced();
    return true;
}

// Rename a session. Returns the new name (caller re-renders).
export function renameWizardSession(id, name) {
    ensureSessions();
    const sess = extension_settings[extensionName].wizardSessions.find(sess => sess.id === id);
    if (!sess) return null;
    sess.name = String(name ?? "").trim() || sess.name;
    saveSettingsDebounced();
    return sess.name;
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
