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
