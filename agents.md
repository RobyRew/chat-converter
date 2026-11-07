# Chat Converter — Architecture Decision Log & Agent Guide

> **This file records *why* things are the way they are.** Append an ADR (Context · Decision ·
> Rationale · Status · Date) whenever a decision is made; never rewrite an old one — supersede it.
> `docs/` describes *what exists now* and is edited in place. Agents working in this repo read this
> file first.

Chat Converter turns a chat export from one app into the format another app imports. It reads the
user's *own* export files (no scraping, no accounts), runs entirely on the user's machine (browser
Web Worker or Node), and goes through one lossless canonical model so every conversion reports what
was preserved, approximated or dropped.

## Origin
The engine and the canonical model were developed inside ChatForge
(`RobyRew/chatforge`, `packages/core` + the model half of `packages/types`) and **moved** here at
ChatForge commit `d2e3b2d` (2026-10-27). ChatForge now consumes this repo as a dependency instead of
keeping its own copy. Decisions taken while the code lived in ChatForge are carried below with their
original numbers (`CF-ADR-xxxx`); ChatForge's `agents.md` keeps the full text.

## Repository layout
```
chat-converter/
├── package.json      @robyrew/chat-converter — the library, at the repo root (raw-TS exports)
├── src/
│   ├── model/        canonical model, capability matrix, platform/format ids, fidelity report (zod)
│   ├── engine/       contracts, registry, pipeline, fidelity, ids, richtext, format, transforms
│   ├── importers/    one file per source format
│   ├── exporters/    one file per target format
│   └── worker/       Web Worker entry + message types
├── test/             vitest; synthetic fixtures only — never commit personal chat data
├── docs/             what exists now: formats, import targets, canonical model
├── agents.md         this file
└── web/              the standalone web app (its own package.json, depends on "file:..")
```

## Conventions
- **TypeScript strict** (`noUncheckedIndexedAccess`, `noUnusedLocals`, …). Parsers are defensive:
  never assume a regex group or array index exists.
- **The source must also type-check under consumers' compilers.** Exports are raw `.ts`, so a
  consumer (ChatForge, TS 5.7) type-checks these files with its own `tsc`. Use no syntax newer than
  what TS 5.7 accepts.
- **zod is a peer dependency** so a consumer and this package share one zod instance.
- **Deterministic ids** — hash-derived, never `Math.random()`.
- **Timestamps** are epoch ms UTC plus the original offset when known.
- **Lossless first** — anything a target cannot represent is counted in the fidelity report, never
  dropped silently.
- **Comments, commits and docs describe what changed and why.** They never assert that something
  "works" or is "verified"; observed behaviour is recorded with its date and app version.

---

# Decisions carried from ChatForge (summaries; full text in ChatForge `agents.md`)

- **CF-ADR-0009 — Plugin registry + lossless canonical model + fidelity report (2026-06-01).**
  Importer/Exporter contracts behind a registry keyed by platform/format; every conversion emits a
  fidelity report. Adding a platform = adding one file.
- **CF-ADR-0012 — ZIP handling: fflate (2026-06-01).** Superseded for large archives by ADR-0002.
- **CF-ADR-0013 — Packages export source TS (2026-06-01).** Still the rule here: consumers transpile
  (Vite, Vitest, esbuild, tsx); no build step.
- **CF-ADR-0015 — WhatsApp inline markup ↔ entities (2026-06-01).** `*bold*`, `_italic_`, `~strike~`,
  ```` ```mono``` ```` parse into entities and render back; word-boundary rules keep `2*3=6` and
  `snake_case` intact. Underline/spoiler/links have no WhatsApp syntax → `entities: approximated`.
- **CF-ADR-0016 — Telegram polls/locations/contacts textualized (2026-06-01).** Superseded by
  ADR-0003 (structured fields in model v2).
- **CF-ADR-0017 — Conversion = import → edit → export (2026-06-01).** `applyEdits(conv, Edits)` is a
  pure, reversible patch applied between import and export.
- **CF-ADR-0029 — zod 4 (2026-10-25).** `meta` fields are `z.record(z.string(), z.unknown())`;
  `CapabilityMatrixSchema` is a `z.partialRecord`.

---

# Decisions

## ADR-0001 — Own repository; library at the root, distributed by git tag (2026-11-07) · Accepted
**Context:** The converter is wanted as a standalone web app whose improvements ChatForge picks up
automatically, without copying code and without a monorepo. The house pattern for shared packages
(`RobyRew/ui`, `RobyRew/web-config`) is a public repo per package installed from a git tag
(`github:RobyRew/<repo>#vX.Y.Z`); GitHub Packages was rejected there because installs need
authentication even for public packages, which would break forks. npm cannot install a
sub-directory of a git repository.
**Decision:** The library lives at the root of `RobyRew/chat-converter` as `@robyrew/chat-converter`,
exporting raw TS. The web app lives in `web/` with its own `package.json` and depends on
`"@robyrew/chat-converter": "file:.."`, so it always runs the current source. `files` in the root
`package.json` keeps `web/` out of installs. Releases are git tags `vX.Y.Z`.
**Rationale:** One project, one repo; a fork of this repo is a complete, working converter, and a
fork of ChatForge resolves this package from its public tag.
**Status:** Accepted.

## ADR-0002 — Lazy sources and streamed archives with zip.js (2026-11-07) · Accepted
**Supersedes CF-ADR-0012 for archives.**
**Context:** A Telegram Desktop export is a folder: `result.json` and/or `messages*.html` plus
`photos/`, `video_files/`, `voice_messages/`… A real one used to design this is 506 MB with 2,286 media
files (more with every media type ticked; Telegram's per-file limit is 4000 MiB). The ChatForge engine
took one `Uint8Array` and inflated every zip entry into memory with fflate's `unzipSync`, and no
exporter carried media, so neither folders nor media-complete output were possible.
**Decision:**
- Inputs are a `Source` of `SourceFile`s (`path`, `size`, `bytes()`, `head(n)`, `stream()`). Builders
  cover dropped folders / file inputs (browser `File` handles), zips (zip.js `ZipReader` over a
  `BlobReader`: only the central directory is read up front), in-memory bytes, and Node folders
  (`fs.openAsBlob`, disk-backed). Junk (`.DS_Store`, `__MACOSX/`, AppleDouble) is dropped; folders shared
  by every file are stripped; several dropped exports become several sources.
- Importers read only chat files; `MediaStore` indexes `SourceFile` handles by path; `detect` is async.
- Package outputs stream through `ZipSink` (zip.js `ZipWriter`) into any `WritableStream`: a file
  picked with the File System Access API, an OPFS file (sync access handle, which Safari supports in
  workers), a Node file, or memory. Media is stored (level 0), text deflated. Every name carries the
  UTF-8 flag (bit 11); a known size keeps entries out of Zip64 below 4 GB.
- Zip entry names without the UTF-8 flag are decoded as UTF-8 when the bytes are valid UTF-8, else CP437.
  WhatsApp writes UTF-8 names without the flag (its contact cards carry U+200E).
- fflate is removed; `strToU8`/`strFromU8` are `TextEncoder`/`TextDecoder`, `zipFiles()` is async.
**Rationale:** zip.js reads lazily, writes streams, handles Zip64, and runs unchanged in browsers,
workers and Node. One zip library instead of two.
**Status:** Accepted.

## ADR-0003 — Canonical model v2: structured events and omitted media (2026-11-07) · Accepted
**Supersedes CF-ADR-0016.**
**Context:** Writing Telegram's import package needs polls, checklists, locations, contacts, calls and
service events as data, not as pre-rendered text, and needs to know *why* a file is absent.
**Decision:** `SCHEMA_VERSION = 2`. Messages gain optional `poll`, `checklist`, `location`, `contact`,
`call`, `service`, `viaBot`; attachments gain `present`, `omitted` (`not_included` | `too_large` |
`unavailable` | `missing`), `stickerFormat`, `emoji`, `round`, `spoiler`, `selfDestructSec`; forwards gain
`handle`; `messageKinds` gains `checklist`. Readable fallback `content` is still filled for formats
without these types. Every v1 document is a valid v2 document; `upgradeConversation()` validates and
stamps the version (ChatForge Vault items are v1).
**Status:** Accepted.

## ADR-0004 — Telegram HTML export as a first-class input; wall-clock times use an IANA zone (2026-11-07) · Accepted
**Context:** A real 32,405-message chat exported three ways (HTML only, JSON only, both + media) holds
the same message ids in the same order in HTML and JSON, so the HTML export loses no message. Its date
tooltip (`28.04.2023 19:24:27 UTC+00:00`) carries the export machine's *standard* offset on every
message, including summer ones that were really UTC+1, and it has no sender ids, unix times or edit
marks; service lines have no time at all.
**Decision:** The Telegram importer reads `result.json` when present and otherwise parses
`messages*.html` in page order with htmlparser2 (workers have no DOMParser). Wall-clock times are
converted with `ParseContext.timeZone` (default: the converting machine's zone); the offset label is
ignored and only recorded. In an hour repeated by a DST change the earliest instant is used. HTML
service lines take the previous message's time (`meta.htmlTimeInferred`). A document sent "as file"
stays kind `file` whatever its MIME type, matching how the HTML shows it.
**Rationale:** Measured on the real export with zone Europe/London: HTML and JSON agree on kind,
sender, time to the second, text, entities, attachments, replies, forwards, reactions and call
durations for all non-service messages; the synthetic fixture under `test/fixtures/telegram-export`
pins the same parity in CI without personal data.
**Status:** Accepted.

## ADR-0005 — Two WhatsApp-format packages: faithful to WhatsApp, and tuned to Telegram's importer (2026-11-07) · Accepted
**Context:** Telegram imports chats only as WhatsApp (or LINE/KakaoTalk) exports. Its iOS client
(Telegram-iOS `ShareExtensionContext.swift` / `ChatImportActivityScreen.swift` @ `24638bc`) accepts one
`.zip`, takes the first entry matching `_chat\.txt` as the chat, uploads every other non-empty entry,
and types each upload by its *name*: `.*?\.jpg` photo, `\d+-VIDEO-.*?\.mp4` video,
`\d+-STICKER-.*?\.webp` sticker, `\d+-AUDIO-.*?\.opus` voice, anything else a file; `file_name` is the
path inside the zip; SSZipArchive decodes unflagged names from DOS-made zips as CP437; one failed upload
aborts the whole import. Android (`LaunchActivity.java` @ `3de37c8`) takes the first `.txt` of a zip,
never uploads media from a zip, and refuses a history file over 32 MiB. Real WhatsApp 2026 exports
(iOS/macOS) put media first and `_chat.txt` last, end each message with CRLF and break lines inside a
message with LF, and mark media lines with U+200E.
**Decision:** One generator (`exporters/whatsapp-format.ts`) writes WhatsApp's byte format; three
package exporters stream it with media:
- `whatsapp-zip` — WhatsApp's own layout and names (`_chat.txt` last, `-GIF-`), edit markers kept.
- `telegram-ios` — `_chat.txt` first; flat entries; GIFs and round videos as `-VIDEO-….mp4` (iOS has no
  GIF type; `.MOV` renamed to `.mp4`); voice `.ogg` → `-AUDIO-….opus` (same Ogg Opus bytes); webp
  stickers `-STICKER-`; documents keep their name, sanitised and neutralised so no regex retypes them
  and none looks like a main chat file; contacts as `.vcf` (rebuilt from the contact fields when the
  export has no vCard); zero-byte files become "omitted" markers.
- `telegram-android` — the same zip, with warnings that only the text is imported and about 32 MiB.
`whatsapp-txt` uses the same generator for the text alone.
WhatsApp messages keep their raw body (`meta.waRaw`, marks included) on import and are written back
verbatim while their text is unchanged; the two real WhatsApp exports used here round-trip
byte-identical through `whatsapp-zip`.
**Unverifiable from source:** how Telegram's *server* parses the text (which sender is the importing
user in a private chat, the time zone of the wall-clock times, whether it reads WhatsApp markup or the
edit marker). The private-chat notice line is attributed to the other person, as in WhatsApp's own
exports; a test import settles the rest and is recorded in `docs/formats/telegram-import.md`.
**Status:** Accepted.

## ADR-0006 — UniversalChat 1.0: one versioned document for any number of conversations (2026-11-07) · Accepted
**Context:** The owner wants every conversion to go through one universal, versioned format ("UniversalChat"),
future formats added without breaking it, and ChatForge to adopt it. Account-wide exports (Instagram,
Messenger, Snapchat, VSCO, Hinge, Telegram full exports) hold many conversations, so the old one-conversation
shape was not enough. (Two attempts to run a design panel on this did not complete; the design below was made
directly and is open to revision before ChatForge adopts it.)
**Decision:**
- Document `{format: "UniversalChat", version: "1.0.0", generator, createdAt, source, conversations[], ext}`;
  conversations keep the existing model (schemaVersion 2) plus `selfId`, `ext` and a media manifest with package
  paths. Package: `universalchat.json` first, media under `media/<conversation index>/<original path>`.
- Platform data goes under `ext.<platform>` (WhatsApp's round-trip fields moved from loose `meta` keys to
  `ext.whatsapp`); the source record stays in `message.raw`.
- Semver: newer major refused; minor = additions; all zod objects are loose so unknown fields survive; unknown
  list values map to a fallback with the original under `ext.universalchat`.
- `importArchive()` returns a UniversalChat document; importers of account exports implement `parseArchive`,
  single-chat importers keep `parse` and are wrapped. `readUniversalChat()` also accepts ChatForge's v1/v2 vault
  conversations.
**Rationale:** one shape for single chats and whole accounts, lossless by construction, and evolvable without
coordinated upgrades of every reader.
**Status:** Accepted. Spec: `docs/universalchat.md`.

## ADR-0007 — Account-wide exports: five importers, an inbox, batch conversion (2026-11-07) · Accepted
**Context:** The owner's Instagram, Facebook, Snapchat, VSCO and Hinge downloads each hold many conversations
(Instagram: 92 threads, 31,251 messages), in layouts no importer read. A one-conversation UI cannot navigate them,
and converting them one by one is impractical. Their files reference media by the path from the download's own
root, which broke when a common top folder was stripped from every path.
**Decision:**
- Importers implement `parseArchive` and return every conversation: `meta.ts` (Instagram + Messenger, HTML slots
  and JSON), `snapchat.ts` (chat + snap history, Media IDs, friends/account names, HTML fallback), `vsco.ts`,
  `hinge.ts`. Structure was measured on the owner's downloads (counts only; no content in the repo) and is
  documented in `docs/formats/`. Text and links keep entities; Meta's generated "sent an attachment" line moves to
  `ext`; messages the export left empty or undated are kept and flagged (`contentUnavailable`, `timeInferred`).
- Wall-clock times (Meta HTML) use the chosen IANA zone; `WallClockSequence` picks, inside a repeated DST hour, the
  instant that keeps the order. Facebook's footer offset is checked against the zone and a mismatch is reported.
- `Source.root` records the folders stripped from every path; importers match their layout on the full path, and
  media references fall back to their longest existing tail when only part of a download was dropped.
- The worker keeps the whole archive per import and answers with `ConversationSummary` rows; new requests `open`,
  `search` (accent-insensitive, every message) and `batch`. `writeBatch` writes one UniversalChat document/package
  for all selected conversations, or a zip holding one package per conversation streamed into its entry
  (`ZipSink.addStream`), or one text file per conversation.
- The element opens multi-conversation exports on an inbox (search names or messages, sort, filter by folder/kind/
  media, multi-select, batch convert); per-conversation edits are kept while navigating. The CLI gains `--chat`
  and `--all`, and `inspect` lists conversations.
- `guessSelf` uses `conversation.selfId` when an importer set it.
**Rationale:** UniversalChat already holds many conversations (ADR-0006); keeping the archive in the worker keeps
the page light (it holds one conversation at a time) and lets batch output stream media without the page touching
the bytes. A zip of per-chat packages keeps each Telegram import file intact.
**Unverifiable from the exports:** the zone Meta's HTML times are written in (Facebook's footer gives one offset,
Instagram's none), the zone of Hinge's timestamps (read as UTC), and why Meta exports some messages empty.
**Status:** Accepted.
