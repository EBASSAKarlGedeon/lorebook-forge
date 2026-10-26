# Lorebook Forge

A SillyTavern extension studio for building World Info (lorebook) entries from
web research, updating existing lorebooks, and reviewing every proposed entry
against the source it came from.

## What it does

Lorebook Forge turns web pages and pasted text into World Info entries through a
grounded, review-first workflow:

1. **Research** — search the web (SearXNG) or open a URL, read pages in an
   editable reader overlay, follow wiki links, and enumerate MediaWiki
   categories. Pages read this session are cached.
2. **Stage sources** — save a read page (or pasted text, or an imported
   lorebook) as a source in the Sources rail. Sources are context for the
   Wizard; they never become entries by themselves.
3. **Chat, then propose** — talk an entry through with the Wizard and iterate.
   When you agree on it, hit *Propose from chat*: only what you agreed to
   becomes a proposal, copied verbatim from the chat.
4. **Review** — proposals render as a horizontal carousel inside the Wizard
   reply, each with an evidence quote checked against the chat and sources.
   Add what you want to Entries, reject the rest.
5. **Commit** — accepted proposals are entries in the Entries panel. Commit
   them to any lorebook (new or existing), or export them as World Info JSON.

## The Studio

The Studio is a full-screen workspace opened from the extension drawer. It has
four regions:

- **Wizard** — the conversational console: sessions, chat, quick-forge chips and
  the proposal carousel.
- **Reader / Research** — SearXNG search and results. "Read" (or a pasted URL)
  opens the reader overlay, which is also where sources are staged.
- **Proposals** — every proposed entry for the active session, with evidence
  verdicts and a grounding meter.
- **Sources (left rail)** — sources, canon rules, lorebook import and web search.
- **Entries (right panel)** — accepted entries for the active session, batch
  commit and JSON export.

## Sessions

The Wizard is session-scoped: each session has its own sources, chat, proposals
and staged entries. Switch, create, rename (double-click a chip) and delete
(right-click a chip) sessions from the sessions strip. Deleting a session also
removes its uncommitted staged entries.

## Grounding

Every AI-proposed entry carries an evidence quote copied from the sources. The UI
verifies each quote against the staged source text and flags it:

- **Verified** — the quote appears verbatim in a source.
- **Near-match** — close but not exact; check it.
- **Unverified** — not found; treat with suspicion.

The Proposals pane and the left rail show the share of verified proposals as a
grounding meter.

## Canon rules

Per-session canon rules are prepended to every AI call and override the sources
whenever they conflict.

## LLM usage

All generation goes through the active SillyTavern connection profile using
`generateRaw`, falling back to `generateQuietPrompt` on older builds. Nothing is
written to any chat. When staged sources exceed the per-call material cap, the
omitted sources are surfaced in the Wizard header and the status line rather than
being dropped silently.

## Storage

Everything is stored in `extension_settings` under the extension's namespace and
survives a page refresh.

## Development notes

- No new dependencies.
- User-visible strings say "entry" (not "draft"); storage keys and DOM ids keep
  the original `draft` naming for compatibility.
- Cross-module UI requests use `CustomEvent`s on `#lf_studio_root` instead of
  circular imports.
- Source files are UTF-8 without BOM.

## Status

Active development.
