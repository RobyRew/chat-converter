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

## ADR-0008 — The site is a static-web image at chat-converter.robyrew.com (2026-11-08) · Accepted
**Context:** The site in `web/` is static: every conversion runs in the visitor's browser. The RobyRew fleet
serves static sites from `ghcr.io/robyrew/static-web` (pinned, non-root nginx, one security-header set), built
on GitHub's runners by `RobyRew/platform`'s reusable `build-image.yml` so the 2 GB VPS never builds, and pulled
by Dokploy.
**Decision:**
- `Dockerfile` at the repo root: `node:22-alpine` installs the root (the library's dependencies, which the site
  bundles through `file:..`), then `web/`, runs `npm run build --prefix web`, and copies `web/dist` onto
  `ghcr.io/robyrew/static-web:1`. The default CSP is kept: the converter's worker is a same-origin file and the
  page loads nothing from other hosts (no analytics script).
- `.dockerignore` keeps `.real-exports/` (local runs against real exports) out of any build context.
- `.github/workflows/build-image.yml` calls the platform workflow on pushes to `main`; it publishes
  `ghcr.io/robyrew/chat-converter:{latest,<sha>}` and calls the Dokploy webhook (`DOKPLOY_DEPLOY_WEBHOOK`). The
  Dokploy app (project Tools) pulls `:latest` and serves port 8080 at `chat-converter.robyrew.com`.
**Status:** Accepted.

## ADR-0009 — Without a save dialog, packages stream into a download through a service worker (2026-11-08) · Accepted
**Context:** Safari and Firefox have no `showSaveFilePicker`. Packages were built in the site's browser storage
(OPFS) and handed to the downloads through a `blob:` URL. In Safari an 11.18 GB telegram-ios package built that
way, and Safari cancelled the hand-off twice after 0 bytes (`NSURLErrorDomain -999`); the stored copies also took
11 GB of disk each until 0.1.2 started removing them. Safari has streamed service-worker downloads since 15.4.
**Decision:**
- `src/ui/download-sw.js` (classic service worker, emitted next to the element through
  `new URL('../ui/download-sw.js', import.meta.url)`, scope = its folder) answers
  `<scope>cc-download/<id>/<name>` with a `Content-Disposition: attachment` response streamed from a MessagePort.
- `startStreamedDownload()` registers the id with a data port and a control port, opens a hidden frame on that
  URL, and keeps the service worker alive with a message every 10 s. The conversion worker gets the data port as
  a `{ kind: 'port' }` destination and posts one chunk per `pull` (the response stream's queue is 8 chunks), so
  memory stays bounded at any package size. `cancel` from the browser aborts the conversion; an aborted
  conversion errors the download.
- Order: save dialog (Chromium) → streamed download → browser storage, which is used when there is no service
  worker or the control port does not report `started` within 10 s (remembered for the page's lifetime).
- Safari users are told to turn off "Open safe files after downloading", which unzips `.zip` downloads.
**Status:** Accepted.

## ADR-0010 — An app-frame UI: container-query panes, menus, and site pages (2026-11-09) · Accepted
**Context:** The owner found the web UI ugly, unintuitive, not responsive and outdated, and asked for a complete
redo for phone and desktop with menus. The element was a document-style page: a sidebar of cards (details, ten
target cards, options, result) above or beside the preview, so on a phone the preview came after several screens of
forms; emoji icons; no menus. The site was one page that linked to GitHub for everything else.
**Decision:**
- The element renders a start screen (drop area, per-app export guides, three steps), then an app frame: a top bar
  over panes laid out by container queries on the element — one pane with bottom tabs below 760 px, the chat beside
  one side pane up to 1180 px, Details · Chat · Export side by side above. Breakpoints follow the element's width,
  not the window's, because hosts (the site, ChatForge) give it different widths. `--cc-app-h` sets the height.
- Menus and sheets are modal `<dialog>`s appended inside the element: the top layer avoids clipping by the panes'
  overflow and z-index fights with the host, and the dialog brings focus trapping and Escape. A popover on wide
  screens, a bottom sheet below 640 px.
- Icons are SVG strings in `src/ui/icons.ts` (no dependency), exported as `./ui/icons` so the site renders the same
  set at build time.
- The output list (short names, notes, groups, whether media is carried) and the per-app export guides are data in
  `src/targets/index.ts` (`OUTPUT_FORMATS`, `OUTPUT_GROUPS`, `EXPORT_GUIDES`, exported as `./targets`), so the
  element and the site's Formats and Guide pages read one source.
- Light colours apply under `[data-theme='light']` only. ChatForge has no house theme stamp and a dark page; keying
  the light palette on `prefers-color-scheme` would turn the element light inside it on a light-mode OS.
- Changing the target, an option or an edit re-renders the pane it affects instead of the whole frame, to keep the
  chat preview's scroll position.
- On touch screens the leave-out button of a message shows after a tap on it; a permanent button on every message
  crowded a phone-width chat.
- The site gains a header (Convert · Formats · Guide, Auto/Light/Dark, Source; a menu button below 760 px), the
  `/formats` and `/guide` pages, and a footer.
**Status:** Accepted.

## ADR-0011 — Node 26 and TypeScript 7; Astro's checker runs on a TypeScript 6 alias (2026-11-09) · Accepted
**Supersedes** the `node:22-alpine` build stage of ADR-0008.
**Context:** The owner set the rule on 2026-11-09: the newest Node LTS and TypeScript 7 from now on, and new
releases adopted as they ship. Node 26 has been the newest LTS since 2026-10-28; TypeScript 7.0.2 is the newest
stable release. The library already compiled with TypeScript 7. The site stayed on 6.0.3 because Astro's checker
(`@astrojs/check` 0.9.12, the newest) drives TypeScript's JavaScript API, which the TypeScript 7 compiler does not
ship, and declares `typescript ^5 || ^6` as a peer. npm refuses that peer next to a direct `typescript@7`, and
`overrides` do not change how a peer is satisfied (tried on 2026-11-09: ERESOLVE).
**Decision:**
- `engines.node` is `>=26` in both `package.json` files, `@types/node` follows (`^26`), and the Docker build stage
  is `node:26-alpine`. TypeScript 7's Linux x64 binary is a statically linked Go executable, so it runs on Alpine's
  musl.
- The site depends on `typescript@^7` (`tsc --noEmit` covers its `.ts` files) and on `@astrojs/language-server`
  instead of `@astrojs/check`. `web/scripts/astro-check.mjs` runs the language server's `AstroCheck`, which is what
  `astro check` runs, with an explicit TypeScript: the `typescript-6` alias (`npm:typescript@^6.0.3`).
  `npm run check` = `astro sync && tsc --noEmit && node scripts/astro-check.mjs`, and the build runs it before
  `astro build`. On 2026-11-09 a type error planted in an `.astro` file and one in a `.ts` file each made it exit 1.
- When Astro's checker accepts TypeScript 7, `astro check` replaces the script and the alias is removed.
- Raising the minimum Node version is a breaking change for consumers on older Node, hence 0.3.0. ChatForge
  installs with `engine-strict=false`, so it prints a warning until it moves to Node 26 itself.
**Status:** Accepted.

## ADR-0012 — The converter page as a landing page; the site on ui v0.4.0 (2026-11-11) · Accepted
**Context:** The owner found the front page boring: no image and a lot of text (a hero paragraph, then the start
screen's long drop text and three text-only steps). He also asked for light and dark to feel like one family without
harsh contrast; ui v0.4.0 (2026-11-11) made both themes neutral greys with glass that follows the theme and added
`--on-accent`.
**Decision:**
- The page is a landing page around the converter: a short hero with screenshots of the converter itself (a
  fictional chat; desktop window plus phone), the converter at `#convert`, illustrated steps, six features, a
  sources → UniversalChat → formats diagram and a closing call to action. All of it is `.landing` and hides once an
  export is open.
- Screenshots come from the app, not a mock-up: `web/scripts/screenshots.mjs` renders the workspace in WebKit and
  `cwebp` writes them to `web/public/img/` (85–94 KB desktop, 47–49 KB phone). Each theme has its own set; CSS shows
  the one matching `data-theme`, and both are `loading="lazy"` so the hidden set is not fetched.
- The site moves to web-config v0.4.0. The header's theme switch uses `initThemeControls()` from
  `@robyrew/ui/theme.js` instead of its own script, and the light-theme `--t-alpha` override for the old dark glass
  is removed. The page maps the element's `--cc-primary` / `--cc-on-primary` to `--accent` / `--on-accent`; the
  element keeps its own defaults for hosts without the house tokens.
- In the element: the drop text is one line (the app chips sit under it), and sender names take a darker lightness
  on light pages (`--cc-who-l`), where yellow and green hues were faint on white bubbles.
**Status:** Accepted.

