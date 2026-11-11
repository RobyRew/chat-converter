# Chat Converter

Convert a chat export from one app into the format another app imports — entirely on your own
machine. Drop a Telegram Desktop export (HTML, JSON or both, with media) and get, for example, the
exact package Telegram's own importer accepts.

**Reads:** Telegram Desktop (HTML, JSON), WhatsApp (`.zip`, `_chat.txt`, any language), Instagram and
Facebook Messenger downloads (HTML, JSON), Snapchat (JSON, HTML), VSCO, Hinge, and UniversalChat.
Account downloads holding many conversations open on an inbox: search every message, filter, open one,
or convert several at once.

**Writes:** Telegram's import package (iOS with media, Android text-only), WhatsApp's own export layout,
UniversalChat (the lossless archive), HTML, Markdown, Telegram-style JSON.

- **Private by construction:** parsing and conversion run in your browser (Web Worker) or in Node.
  Nothing is uploaded.
- **Lossless core:** every format goes through one canonical model; every conversion reports what
  was preserved, approximated or dropped, with counts.

> Work in progress — see `agents.md` for decisions and `docs/` for format references.

## Command line

```sh
npm run cli -- inspect <export folder or zip>
npm run cli -- convert <export> --target telegram-ios --chat "Ana Pop"
npm run cli -- convert <export> --target universalchat-zip --all
```

See `docs/app.md`.

## Use as a library

```sh
npm i github:RobyRew/chat-converter#v0.3.1
```

```ts
import { importArchive, writePackage, writeBatch } from '@robyrew/chat-converter';
```

The package exports TypeScript source; bundlers (Vite, esbuild) and Vitest/tsx transpile it. It requires
Node 26 or newer and is type-checked with TypeScript 7.

The converter UI is a framework-free custom element any page can host:

```ts
import { defineChatConverter } from '@robyrew/chat-converter/ui';
import '@robyrew/chat-converter/ui/styles.css';
defineChatConverter(); // <chat-converter-app></chat-converter-app>
```

## Site

`web/` is the site at <https://chat-converter.robyrew.com>: the converter (`/`), the formats it reads and
writes (`/formats`) and a step-by-step guide from export to Telegram import (`/guide`), with light and dark
themes. It is published as `ghcr.io/robyrew/chat-converter` (the root `Dockerfile` on
`ghcr.io/robyrew/static-web`, built by `.github/workflows/build-image.yml` through RobyRew/platform). See
ADR-0008, ADR-0010 and ADR-0011 (Node 26, TypeScript 7) in `agents.md`, and `docs/app.md` for the UI.

## License

Apache-2.0 — see `LICENSE` and `NOTICE`.
