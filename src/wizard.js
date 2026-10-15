// Lorebook Wizard (center pane): conversational lorebook builder.
// Stage 14: extraction protocol — [⚡ Extract] proposes entry cards with
// mandatory evidence quotes, auto-verified against the pasted sources.
import { extensionName } from "./config.js";
import { escapeHtml, verifyQuote } from "./helpers.js";
import { getWizardSession, setCanonRules, addSource, deleteSource,
         pushWizardMessage, clearWizardMessages,
         addWizardProposals, updateWizardProposal, setLorebookTarget  } from "./wizardData.js";
import { wizardChat, wizardExtract } from "./llmData.js";
import { saveDraft, renderDraftsList } from "./drafts.js";
import { listLorebooks, loadLorebookEntries, lorebookToSourceText } from "./wiData.js";

let drawerOpen = null; // tri-state: null = decide from source count on first render

function setStatus(text) {
    $("#lf_studio_status").text(text);
}

// ---------- Chat ----------

function messageHtml(m) {
    return `<div class="lf-msg ${m.role}"><div class="lf-msg-bubble">${escapeHtml(m.text)}</div></div>`;
}

const VERDICTS = {
    verified: { icon: "✅", label: "Verified in sources", cls: "verified" },
    fuzzy:    { icon: "⚠️", label: "Near-match — check it", cls: "fuzzy" },
    missing:  { icon: "❌", label: "NOT found in sources", cls: "missing" },
};

function proposalCardHtml(p, verdict) {
    const v = VERDICTS[verdict];
    const statusHtml = p.status === "pending"
        ? `
        <div class="lf-proposal-actions">
            <button class="menu_button lf-proposal-accept" type="button">Accept → Drafts</button>
            <button class="menu_button lf-proposal-reject" type="button">Reject</button>
        </div>`
        : `<div class="lf-proposal-statusline lf-proposal-${p.status}">${p.status === "accepted" ? "✓ Accepted — in Drafts" : "✕ Rejected"}</div>`;
    return `
        <div class="lf-proposal lf-proposal-${p.status}" data-id="${escapeHtml(p.id)}">
            <div class="lf-proposal-head">
                <div class="lf-proposal-title">${escapeHtml(p.title)}</div>
                ${p.action === "update" ? `<span class="lf-proposal-updbadge" title="Replaces the existing entry in the target lorebook">&#10227;${p.target ? ` ${escapeHtml(p.target)}` : " update"}</span>` : ""}
                <span class="lf-proposal-verdict ${v.cls}" title="${v.label}">${v.icon}</span>
            </div>
            ${p.keys.length ? `<div class="lf-draft-keys">${p.keys.map(k => `<span>${escapeHtml(k)}</span>`).join("")}</div>` : ""}
            <div class="lf-proposal-content">${escapeHtml(p.content)}</div>
            <div class="lf-proposal-quote">
                <span class="lf-proposal-quote-label">Evidence</span>
                ${p.quote ? escapeHtml(p.quote) : "<i>(no quote provided — flagged by design)</i>"}
            </div>
            ${statusHtml}
        </div>
    `;
}

function renderProposals() {
    const w = getWizardSession();
    const el = $("#lf_wizard_proposals");
    if (!el.length) return;

    // Preserve the carousel position across re-renders (accept/reject)
    const prevTrack = el.find(".lf-carousel-track")[0];
    const prevScroll = prevTrack ? prevTrack.scrollLeft : 0;

    if (!w.proposals.length) {
        el.addClass("lf-hidden").empty();
        return;
    }
    el.removeClass("lf-hidden");
    const texts = w.sources.map(s => s.text);
    el.html(`
        <div class="lf-carousel-bar">
            <b>Proposals</b>
            <span class="lf-carousel-count"></span>
            <button class="menu_button lf-carousel-prev" type="button" title="Previous">◀</button>
            <button class="menu_button lf-carousel-next" type="button" title="Next">▶</button>
        </div>
        <div class="lf-carousel-track">
            ${w.proposals.map(p => proposalCardHtml(p, verifyQuote(p.quote, texts))).join("")}
        </div>
    `);

    const track = el.find(".lf-carousel-track")[0];
    const count = el.find(".lf-carousel-count");
    const step = () => {
        const card = el.find(".lf-proposal").first()[0];
        return card ? card.offsetWidth + 10 : 350; // card width + gap
    };
    const updateCount = () => {
        const n = w.proposals.length;
        const i = Math.min(n, Math.round(track.scrollLeft / step()) + 1);
        count.text(`${i} / ${n}`);
    };
    el.find(".lf-carousel-track").on("scroll", () => requestAnimationFrame(updateCount));
    el.find(".lf-carousel-prev").on("click", () => track.scrollBy({ left: -step(), behavior: "smooth" }));
    el.find(".lf-carousel-next").on("click", () => track.scrollBy({ left: step(), behavior: "smooth" }));
    updateCount();
    track.scrollLeft = prevScroll; // stay where the user was

    el.find(".lf-proposal-accept").on("click", function () {
        const p = w.proposals.find(p => p.id === $(this).closest(".lf-proposal").data("id"));
        if (!p) return;
        saveDraft({
            title: p.title,
            keys: p.keys.length ? p.keys : [p.title],
            content: p.content,
            sourceUrl: "",
            sourceTitle: p.action === "update"
                ? `Wizard update → ${p.target || "(target missing)"}${p.quote ? " · quote verified check card" : ""}`
                : "Wizard extraction · " + (p.quote ? "quote verified check card" : "no quote"),
            sourceRaw: p.quote,
            origin: "ai",
        });
        updateWizardProposal(p.id, "accepted");
        renderDraftsList();
        renderProposals();
        toastr.success(`"${p.title}" accepted — see the Drafts panel.`, "Lorebook Forge");
    });
    el.find(".lf-proposal-reject").on("click", function () {
        const id = $(this).closest(".lf-proposal").data("id");
        updateWizardProposal(id, "rejected");
        renderProposals();
    });
}

function renderChat() {
    const chatEl = $("#lf_wizard_chat");
    const w = getWizardSession();
    if (!w.messages.length) {
        chatEl.html(`
            <div class="lf-wizard-chat-empty">
                <div class="lf-reader-empty-icon">✨</div>
                <h3>Lorebook Wizard</h3>
                <p>Paste sources below, set your canon rules, then talk to me —<br>
                or hit <b>⚡ Extract</b> to propose entries with verified evidence quotes.</p>
            </div>
        `);
    } else {
        chatEl.html(w.messages.map(messageHtml).join(""));
    }
    chatEl.scrollTop(chatEl[0].scrollHeight);
    renderProposals();
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
        btn.prop("enabled", true).text("Send");
    }
}

async function onExtract() {
    const input = $("#lf_wizard_input");
    const btn = $("#lf_wizard_extract");
    const w = getWizardSession();
    if (!w.sources.length) {
        toastr.warning("Paste at least one source first — extraction works from sources only.", "Lorebook Forge");
        return;
    }
    const focus = String(input.val()).trim(); // optional: use the input box as the focus
    input.val("");
    btn.prop("disabled", true).text("…");
    setStatus(`Extracting entries from ${w.sources.length} source(s)${focus ? ` — focus: "${focus}"` : ""}…`);

    try {
        const items = await wizardExtract({ canonRules: w.canonRules, sources: w.sources, focus, lorebookTarget: w.lorebookTarget });
        const proposals = addWizardProposals(items);
        if (focus) pushWizardMessage("user", focus); // keep a conversational trace of the focus
        const texts = w.sources.map(s => s.text);
        const counts = { verified: 0, fuzzy: 0, missing: 0 };
        for (const p of proposals) counts[verifyQuote(p.quote, texts)]++;
        pushWizardMessage("assistant",
            `⚡ Proposed ${proposals.length} entr${proposals.length === 1 ? "y" : "ies"} — ` +
            `${counts.verified} verified ✅, ${counts.fuzzy} near-match ⚠️, ${counts.missing} unverified ❌. Review the cards below.`);
        renderChat();
        const trackEl = document.querySelector("#lf_wizard_proposals .lf-carousel-track");
        if (trackEl) trackEl.scrollTo({ left: trackEl.scrollWidth }); // newest cards are appended at the end
        setStatus(`Extracted ${proposals.length} proposals (${counts.verified}✅ / ${counts.fuzzy}⚠️ / ${counts.missing}❌)`);
    } catch (err) {
        console.error(`[${extensionName}] Extraction failed:`, err);
        toastr.error(`Extraction failed: ${err.message}`, "Lorebook Forge");
        setStatus(`Extraction failed: ${err.message}`);
        if (focus) input.val(focus);
    } finally {
        btn.prop("disabled", false).html("&#9889; Extract");
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
    $("#lf_wizard_meta, #lf_wizard_drawer_count").text(`${w.sources.length} source${w.sources.length === 1 ? "" : "s"} · ${(totalChars / 1024).toFixed(1)} KB`);
}

// drafts.js asks us to add a source via this event (avoids drafts↔wizard cycle)
function onDraftToWizard(e) {
    const src = addSource(e.originalEvent?.detail ?? e.detail);
    console.log(`[${extensionName}] Source added from draft: "${src.title}" (${src.text.length} chars)`);
    toastr.success(`"${src.title}" is now a Wizard source.`, "Lorebook Forge");
    renderWizard();
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
            <button class="menu_button lf-wizard-clear" type="button" title="Delete the conversation AND proposals">Clear chat</button>
        </div>
        <div id="lf_wizard_chat" class="lf-wizard-chat"></div>
        <div id="lf_wizard_proposals" class="lf-wizard-proposals"></div>
        <div class="lf-wizard-input">
            <textarea id="lf_wizard_input" class="text_pole" rows="2"
                      placeholder="Talk to the wizard… or type an extraction focus and hit ⚡ (Enter = send, Shift+Enter = newline)"></textarea>
            <button id="lf_wizard_send" class="menu_button lf-wizard-send" type="button">Send</button>
            <button id="lf_wizard_extract" class="menu_button lf-wizard-extract" type="button" title="Propose entries from your sources, with verified evidence quotes">&#9889; Extract</button>
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
                <label class="lf-settings-label">Load existing lorebook — updater mode</label>
                <select class="text_pole lf-wizard-lb-select"><option value="">Loading lorebooks…</option></select>
                <button class="menu_button lf-wizard-lb-import" type="button">Import entries as source</button>
                <div class="lf-search-status lf-wizard-lb-target">${w.lorebookTarget ? `Update target set: ${escapeHtml(w.lorebookTarget)}` : "No update target — imports set it."}</div>
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

    // Chat + extraction
    $("#lf_wizard_send").on("click", onSend);
    $("#lf_wizard_extract").on("click", onExtract);
    $("#lf_wizard_input").on("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
        }
    });

    // Clear chat (destructive — confirm first)
    root.find(".lf-wizard-clear").on("click", function () {
        const w = getWizardSession();
        if (!w.messages.length && !w.proposals.length) return;
        if (!window.confirm("Delete the wizard conversation AND all pending proposals? Sources and canon rules stay. Accepted drafts are already saved.")) return;
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

    // ---- Updater mode: lorebook import (Stage 16a) ----
    const lbSelect = root.find(".lf-wizard-lb-select");
    listLorebooks().then(books => {
        lbSelect.html(`<option value="">— pick a lorebook —</option>` +
            books.map(b => `<option value="${escapeHtml(b.file_id)}">${escapeHtml(b.name)}</option>`).join(""));
    }).catch(err => {
        console.error(`[${extensionName}] Lorebook list failed:`, err);
        lbSelect.html(`<option value="">(failed to list lorebooks)</option>`);
    });

    root.find(".lf-wizard-lb-import").on("click", async function () {
        const btn = $(this).prop("disabled", true);
        const name = String(lbSelect.val() || "").trim();
        try {
            if (!name) {
                toastr.warning("Pick a lorebook first.", "Lorebook Forge");
                return;
            }
            const sourceTitle = `Lorebook: ${name}`;
            if (getWizardSession().sources.some(s => s.title === sourceTitle)) {
                toastr.warning(`"${name}" is already imported as a source.`, "Lorebook Forge");
                return;
            }
            const entries = await loadLorebookEntries(name);
            const text = lorebookToSourceText(name, entries);
            addSource({ title: sourceTitle, text });
            setLorebookTarget(name);
            console.log(`[${extensionName}] Lorebook imported: "${name}" (${Object.keys(entries).length} entries, ${text.length} chars)`);
            toastr.success(`"${name}" imported — ${Object.keys(entries).length} entries are now wizard sources.`, "Lorebook Forge");
            renderWizard();
        } catch (err) {
            console.error(`[${extensionName}] Lorebook import failed:`, err);
            toastr.error(`Import failed: ${err.message}`, "Lorebook Forge");
        } finally {
            btn.prop("disabled", false);
        }
    });
}

export function initWizard() {
    drawerOpen = null; // re-decide collapse state on each Studio open
    // Same function reference → addEventListener dedupes across Studio reopens
    document.removeEventListener("lf-wizard-add-source", onDraftToWizard);
    document.addEventListener("lf-wizard-add-source", onDraftToWizard);
    renderWizard();
    console.log(`[${extensionName}] Wizard initialized (${getWizardSession().sources.length} sources, ${getWizardSession().messages.length} messages, ${getWizardSession().proposals.length} proposals)`);
}
