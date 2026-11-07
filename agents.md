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
