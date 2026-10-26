// Lorebook Wizard (Wizard tab): conversational lorebook builder.
// Stage 25 layout (v1/v2 convergence): the Wizard tab is a pure console —
// header, sessions strip, ONE flexible chat region, composer with
// quick-forge chips. The big addition: proposal cards render as a
// HORIZONTAL CAROUSEL INSIDE the assistant's message bubble (scroll-snap
// track + prev/next + counter), with Add/Reject per card. The Lorebook
// Deck (sources, canon rules, lorebook import, entries) lives in
// drafts.js. Source management lives there too — the wizard reads sources
// via activeSources().
// Proposals come ONLY from what the user agreed to in the chat (wizardExtract).
import { extensionName } from "./config.js";
import { escapeHtml, verifyQuote, icon, keysHtml, clampContextTokens, estimateTokens } from "./helpers.js";
import { getContext } from "../../../../extensions.js";
import { getSettings } from "./settings.js";
import { getWizardSession, activeSources,
         pushWizardMessage, clearWizardMessages,
         addWizardProposals, updateWizardProposal,
         listWizardSessions, createWizardSession, switchWizardSession,
         deleteWizardSession, renameWizardSession,
         editWizardMessage, deleteWizardMessage } from "./wizardData.js";
import { wizardChat, wizardExtract, omittedSourceTitles, selectHistory } from "./llmData.js";
import { saveDraft, renderDraftsList, updateResearchRail, clearSelection, getDrafts } from "./drafts.js";
import { applyUpdateToLorebook } from "./wiData.js";

const SEND_LABEL = `${icon("send")}Send`;
const EXTRACT_LABEL = `${icon("zap")}Propose from chat`;

// Quick-forge chips: canned wizard prompts (they go through onSend like typed text)
const QUICK_FORGE = [
    { icon: "key", label: "Suggest keys", prompt: "For each major entity in the sources, suggest SillyTavern trigger keys: 2-5 primary keys (name, common aliases, distinctive terms) and any secondary keys worth gating on. Keep keys short and avoid generic words that would fire constantly." },
    { icon: "compare", label: "Reconcile canon", prompt: "Reconcile the sources against the canon rules. List every contradiction or conflict between sources, say which version canon should keep and why, and flag anything the canon rules exclude." },
    { icon: "compress", label: "Compress tokens", prompt: "Which facts in the sources are essential for roleplay and which are trivia? Propose a token-lean structure for the entries: what to keep, what to merge, what to cut." },
    { icon: "pencil", label: "Draft entries", prompt: "Draft entries for the main entities in the active sources: one complete block per entity (ENTRY / KEYS / CONTENT), for my review. Stay within what the sources say." },
];

// Every session change (switch / create / delete / rename) must refresh
// BOTH the wizard console AND the deck + left rail. The deck/rail are owned
// by drafts.js and only re-render via renderDraftsList() — without this the
// deck keeps showing the previous session's sources. The `selected` Set in
// drafts.js is module-global, so it is cleared on any session change too.
function afterSessionChange() {
    clearSelection();
    renderWizard();
    renderDraftsList();
}

function setStatus(text) {
    $("#lf_studio_status").text(text);
}

function showSources() {
    document.getElementById("lf_studio_root")?.dispatchEvent(new CustomEvent("lf-show-sources"));
}

// The chat context budget from settings (tokens of transcript sent per call).
function chatContextTokens() {
    return clampContextTokens(getSettings().chatContextTokens);
}

// ---------- Chat ----------

// The id of the message currently being edited (null = no editor open).
// Only one editor may be open at a time.
let openEditorId = null;

// Drawn above the first message that no longer fits the context budget.
const CTX_DIVIDER = `<div class="lf-ctx-divider">Earlier messages are outside the context window</div>`;

function messageHtml(m, byId) {
    const who = m.role === "user" ? `${icon("arrow", "lf-ic-sm")}You` : `${icon("sparkles", "lf-ic-sm")}Wizard`;
    const time = m.ts ? ` · ${new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
    const props = m.role === "assistant" ? (byId.get(m.id) || []) : [];
    const carousel = props.length ? carouselHtml(props) : "";
    // v1's purple mono tag on bubbles that carry a proposal carousel
    const grounded = props.length ? `<span class="lf-grounded-chip" title="Evidence quotes checked against the chat and sources">Grounded Extraction</span>` : "";
    return `
        <div class="lf-msg ${m.role}" data-id="${escapeHtml(m.id)}">
            <div class="lf-msg-bubble${carousel ? " lf-msg-wide" : ""}">
                <div class="lf-msg-by">${who}${grounded}<span class="lf-msg-time">${time}</span><span class="lf-msg-tools">
                    <button class="lf-icon-btn lf-msg-edit" type="button" title="Edit this message">${icon("pencil", "lf-ic-sm")}</button>
                    <button class="lf-icon-btn lf-msg-delete" type="button" title="Delete this message">${icon("trash", "lf-ic-sm")}</button>
                </span></div>
                <div class="lf-msg-text">${escapeHtml(m.text)}</div>
                ${carousel}
            </div>
        </div>`;
}

// What a proposal's evidence quote may be copied from: the chat (where the
// agreed text lives) and the staged sources. Recomputed on every render, so
// editing or deleting a message updates the verdicts live.
function evidenceTexts(w = getWizardSession()) {
    return [...w.messages.map(m => m.text), ...w.sources.map(s => s.text)];
}

// The signature addition (v1 entry-preview → horizontal carousel):
// proposal cards ride INSIDE the message that proposed them — never as a
// separate full-chat surface. Cards are staged in DOM order; the track
// scroll-snaps card by card, with prev/next + counter in a slim header.
function carouselHtml(props) {
    const texts = evidenceTexts();
    return `
        <div class="lf-carousel" role="group" aria-label="Proposed entries">
            <div class="lf-carousel-head">
                <span class="lf-carousel-title">${icon("pull", "lf-ic-sm")}Proposed entries</span>
                <span class="lf-carousel-count"></span>
                <span class="lf-carousel-nav">
                    <button class="lf-icon-btn lf-car-prev" type="button" title="Previous entry">${icon("chevLeft", "lf-ic-sm")}</button>
                    <button class="lf-icon-btn lf-car-next" type="button" title="Next entry">${icon("chevRight", "lf-ic-sm")}</button>
                </span>
            </div>
            <div class="lf-carousel-track">${props.map(p => proposalCardHtml(p, verifyQuote(p.quote, texts))).join("")}</div>
        </div>`;
}

const VERDICTS = {
    verified: { icon: "✓", label: "In chat", title: "Quote found in the chat or sources", cls: "verified" },
    fuzzy:    { icon: "≈", label: "Near-match", title: "Near-match — check it", cls: "fuzzy" },
    missing:  { icon: "✕", label: "Unverified", title: "NOT found in the chat or sources", cls: "missing" },
};

function proposalCardHtml(p, verdict) {
    const v = VERDICTS[verdict];
    const isUpdate = p.action === "update";
    const footer = p.status === "pending"
        ? `
        <div class="lf-proposal-actions">
            <button class="menu_button lf-btn-primary lf-proposal-accept" type="button">${icon(isUpdate ? "reset" : "plus")}${isUpdate ? "Apply update" : "Add to Entries"}</button>
            <button class="menu_button lf-proposal-reject" type="button">Reject</button>
            <button class="lf-ghost-btn lf-proposal-copy" type="button" title="Copy entry content">${icon("copy")}Copy</button>
        </div>`
        : `<div class="lf-proposal-statusline lf-proposal-${p.status}">${p.status === "accepted"
            ? (isUpdate ? `✓ Applied → ${escapeHtml(p.target || "lorebook")}` : "✓ Added to Entries")
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

// Swap ONE card for its fresh markup (carousel node and grid node alike),
// without re-rendering the chat: no scroll jump, no carousel reset to card 1.
function refreshProposalCard(p) {
    if (!p) return;
    const html = proposalCardHtml(p, verifyQuote(p.quote, evidenceTexts()));
    $(`.lf-proposal[data-id="${CSS.escape(p.id)}"]`).replaceWith(html);
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
            <span class="lf-grounding-val">${Math.round(counts.verified / total * 100)}% in chat</span>
        </div>
        <div class="lf-grounding-bar" title="${counts.verified} in chat · ${counts.fuzzy} near-match · ${counts.missing} unverified">
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

    const texts = evidenceTexts(w);
    const verdicts = w.proposals.map(p => verifyQuote(p.quote, texts));
    if (!w.proposals.length) {
        grid.html(`
            <div class="lf-pane-empty">
                <div class="lf-reader-empty-icon">⚡</div>
                <h3>No proposals yet</h3>
                <p>Talk through an entry with the wizard and agree on it, then hit <b>⚡ Propose from chat</b> —<br>
                cards appear here with evidence quotes checked against the chat.</p>
            </div>
        `);
    } else {
        grid.html(w.proposals.map((p, i) => proposalCardHtml(p, verdicts[i])).join(""));
    }

    const counts = { verified: 0, fuzzy: 0, missing: 0 };
    for (const v of verdicts) counts[v]++;
    renderGrounding(counts, verdicts.length);
    updateResearchRail(counts, verdicts.length);

    // Pane header chip + top-tab badge (pending count only — the badge
    // disappears when nothing awaits review)
    const pending = w.proposals.filter(p => p.status === "pending").length;
    $("#lf_proposals_count").text(w.proposals.length ? `${pending} to review · ${w.proposals.length} total` : "");
    $("#lf_tab_proposals .lf-tab-badge").text(pending || "").toggleClass("lf-hidden", !pending);

    if (scrollEl) scrollEl.scrollTop = prevScroll;
}

// ---------- Message edit / delete ----------

// True while a wizard request is in flight — the tools are disabled then.
function isBusy() {
    return $("#lf_wizard_send").prop("disabled");
}

// Tear down an open editor without saving (used when switching editors).
function closeMessageEditor() {
    if (!openEditorId) return;
    const msgEl = $(`.lf-msg[data-id="${CSS.escape(openEditorId)}"]`);
    msgEl.find(".lf-msg-editor").remove();
    msgEl.find(".lf-msg-text").show();
    openEditorId = null;
}

function openMessageEditor(msgEl, m) {
    if (isBusy()) return;
    // Only one editor at a time — close any other before opening this one.
    if (openEditorId && openEditorId !== m.id) closeMessageEditor();
    const textEl = msgEl.find(".lf-msg-text");
    if (!textEl.length || msgEl.find(".lf-msg-editor").length) return;

    openEditorId = m.id;
    const original = m.text;
    textEl.hide();

    const editor = $(`
        <div class="lf-msg-editor">
            <textarea class="text_pole lf-msg-editor-text" rows="4"></textarea>
            <div class="lf-msg-editor-actions">
                <span class="lf-msg-editor-hint"><kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel</span>
                <button class="menu_button lf-msg-cancel" type="button">Cancel</button>
                <button class="menu_button lf-btn-primary lf-msg-save" type="button">${icon("check", "lf-ic-sm")}Save</button>
            </div>
        </div>
    `);
    editor.find(".lf-msg-editor-text").val(original);
    textEl.after(editor);
    editor.find(".lf-msg-editor-text").trigger("focus");

    // No chat re-render per keystroke — only on save.
    const cancel = () => {
        editor.remove();
        textEl.show();
        openEditorId = null;
    };
    const save = () => {
        const text = String(editor.find(".lf-msg-editor-text").val()).trim();
        if (!text) {
            toastr.warning("Message text is empty.", "Lorebook Forge");
            return;
        }
        editWizardMessage(m.id, text);
        openEditorId = null;
        renderChat();
        setStatus("Message edited");
    };

    editor.find(".lf-msg-cancel").on("click", cancel);
    editor.find(".lf-msg-save").on("click", save);
    editor.find(".lf-msg-editor-text").on("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
        } else if (e.key === "Escape") {
            // Swallow Esc so the global onStudioEsc doesn't close the Studio.
            e.stopPropagation();
            e.preventDefault();
            cancel();
        }
    });
}

// One delegated handler set for proposal cards wherever they render —
// the Proposals grid AND the in-message carousel.
function bindProposalActions() {
    $(document).off("click.lfprop")
        .on("click.lfprop", ".lf-proposal-copy", async function () {
            const w = getWizardSession();
            const p = w.proposals.find(p => p.id === $(this).closest(".lf-proposal").data("id"));
            if (!p) return;
            try {
                await navigator.clipboard.writeText(p.content);
                toastr.success(`Copied "${p.title}"`, "Lorebook Forge");
            } catch (err) {
                toastr.error(`Copy failed: ${err.message}`, "Lorebook Forge");
            }
        })
        .on("click.lfprop", ".lf-proposal-reject", function () {
            const id = $(this).closest(".lf-proposal").data("id");
            refreshProposalCard(updateWizardProposal(id, "rejected"));
            renderProposals();
            setStatus("Proposal rejected");
        })
        .on("click.lfprop", ".lf-proposal-accept", async function () {
            const w = getWizardSession();
            const p = w.proposals.find(p => p.id === $(this).closest(".lf-proposal").data("id"));
            if (!p) return;

            // Update proposal → write into the target lorebook directly (Stage 16b)
            if (p.action === "update" && p.target) {
                const target = w.lorebookTarget;
                if (!target) {
                    toastr.warning("No update target in this session. Import the lorebook (Lorebook Deck) or reject this card.", "Lorebook Forge");
                    return;
                }
                if (!window.confirm(`Apply this update to the entry "${p.target}" in lorebook "${target}"?\nThis REPLACES that entry's content in place.`)) return;
                const btn = $(this).prop("disabled", true).text("Applying…");
                try {
                    const res = await applyUpdateToLorebook(target, p.target, { content: p.content, keys: p.keys });
                    refreshProposalCard(updateWizardProposal(p.id, "accepted"));
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

            // New proposal → an Entry in the active session. The content is the
            // text the user agreed to in the chat, so it is stored verbatim.
            saveDraft({
                title: p.title,
                keys: p.keys.length ? p.keys : [p.title],
                content: p.content,
                sourceId: "",
                sourceUrl: "",
                sourceTitle: "Wizard chat",
                sourceRaw: p.quote,
                origin: "chat",
            });
            refreshProposalCard(updateWizardProposal(p.id, "accepted"));
            renderProposals();
            renderDraftsList();
            toastr.success(`"${p.title}" added to Entries.`, "Lorebook Forge");
        });
}

// Message tools (edit / delete). Delegated + namespaced so re-renders don't
// stack handlers.
function bindMessageActions() {
    $(document).off("click.lfmsg")
        .on("click.lfmsg", ".lf-msg-edit", function () {
            if (isBusy()) return;
            const msgEl = $(this).closest(".lf-msg");
            const id = String(msgEl.data("id"));
            const m = getWizardSession().messages.find(x => x.id === id);
            if (m) openMessageEditor(msgEl, m);
        })
        .on("click.lfmsg", ".lf-msg-delete", function () {
            if (isBusy()) return;
            const msgEl = $(this).closest(".lf-msg");
            const id = String(msgEl.data("id"));
            const w = getWizardSession();
            if (!w.messages.some(x => x.id === id)) return;
            const pending = w.proposals.filter(p => p.msgId === id && p.status === "pending").length;
            const extra = pending
                ? ` ${pending} pending ${pending === 1 ? "proposal" : "proposals"} on it will be removed too.`
                : "";
            if (!window.confirm(`Delete this message?${extra}`)) return;
            deleteWizardMessage(id);
            renderChat();
            setStatus("Message deleted");
        });
}

function renderChat() {
    const chatEl = $("#lf_wizard_chat");
    // The DOM is about to be replaced — any open editor goes with it.
    openEditorId = null;
    const w = getWizardSession();
    if (!w.messages.length) {
        chatEl.html(`
            <div class="lf-wizard-chat-empty">
                <div class="lf-reader-empty-icon">✨</div>
                <h3>Lorebook Wizard</h3>
                <p>Talk through the entries you want, and iterate until they're right.<br>
                Then hit <b>⚡ Propose from chat</b>: only what you agreed to becomes a card.<br>
                Proposals ride the reply as a horizontal carousel.</p>
            </div>
        `);
    } else {
        const byId = new Map();
        for (const p of w.proposals) {
            if (!p.msgId) continue;
            if (!byId.has(p.msgId)) byId.set(p.msgId, []);
            byId.get(p.msgId).push(p);
        }
        // Messages before this index are not sent to the model any more.
        const { firstIndex } = selectHistory(w.messages, chatContextTokens());
        chatEl.html(w.messages.map((m, i) =>
            `${i === firstIndex && i > 0 ? CTX_DIVIDER : ""}${messageHtml(m, byId)}`).join(""));
    }
    chatEl.scrollTop(chatEl[0].scrollHeight);

    // Carousel chrome: nav buttons + live counter per track (re-bound every
    // render — chatEl itself persists, only its contents are replaced).
    chatEl.find(".lf-carousel").each(function () {
        const track = $(this).find(".lf-carousel-track");
        const count = $(this).find(".lf-carousel-count");
        const update = () => {
            const n = track.children().length;
            const i = Math.min(n, Math.round(track.scrollLeft() / (track.children(":first").outerWidth() + 10 || 1)) + 1);
            count.text(`${i} / ${n}`);
        };
        track.on("scroll", update);
        update();
    });

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
    $("#lf_wizard_chat").addClass("lf-busy");
    renderChat();
    setStatus("Wizard is thinking…");

    try {
        const { reply, omitted } = await wizardChat({
            canonRules: w.canonRules,
            sources: activeSources(),
            history,
            message: text,
            contextTokens: chatContextTokens(),
        });
        pushWizardMessage("assistant", reply);
        renderChat();
        // Surface any sources dropped by the material cap instead of hiding it
        // in the console — the header chip shows it too.
        setStatus(omitted.length
            ? `Wizard replied — ${omitted.length} source${omitted.length === 1 ? "" : "s"} omitted from AI context (material cap)`
            : "Wizard replied");
    } catch (err) {
        console.error(`[${extensionName}] Wizard chat failed:`, err);
        toastr.error(`Wizard chat failed: ${err.message}`, "Lorebook Forge");
        setStatus(`Wizard chat failed: ${err.message}`);
        input.val(text);
    } finally {
        input.prop("disabled", false).trigger("focus");
        btn.prop("disabled", false).html(SEND_LABEL);
        $("#lf_wizard_chat").removeClass("lf-busy");
    }
}

// Proposals come from the AGREED part of the chat. Sources are not the input
// any more — they only matter for resolving updates to an imported lorebook.
async function onExtract() {
    const input = $("#lf_wizard_input");
    const btn = $("#lf_wizard_extract");
    const w = getWizardSession();
    if (!w.messages.length) {
        toastr.warning("Discuss an entry with the wizard first", "Lorebook Forge");
        return;
    }
    const focus = String(input.val()).trim();
    input.val("");
    btn.prop("disabled", true).text("…");
    setStatus(`Proposing entries from the chat${focus ? ` — focus: "${focus}"` : ""}…`);

    try {
        const { items, omitted } = await wizardExtract({
            canonRules: w.canonRules,
            history: w.messages,
            sources: activeSources(),
            focus,
            lorebookTarget: w.lorebookTarget,
            contextTokens: chatContextTokens(),
        });
        if (!items.length) {
            toastr.info("No agreed entries found yet", "Lorebook Forge");
            setStatus("No agreed entries found yet");
            if (focus) input.val(focus);
            return;
        }

        // The proposal carousel rides INSIDE the assistant message — push it
        // first so addWizardProposals can link every card to it via msgId.
        const focusMsg = focus ? pushWizardMessage("user", focus) : null;
        const msg = pushWizardMessage("assistant", "…");
        const proposals = addWizardProposals(items, msg.id);
        if (!proposals.length) {
            // Everything was already proposed or accepted: leave no trace in the chat.
            deleteWizardMessage(msg.id);
            if (focusMsg) deleteWizardMessage(focusMsg.id);
            toastr.info("Those entries are already proposed or accepted", "Lorebook Forge");
            setStatus("Nothing new to propose");
            if (focus) input.val(focus);
            return;
        }
        editWizardMessage(msg.id,
            `⚡ Proposed ${proposals.length} entr${proposals.length === 1 ? "y" : "ies"}${focus ? ` — focus: "${focus}"` : ""}. Review the carousel below — add what you like, reject the rest.`);

        const texts = evidenceTexts();
        const counts = { verified: 0, fuzzy: 0, missing: 0 };
        for (const p of proposals) counts[verifyQuote(p.quote, texts)]++;
        renderChat();
        setStatus(`Proposed ${proposals.length} (${counts.verified}✅ / ${counts.fuzzy}⚠️ / ${counts.missing}❌)`
            + (omitted.length ? ` · ${omitted.length} source${omitted.length === 1 ? "" : "s"} omitted (cap)` : ""));
    } catch (err) {
        console.error(`[${extensionName}] Proposal failed:`, err);
        toastr.error(`Proposal failed: ${err.message}`, "Lorebook Forge");
        setStatus(`Proposal failed: ${err.message}`);
        if (focus) input.val(focus);
    } finally {
        btn.prop("disabled", false).html(EXTRACT_LABEL);
    }
}

// ---------- Header meta ----------

function renderHeaderMeta() {
    const w = getWizardSession();
    const actives = activeSources();
    const totalChars = actives.reduce((n, s) => n + s.text.length, 0);
    $("#lf_wizard_meta").text(`${actives.length} active source${actives.length === 1 ? "" : "s"} · ${(totalChars / 1024).toFixed(1)} KB`);
    $("#lf_book_pill_name").text(w.lorebookTarget || "none");
    $("#lf_book_pill").toggleClass("is-set", !!w.lorebookTarget);

    // v1 header context chip: token estimate of the staged active sources.
    // Its tooltip adds the chat part: what the next reply will actually carry.
    const ctxChip = $("#lf_context_chip");
    if (ctxChip.length) {
        const srcTok = Math.round(totalChars / 4);
        const budget = chatContextTokens();
        const chatTok = selectHistory(w.messages, budget).messages
            .reduce((n, m) => n + estimateTokens(m.text), 0);
        ctxChip.toggleClass("lf-hidden", actives.length === 0);
        ctxChip.find("strong").text(`${(srcTok / 1000).toFixed(1)}k`);
        ctxChip.attr("title", `Sources ~${(srcTok / 1000).toFixed(1)}k tok · chat ~${(chatTok / 1000).toFixed(1)}k tok sent of ${(budget / 1000).toFixed(0)}k window`);
    }

    // "N sources omitted from AI context" warning chip — same cap math the
    // chat/extraction calls use (llmData.js), so it always matches the request.
    const omitted = omittedSourceTitles(actives);
    const omitChip = $("#lf_omit_chip");
    if (omitChip.length) {
        omitChip.toggleClass("lf-hidden", !omitted.length)
            .text(omitted.length ? `${omitted.length} source${omitted.length === 1 ? "" : "s"} omitted from AI context` : "")
            .attr("title", omitted.length ? `Over the per-call material cap — not sent to the AI: ${omitted.join(", ")}` : "");
    }

    // v1 "Active Model:" pill — real connection name, never a hardcoded model
    const modelChip = $("#lf_wizard_model");
    if (modelChip.length) {
        let name = "";
        try {
            const ctx = typeof getContext === "function" ? getContext() : null;
            name = ctx?.connectionManagerProfile?.name || ctx?.mainApi || ctx?.onlineStatus || "";
        } catch { /* no ST context — fall through to "Connected" */ }
        modelChip.text(`Active Model: ${name || "Connected"}`);
    }
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
                    <span id="lf_wizard_model" class="lf-chip lf-chip-good" title="The connection currently powering the Wizard"></span>
                    <span id="lf_wizard_meta" class="lf-chip lf-chip-good" title="Click to manage sources"></span>
                    <span id="lf_omit_chip" class="lf-chip lf-chip-warn lf-hidden" title=""></span>
                </div>
                <div class="lf-wizard-sub">Grounded WorldInfo extraction — every proposal is something you agreed to in the chat.</div>
            </div>
            <button class="lf-ghost-btn lf-wizard-deck" type="button" title="Sources, canon rules and imported lorebooks live in the deck">${icon("layers")}Lorebook Deck</button>
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
                          placeholder="Talk to the wizard… or name an entry to focus on, then hit Propose from chat"></textarea>
                <div class="lf-composer-foot">
                    <span class="lf-kbd-hints"><kbd>Enter</kbd> send <kbd>Shift+Enter</kbd> newline</span>
                    <button id="lf_wizard_extract" class="menu_button lf-btn-soft lf-wizard-extract" type="button" title="Propose entries from what you agreed to in the chat, with evidence quotes">${EXTRACT_LABEL}</button>
                    <button id="lf_wizard_send" class="menu_button lf-btn-primary lf-wizard-send" type="button">${SEND_LABEL}</button>
                </div>
            </div>
        </div>
    `);

    renderChat();
    renderHeaderMeta();

    // The deck (drafts.js) owns sources/canon/import — this just focuses it
    root.find(".lf-wizard-deck, #lf_wizard_meta").on("click", showSources);

    // ---- Sessions bar (Stage 21) ----
    root.find(".lf-session-chip").on("click", function () {
        const id = String($(this).data("id"));
        if (switchWizardSession(id)) {
            afterSessionChange();
            setStatus(`Switched to wizard session`);
        }
    }).on("dblclick", function () {
        const id = String($(this).data("id"));
        const current = listWizardSessions().find(x => x.id === id);
        const name = window.prompt("Rename session:", current?.name || "");
        if (name === null) return;
        if (renameWizardSession(id, name)) afterSessionChange();
    }).on("contextmenu", function (e) {
        e.preventDefault();
        const id = String($(this).data("id"));
        const sess = listWizardSessions().find(x => x.id === id);
        if (!sess) return;
        // deleteWizardSession() also drops this session's UNCOMMITTED entries
        // (drafts.js) — tell the user how many before they confirm.
        const uncommitted = getDrafts().filter(d => d.sessionId === id && !d.committedTo).length;
        const extra = uncommitted
            ? ` ${uncommitted} uncommitted ${uncommitted === 1 ? "entry" : "entries"} staged in it will be deleted too.`
            : "";
        if (!window.confirm(`Delete session "${sess.name}"? Sources, chat and proposals in it are gone.${extra}`)) return;
        deleteWizardSession(id);
        afterSessionChange();
        setStatus("Session deleted");
    });

    root.find(".lf-session-new").on("click", function () {
        const name = window.prompt("New wizard session name:", "");
        if (name === null) return;
        createWizardSession(name.trim() || undefined);
        afterSessionChange();
        setStatus("New wizard session created");
    });

    // Chat + proposals
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
        if (!window.confirm("Delete the wizard conversation AND all pending proposals? Sources and canon rules stay. Accepted entries are already saved.")) return;
        clearWizardMessages();
        renderChat();
        setStatus("Wizard chat cleared");
    });
}

export function initWizard() {
    // Delegated proposal actions cover BOTH the proposals grid and the
    // in-message carousels (one document-level set, .lfprop namespaced).
    bindProposalActions();
    // Message edit/delete tools (one document-level set, .lfmsg namespaced).
    bindMessageActions();
    // The Stage-as-source overlay (research.js) and the Lorebook Deck
    // (drafts.js → renderDraftsList) dispatch lf-sources-changed whenever a
    // source is staged, toggled, added, deleted or imported. Refresh ONLY the
    // header meta here — a full renderWizard() rebuilds the root via
    // root.html(...) and would wipe whatever the user is typing in the
    // composer (and re-render the chat). renderHeaderMeta() re-reads
    // activeSources(), so the "N active sources · KB" chip, the context token
    // chip and the "N sources omitted" warning chip all stay current.
    // Bound once, in init.
    document.getElementById("lf_studio_root")?.addEventListener("lf-sources-changed", renderHeaderMeta);
    renderWizard();
    console.log(`[${extensionName}] Wizard initialized (${getWizardSession().sources.length} sources, ${getWizardSession().messages.length} messages, ${getWizardSession().proposals.length} proposals)`);
}
