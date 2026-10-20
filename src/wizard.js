// Lorebook Wizard (Wizard tab): conversational lorebook builder.
// Stage 24 layout (v2): the Wizard tab is a console — header, sessions
// strip, ONE flexible chat region, composer with quick-forge chips.
// Sources & Canon moved out of the overlay drawer into the left panel's
// "Sources" sub-tab (#lf_sources, owned by studio.js). Proposals live in
// their own tab — renderProposals fills #lf_proposals and the grounding
// meter under the left panel (#lf_grounding).
import { extensionName } from "./config.js";
import { escapeHtml, verifyQuote, icon, keysHtml } from "./helpers.js";
import { getWizardSession, setCanonRules, addSource, deleteSource,
         pushWizardMessage, clearWizardMessages, setLorebookTarget,
         addWizardProposals, updateWizardProposal,
         listWizardSessions, createWizardSession, switchWizardSession,
         deleteWizardSession, renameWizardSession } from "./wizardData.js";
import { wizardChat, wizardExtract } from "./llmData.js";
import { saveDraft, renderDraftsList } from "./drafts.js";
import { listLorebooks, loadLorebookEntries, lorebookToSourceText, applyUpdateToLorebook } from "./wiData.js";

const SEND_LABEL = `${icon("send")}Send`;
const EXTRACT_LABEL = `${icon("zap")}Extract`;

// Quick-forge chips: canned wizard prompts (they go through onSend like typed text)
const QUICK_FORGE = [
    { icon: "key", label: "Suggest keys", prompt: "For each major entity in the sources, suggest SillyTavern trigger keys: 2-5 primary keys (name, common aliases, distinctive terms) and any secondary keys worth gating on. Keep keys short and avoid generic words that would fire constantly." },
    { icon: "compare", label: "Reconcile canon", prompt: "Reconcile the sources against the canon rules. List every contradiction or conflict between sources, say which version canon should keep and why, and flag anything the canon rules exclude." },
    { icon: "compress", label: "Compress tokens", prompt: "Which facts in the sources are essential for roleplay and which are trivia? Propose a token-lean structure for the entries: what to keep, what to merge, what to cut." },
];

function setStatus(text) {
    $("#lf_studio_status").text(text);
}

function showSources() {
    document.getElementById("lf_studio_root")?.dispatchEvent(new CustomEvent("lf-show-sources"));
}

// ---------- Chat ----------

function messageHtml(m) {
    const who = m.role === "user" ? `${icon("arrow", "lf-ic-sm")}You` : `${icon("sparkles", "lf-ic-sm")}Wizard`;
    const time = m.ts ? ` · ${new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
    return `
        <div class="lf-msg ${m.role}">
            <div class="lf-msg-bubble">
                <div class="lf-msg-by">${who}<span class="lf-msg-time">${time}</span></div>
                <div class="lf-msg-text">${escapeHtml(m.text)}</div>
            </div>
        </div>`;
}

const VERDICTS = {
    verified: { icon: "✓", label: "Verified", title: "Verified in sources", cls: "verified" },
    fuzzy:    { icon: "≈", label: "Near-match", title: "Near-match — check it", cls: "fuzzy" },
    missing:  { icon: "✕", label: "Unverified", title: "NOT found in sources", cls: "missing" },
};

function proposalCardHtml(p, verdict) {
    const v = VERDICTS[verdict];
    const isUpdate = p.action === "update";
    const footer = p.status === "pending"
        ? `
        <div class="lf-proposal-actions">
            <button class="menu_button lf-btn-primary lf-proposal-accept" type="button">${icon(isUpdate ? "reset" : "plus")}${isUpdate ? "Apply update" : "Stage draft"}</button>
            <button class="menu_button lf-proposal-reject" type="button">Reject</button>
            <button class="lf-ghost-btn lf-proposal-copy" type="button" title="Copy entry content">${icon("copy")}Copy</button>
        </div>`
        : `<div class="lf-proposal-statusline lf-proposal-${p.status}">${p.status === "accepted"
            ? (isUpdate ? `✓ Applied → ${escapeHtml(p.target || "lorebook")}` : "✓ Staged — in the Draft Deck")
            : "✕ Rejected"}</div>`;
    return `
        <article class="lf-proposal lf-proposal-${p.status}" data-id="${escapeHtml(p.id)}">
            <div class="lf-proposal-head">
                <div class="lf-proposal-titles">
                    <div class="lf-proposal-title">${escapeHtml(p.title)}</div>
                    <div class="lf-proposal-sub">${isUpdate
                        ? `<span class="lf-proposal-updbadge" title="Replaces the existing entry in the target lorebook">⟳ update${p.target ? ` → ${escapeHtml(p.target)}` : ""}</span>`
                        : "New entry"}</div>
                </div>
                <span class="lf-proposal-verdict ${v.cls}" title="${v.title}">${v.icon} ${v.label}</span>
            </div>
            ${keysHtml(p.keys)}
            <div class="lf-entry-box">${escapeHtml(p.content)}</div>
            <div class="lf-proposal-quote">
                <span class="lf-proposal-quote-label">Evidence</span>
                ${p.quote ? escapeHtml(p.quote) : "<i>(no quote provided — flagged by design)</i>"}
            </div>
            <div class="lf-entry-meta">
                <span>${p.keys.length} key${p.keys.length === 1 ? "" : "s"}</span>
                <span>${p.content.length.toLocaleString()} chars</span>
                <span>~${Math.ceil(p.content.length / 4).toLocaleString()} tok</span>
            </div>
            ${footer}
        </article>
    `;
}

// Left-panel footer: share of proposals whose evidence quote checks out
function renderGrounding(counts, total) {
    const el = $("#lf_grounding");
    if (!el.length) return;
    if (!total) {
        el.html(`<div class="lf-grounding-row"><span>Evidence grounding</span><span class="lf-grounding-val">—</span></div>
            <div class="lf-grounding-bar"></div>`);
        return;
    }
    const pct = n => (n / total * 100).toFixed(1);
    el.html(`
        <div class="lf-grounding-row">
            <span>Evidence grounding</span>
            <span class="lf-grounding-val">${Math.round(counts.verified / total * 100)}% verified</span>
        </div>
        <div class="lf-grounding-bar" title="${counts.verified} verified · ${counts.fuzzy} near-match · ${counts.missing} unverified">
            <span class="good" style="width:${pct(counts.verified)}%"></span><span class="warn" style="width:${pct(counts.fuzzy)}%"></span><span class="bad" style="width:${pct(counts.missing)}%"></span>
        </div>`);
}

function renderProposals() {
    const w = getWizardSession();
    const grid = $("#lf_proposals");
    if (!grid.length) return;

    // Preserve vertical scroll across in-place re-renders (accept/reject)
    const scrollEl = document.getElementById("lf_proposals_scroll");
    const prevScroll = scrollEl ? scrollEl.scrollTop : 0;

    const texts = w.sources.map(s => s.text);
    const verdicts = w.proposals.map(p => verifyQuote(p.quote, texts));
    if (!w.proposals.length) {
        grid.html(`
            <div class="lf-pane-empty">
                <div class="lf-reader-empty-icon">⚡</div>
                <h3>No proposals yet</h3>
                <p>Add sources in the left panel, then hit <b>⚡ Extract</b> in the Wizard —<br>
                cards appear here with evidence quotes verified against your sources.</p>
            </div>
        `);
    } else {
        grid.html(w.proposals.map((p, i) => proposalCardHtml(p, verdicts[i])).join(""));
    }

    const counts = { verified: 0, fuzzy: 0, missing: 0 };
    for (const v of verdicts) counts[v]++;
    renderGrounding(counts, verdicts.length);

    // Pane header chip + top-tab badge (pending count only — the badge
    // disappears when nothing awaits review)
    const pending = w.proposals.filter(p => p.status === "pending").length;
    $("#lf_proposals_count").text(w.proposals.length ? `${pending} to review · ${w.proposals.length} total` : "");
    $("#lf_tab_proposals .lf-tab-badge").text(pending || "").toggleClass("lf-hidden", !pending);

    if (scrollEl) scrollEl.scrollTop = prevScroll;

    grid.find(".lf-proposal-copy").on("click", async function () {
        const p = w.proposals.find(p => p.id === $(this).closest(".lf-proposal").data("id"));
        if (!p) return;
        try {
            await navigator.clipboard.writeText(p.content);
            toastr.success(`Copied "${p.title}"`, "Lorebook Forge");
        } catch (err) {
            toastr.error(`Copy failed: ${err.message}`, "Lorebook Forge");
        }
    });

    grid.find(".lf-proposal-accept").on("click", async function () {
        const p = w.proposals.find(p => p.id === $(this).closest(".lf-proposal").data("id"));
        if (!p) return;

        // Update proposal → write into the target lorebook directly (Stage 16b)
        if (p.action === "update" && p.target) {
            const target = w.lorebookTarget;
            if (!target) {
                toastr.warning("No update target in this session. Import the lorebook (Sources panel) or reject this card.", "Lorebook Forge");
                return;
            }
            if (!window.confirm(`Apply this update to the entry "${p.target}" in lorebook "${target}"?\nThis REPLACES that entry's content in place.`)) return;
            const btn = $(this).prop("disabled", true).text("Applying…");
            try {
                const res = await applyUpdateToLorebook(target, p.target, { content: p.content, keys: p.keys });
                updateWizardProposal(p.id, "accepted");
                renderProposals();
                toastr.success(`"${p.target}" updated in "${res.lorebook}" — verify in the World Info editor.`, "Lorebook Forge");
                setStatus(`Update applied: "${p.target}" → ${res.lorebook}`);
            } catch (err) {
                console.error(`[${extensionName}] Update apply failed:`, err);
                toastr.error(`Update failed: ${err.message}`, "Lorebook Forge");
                btn.prop("disabled", false).html(`${icon("reset")}Apply update`);
            }
            return;
        }

        // New proposal → drafts pipeline (unchanged)
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
        toastr.success(`"${p.title}" staged — see the Draft Deck.`, "Lorebook Forge");
    });
    grid.find(".lf-proposal-reject").on("click", function () {
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
                <p>Paste sources and set canon rules in the left panel, then talk to me —<br>
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
    const history = w.messages.slice();

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
        input.val(text);
    } finally {
        input.prop("disabled", false).trigger("focus");
        btn.prop("disabled", false).html(SEND_LABEL);
    }
}

async function onExtract() {
    const input = $("#lf_wizard_input");
    const btn = $("#lf_wizard_extract");
    const w = getWizardSession();
    if (!w.sources.length) {
        toastr.warning("Paste at least one source first — extraction works from sources only.", "Lorebook Forge");
        showSources();
        return;
    }
    const focus = String(input.val()).trim();
    input.val("");
    btn.prop("disabled", true).text("…");
    setStatus(`Extracting entries from ${w.sources.length} source(s)${focus ? ` — focus: "${focus}"` : ""}…`);

    try {
        const items = await wizardExtract({ canonRules: w.canonRules, sources: w.sources, focus, lorebookTarget: w.lorebookTarget });
        const proposals = addWizardProposals(items);
        if (focus) pushWizardMessage("user", focus);
        const texts = w.sources.map(s => s.text);
        const counts = { verified: 0, fuzzy: 0, missing: 0 };
        for (const p of proposals) counts[verifyQuote(p.quote, texts)]++;
        pushWizardMessage("assistant",
            `⚡ Proposed ${proposals.length} entr${proposals.length === 1 ? "y" : "ies"} — ` +
            `${counts.verified} verified ✅, ${counts.fuzzy} near-match ⚠️, ${counts.missing} unverified ❌. Review them in the Proposals tab.`);
        renderChat();
        // Jump straight to the Proposals tab so the new cards are visible
        document.getElementById("lf_studio_root")?.dispatchEvent(new CustomEvent("lf-show-center", { detail: "proposals" }));
        const scroller = document.getElementById("lf_proposals_scroll");
        if (scroller) scroller.scrollTo({ top: scroller.scrollHeight }); // newest cards are appended at the end
        setStatus(`Extracted ${proposals.length} proposals (${counts.verified}✅ / ${counts.fuzzy}⚠️ / ${counts.missing}❌)`);
    } catch (err) {
        console.error(`[${extensionName}] Extraction failed:`, err);
        toastr.error(`Extraction failed: ${err.message}`, "Lorebook Forge");
        setStatus(`Extraction failed: ${err.message}`);
        if (focus) input.val(focus);
    } finally {
        btn.prop("disabled", false).html(EXTRACT_LABEL);
    }
}

// ---------- Sources (left panel sub-tab) ----------

function sourceCardHtml(s) {
    const preview = String(s.text).replace(/\s+/g, " ").trim().slice(0, 400);
    const isBook = s.title.startsWith("Lorebook: ");
    return `
        <div class="lf-source" data-id="${escapeHtml(s.id)}" title="Click to expand/collapse the preview">
            <div class="lf-source-head">
                ${icon(isBook ? "book" : "layers", isBook ? "lf-ic-accent3" : "lf-ic-accent2")}
                <div class="lf-source-title">${escapeHtml(s.title)}</div>
                <button class="lf-icon-btn lf-source-delete" type="button" title="Remove source">${icon("x")}</button>
            </div>
            <div class="lf-source-preview">${escapeHtml(preview)}…</div>
            <div class="lf-source-foot">
                <span>${(s.text.length / 1024).toFixed(1)} KB · ~${Math.ceil(s.text.length / 4).toLocaleString()} tok</span>
            </div>
        </div>
    `;
}

function renderHeaderMeta() {
    const w = getWizardSession();
    const totalChars = w.sources.reduce((n, s) => n + s.text.length, 0);
    $("#lf_wizard_meta").text(`${w.sources.length} source${w.sources.length === 1 ? "" : "s"} · ${(totalChars / 1024).toFixed(1)} KB`);
    $("#lf_sources_count").text(w.sources.length || "");
    $("#lf_book_pill_name").text(w.lorebookTarget || "none");
    $("#lf_book_pill").toggleClass("is-set", !!w.lorebookTarget);
}

// drafts.js asks us to add a source via this event (avoids drafts↔wizard cycle)
function onDraftToWizard(e) {
    const src = addSource(e.originalEvent?.detail ?? e.detail);
    console.log(`[${extensionName}] Source added from draft: "${src.title}" (${src.text.length} chars)`);
    toastr.success(`"${src.title}" is now a Wizard source.`, "Lorebook Forge");
    renderWizard();
}

function renderSources() {
    const pane = $("#lf_sources");
    if (!pane.length) return;
    const w = getWizardSession();

    pane.html(`
        <div class="lf-wizard-section">
            <label class="lf-settings-label">Canon rules <span class="lf-dim">— sent with every AI call</span></label>
            <textarea class="text_pole lf-wizard-canon" rows="3"
                placeholder="e.g. Manga canon only. Ignore anime-original arcs, filler and movies. If sources conflict, the manga wins.">${escapeHtml(w.canonRules)}</textarea>
        </div>
        <div class="lf-section-head">
            <span>Active context sources (${w.sources.length})</span>
            <button class="lf-link-btn lf-addsource-toggle" type="button">${icon("plus", "lf-ic-sm")}Add source</button>
        </div>
        <div class="lf-addsource lf-wizard-section" style="display:none;">
            <input class="text_pole lf-text-input lf-source-title-input" type="text"
                   placeholder="Source title (e.g. 'Eldoria wiki — Geography section')" />
            <textarea class="text_pole lf-source-text-input" rows="5"
                      placeholder="Paste the source text here…"></textarea>
            <div class="lf-draft-form-actions">
                <button class="menu_button lf-btn-primary lf-source-add" type="button">Add source</button>
            </div>
        </div>
        <div class="lf-wizard-sources">
            ${w.sources.length
                ? w.sources.map(sourceCardHtml).join("")
                : `<div class="lf-search-status">No sources yet — "Add source" above, or send a draft here with → Wizard.</div>`}
        </div>
        <div class="lf-wizard-section">
            <div class="lf-section-head"><span>Updater — load existing lorebook</span></div>
            <select class="text_pole lf-wizard-lb-select"><option value="">Loading lorebooks…</option></select>
            <button class="menu_button lf-wizard-lb-import" type="button">${icon("download", "lf-ic-sm")}Import entries as source</button>
            <div class="lf-search-status lf-wizard-lb-target">${w.lorebookTarget ? `Update target set: ${escapeHtml(w.lorebookTarget)}` : "No update target — imports set it."}</div>
        </div>
    `);

    // Canon rules
    pane.find(".lf-wizard-canon").on("input", function () {
        setCanonRules($(this).val());
    });

    // Add-source form (collapsed by default)
    pane.find(".lf-addsource-toggle").on("click", function () {
        const form = pane.find(".lf-addsource");
        form.slideToggle(120, () => { if (form.is(":visible")) form.find(".lf-source-title-input").trigger("focus"); });
    });
    pane.find(".lf-source-add").on("click", function () {
        const title = String(pane.find(".lf-source-title-input").val()).trim();
        const text = String(pane.find(".lf-source-text-input").val());
        if (!text.trim()) {
            toastr.warning("Paste some source text first.", "Lorebook Forge");
            return;
        }
        const src = addSource({ title, text });
        console.log(`[${extensionName}] Wizard source added: "${src.title}" (${src.text.length} chars)`);
        toastr.success(`Source added: "${src.title}"`, "Lorebook Forge");
        renderWizard();
    });

    // Source cards: expand/collapse preview on click; ✕ deletes
    pane.find(".lf-source").on("click", function (e) {
        if ($(e.target).closest(".lf-source-delete").length) return;
        $(this).toggleClass("open");
    });
    pane.find(".lf-source-delete").on("click", function () {
        deleteSource($(this).closest(".lf-source").data("id"));
        renderWizard();
    });

    // ---- Updater: lorebook import ----
    const lbSelect = pane.find(".lf-wizard-lb-select");
    listLorebooks().then(books => {
        lbSelect.html(`<option value="">— pick a lorebook —</option>` +
            books.map(b => `<option value="${escapeHtml(b.file_id)}">${escapeHtml(b.name)}</option>`).join(""));
    }).catch(err => {
        console.error(`[${extensionName}] Lorebook list failed:`, err);
        lbSelect.html(`<option value="">(failed to list lorebooks)</option>`);
    });

    pane.find(".lf-wizard-lb-import").on("click", async function () {
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

// ---------- Root render ----------

export function renderWizard() {
    const root = $("#lf_wizard");
    if (!root.length) return;

    root.html(`
        <div class="lf-wizard-header">
            <span class="lf-tile">${icon("sparkles")}</span>
            <div class="lf-wizard-heading">
                <div class="lf-wizard-name">Lorebook Wizard
                    <span id="lf_wizard_meta" class="lf-chip lf-chip-good" title="Click to manage sources"></span>
                </div>
                <div class="lf-wizard-sub">Grounded WorldInfo extraction — every proposal cites your sources.</div>
            </div>
            <button class="lf-ghost-btn lf-wizard-sources" type="button">${icon("layers")}Sources &amp; Canon</button>
            <button class="lf-ghost-btn lf-wizard-clear" type="button" title="Delete the conversation AND proposals">${icon("reset")}Clear session</button>
        </div>
        <div class="lf-sessions-bar">
            <span class="lf-sessions-label">Sessions</span>
            <div class="lf-sessions-strip">
                ${listWizardSessions().map(sess => `
                    <button class="lf-session-chip${sess.active ? " active" : ""}" type="button"
                        data-id="${escapeHtml(sess.id)}" title="${escapeHtml(sess.name)} — ${sess.sources} sources, ${sess.messages} messages
Click = switch · double-click = rename · right-click = delete">${escapeHtml(sess.name)}</button>`).join("")}
            </div>
            <button class="lf-icon-btn lf-session-new" type="button" title="New wizard session">${icon("plus")}</button>
        </div>
        <div id="lf_wizard_chat" class="lf-wizard-chat"></div>
        <div class="lf-composer">
            <div class="lf-quick">
                <span class="lf-quick-label">Quick forge</span>
                ${QUICK_FORGE.map((q, i) => `<button class="lf-quick-chip" type="button" data-i="${i}" title="${escapeHtml(q.prompt)}">${icon(q.icon, "lf-ic-sm")}${q.label}</button>`).join("")}
            </div>
            <div class="lf-composer-box">
                <textarea id="lf_wizard_input" rows="2"
                          placeholder="Talk to the wizard… or type an extraction focus and hit Extract"></textarea>
                <div class="lf-composer-foot">
                    <span class="lf-kbd-hints"><kbd>Enter</kbd> send <kbd>Shift+Enter</kbd> newline</span>
                    <button id="lf_wizard_extract" class="menu_button lf-btn-soft lf-wizard-extract" type="button" title="Propose entries from your sources, with verified evidence quotes">${EXTRACT_LABEL}</button>
                    <button id="lf_wizard_send" class="menu_button lf-btn-primary lf-wizard-send" type="button">${SEND_LABEL}</button>
                </div>
            </div>
        </div>
    `);

    renderChat();
    renderSources();
    renderHeaderMeta();

    root.find(".lf-wizard-sources, #lf_wizard_meta").on("click", showSources);

    // ---- Sessions bar (Stage 21) ----
    root.find(".lf-session-chip").on("click", function () {
        const id = String($(this).data("id"));
        if (switchWizardSession(id)) {
            renderWizard();
            setStatus(`Switched to wizard session`);
        }
    }).on("dblclick", function () {
        const id = String($(this).data("id"));
        const current = listWizardSessions().find(x => x.id === id);
        const name = window.prompt("Rename session:", current?.name || "");
        if (name === null) return;
        if (renameWizardSession(id, name)) renderWizard();
    }).on("contextmenu", function (e) {
        e.preventDefault();
        const id = String($(this).data("id"));
        const sess = listWizardSessions().find(x => x.id === id);
        if (!sess) return;
        if (!window.confirm(`Delete session "${sess.name}"? Sources, chat and proposals in it are gone.`)) return;
        deleteWizardSession(id);
        renderWizard();
        setStatus("Session deleted");
    });

    root.find(".lf-session-new").on("click", function () {
        const name = window.prompt("New wizard session name:", "");
        if (name === null) return;
        createWizardSession(name.trim() || undefined);
        renderWizard();
        setStatus("New wizard session created");
    });

    // Chat + extraction
    $("#lf_wizard_send").on("click", onSend);
    $("#lf_wizard_extract").on("click", onExtract);
    $("#lf_wizard_input").on("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
        }
    });
    root.find(".lf-quick-chip").on("click", function () {
        if ($("#lf_wizard_send").prop("disabled")) return; // a reply is in flight
        $("#lf_wizard_input").val(QUICK_FORGE[Number($(this).data("i"))].prompt);
        onSend();
    });

    root.find(".lf-wizard-clear").on("click", function () {
        const w = getWizardSession();
        if (!w.messages.length && !w.proposals.length) return;
        if (!window.confirm("Delete the wizard conversation AND all pending proposals? Sources and canon rules stay. Accepted drafts are already saved.")) return;
        clearWizardMessages();
        renderChat();
        setStatus("Wizard chat cleared");
    });
}

export function initWizard() {
    document.removeEventListener("lf-wizard-add-source", onDraftToWizard);
    document.addEventListener("lf-wizard-add-source", onDraftToWizard);
    renderWizard();
    console.log(`[${extensionName}] Wizard initialized (${getWizardSession().sources.length} sources, ${getWizardSession().messages.length} messages, ${getWizardSession().proposals.length} proposals)`);
}
