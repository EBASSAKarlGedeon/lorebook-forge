// Lorebook Wizard (center pane): conversational lorebook builder.
// Stage 13: chat round-trip via generateQuietPrompt. Canon rules +
// pasted sources ride in the system prompt; history in the user prompt.
import { extensionName } from "./config.js";
import { escapeHtml } from "./helpers.js";
import { getWizardSession, setCanonRules, addSource, deleteSource,
         pushWizardMessage, clearWizardMessages } from "./wizardData.js";
import { wizardChat } from "./llmData.js";

let drawerOpen = null; // tri-state: null = decide from source count on first render

function setStatus(text) {
    $("#lf_studio_status").text(text);
}

// ---------- Chat ----------

function messageHtml(m) {
    return `<div class="lf-msg ${m.role}"><div class="lf-msg-bubble">${escapeHtml(m.text)}</div></div>`;
}

function renderChat() {
    const chatEl = $("#lf_wizard_chat");
    const w = getWizardSession();
    if (!w.messages.length) {
        chatEl.html(`
            <div class="lf-wizard-chat-empty">
                <div class="lf-reader-empty-icon">✨</div>
                <h3>Lorebook Wizard</h3>
                <p>Paste sources below, set your canon rules, then talk to me.<br>
                e.g. "What factions appear in these sources?" or "Propose entries for the magic system."</p>
            </div>
        `);
        return;
    }
    chatEl.html(w.messages.map(messageHtml).join(""));
    chatEl.scrollTop(chatEl[0].scrollHeight);
}

async function onSend() {
    const input = $("#lf_wizard_input");
    const btn = $("#lf_wizard_send");
    const text = String(input.val()).trim();
    if (!text) return;

    const w = getWizardSession();
    const history = w.messages.slice(); // snapshot BEFORE pushing the new message

    pushWizardMessage("user", text);
    input.val("").prop("disabled", true);
    btn.prop("disabled", true).text("…");
    renderChat();
    setStatus("Wizard is thinking…");

    try {
        const reply = await wizardChat({
            canonRules: w.canonRules,
            sources: w.sources,
            history,
            message: text,
        });
        pushWizardMessage("assistant", reply);
        renderChat();
        setStatus("Wizard replied");
    } catch (err) {
        console.error(`[${extensionName}] Wizard chat failed:`, err);
        toastr.error(`Wizard chat failed: ${err.message}`, "Lorebook Forge");
        setStatus(`Wizard chat failed: ${err.message}`);
        input.val(text); // don't lose what the user typed
    } finally {
        input.prop("disabled", false).trigger("focus");
        btn.prop("disabled", false).text("Send");
    }
}

// ---------- Sources drawer ----------

function sourceCardHtml(s) {
    const preview = String(s.text).replace(/\s+/g, " ").trim().slice(0, 180);
    return `
        <div class="lf-source" data-id="${escapeHtml(s.id)}">
            <div class="lf-source-head">
                <div class="lf-source-title">${escapeHtml(s.title)}</div>
                <span class="lf-source-chars">${(s.text.length / 1024).toFixed(1)} KB</span>
                <button class="menu_button lf-source-delete" type="button" title="Remove source">✕</button>
            </div>
            <div class="lf-source-preview">${escapeHtml(preview)}…</div>
        </div>
    `;
}

function renderHeaderMeta() {
    const w = getWizardSession();
    const totalChars = w.sources.reduce((n, s) => n + s.text.length, 0);
    $("#lf_wizard_meta").text(`${w.sources.length} source${w.sources.length === 1 ? "" : "s"} · ${(totalChars / 1024).toFixed(1)} KB`);
    $("#lf_wizard_drawer_count").text(`${w.sources.length} source${w.sources.length === 1 ? "" : "s"} · ${(totalChars / 1024).toFixed(1)} KB`);
}

// ---------- Root render ----------

export function renderWizard() {
    const root = $("#lf_wizard");
    if (!root.length) return;
    const w = getWizardSession();
    if (drawerOpen === null) drawerOpen = w.sources.length === 0; // open until first source exists

    root.html(`
        <div class="lf-wizard-header">
            <span class="lf-wizard-logo">✨</span>
            <span class="lf-wizard-name">Lorebook Wizard</span>
            <span id="lf_wizard_meta" class="lf-wizard-meta"></span>
            <button class="menu_button lf-wizard-clear" type="button" title="Delete the whole conversation">Clear chat</button>
        </div>
        <div id="lf_wizard_chat" class="lf-wizard-chat"></div>
        <div class="lf-wizard-input">
            <textarea id="lf_wizard_input" class="text_pole" rows="2"
                      placeholder="Talk to the wizard… (Enter to send, Shift+Enter for a new line)"></textarea>
            <button id="lf_wizard_send" class="menu_button lf-wizard-send" type="button">Send</button>
        </div>
        <div id="lf_wizard_drawer_bar" class="lf-wizard-sourcesbar">
            <span class="fa-solid fa-circle-chevron-down inline-drawer-icon ${drawerOpen ? "" : "up"}"></span>
            <b>Sources &amp; Canon</b>
            <span id="lf_wizard_drawer_count" class="lf-wizard-meta"></span>
        </div>
        <div id="lf_wizard_drawer" class="lf-wizard-sourcesbody ${drawerOpen ? "" : "closed"}">
            <div class="lf-wizard-section">
                <label class="lf-settings-label">Canon rules — sent with every AI call in this session</label>
                <textarea class="text_pole lf-wizard-canon" rows="3"
                    placeholder="e.g. Manga canon only. Ignore anime-original arcs, filler and movies. If sources conflict, the manga wins.">${escapeHtml(w.canonRules)}</textarea>
            </div>
            <div class="lf-wizard-section">
                <label class="lf-settings-label">Add source — paste page text</label>
                <input class="text_pole lf-text-input lf-source-title-input" type="text"
                       placeholder="Source title (e.g. 'Eldoria wiki — Geography section')" />
                <textarea class="text_pole lf-source-text-input" rows="6"
                          placeholder="Paste the source text here…"></textarea>
                <div class="lf-draft-form-actions">
                    <button class="menu_button lf-source-add" type="button">Add source</button>
                </div>
            </div>
            <div class="lf-wizard-sources">
                ${w.sources.length
                    ? w.sources.map(sourceCardHtml).join("")
                    : `<div class="lf-search-status">No sources yet — paste one above.</div>`}
            </div>
        </div>
    `);

    renderChat();
    renderHeaderMeta();

    // Chat
    $("#lf_wizard_send").on("click", onSend);
    $("#lf_wizard_input").on("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
        }
    });

    // Clear chat (destructive — confirm first)
    root.find(".lf-wizard-clear").on("click", function () {
        if (!getWizardSession().messages.length) return;
        if (!window.confirm("Delete the whole wizard conversation? Sources and canon rules stay.")) return;
        clearWizardMessages();
        renderChat();
        setStatus("Wizard chat cleared");
    });

    // Drawer toggle
    root.find("#lf_wizard_drawer_bar").on("click", function () {
        drawerOpen = !drawerOpen;
        $("#lf_wizard_drawer").toggleClass("closed", !drawerOpen);
        $(this).find(".inline-drawer-icon").toggleClass("up", !drawerOpen);
    });

    // Canon rules
    root.find(".lf-wizard-canon").on("input", function () {
        setCanonRules($(this).val());
    });

    // Sources
    root.find(".lf-source-add").on("click", function () {
        const title = String(root.find(".lf-source-title-input").val()).trim();
        const text = String(root.find(".lf-source-text-input").val());
        if (!text.trim()) {
            toastr.warning("Paste some source text first.", "Lorebook Forge");
            return;
        }
        const src = addSource({ title, text });
        console.log(`[${extensionName}] Wizard source added: "${src.title}" (${src.text.length} chars)`);
        toastr.success(`Source added: "${src.title}"`, "Lorebook Forge");
        renderWizard();
    });

    root.find(".lf-source-delete").on("click", function () {
        deleteSource($(this).closest(".lf-source").data("id"));
        renderWizard();
    });
}

export function initWizard() {
    drawerOpen = null; // re-decide collapse state on each Studio open
    renderWizard();
    console.log(`[${extensionName}] Wizard initialized (${getWizardSession().sources.length} sources, ${getWizardSession().messages.length} messages)`);
}
