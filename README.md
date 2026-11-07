# Chat Converter

Convert a chat export from one app into the format another app imports — entirely on your own
machine. Drop a Telegram Desktop export (HTML, JSON or both, with media) and get, for example, the
exact package Telegram's own importer accepts.

- **Private by construction:** parsing and conversion run in your browser (Web Worker) or in Node.
  Nothing is uploaded.
- **Lossless core:** every format goes through one canonical model; every conversion reports what
  was preserved, approximated or dropped, with counts.

> Work in progress — see `agents.md` for decisions and `docs/` for format references.

## Use as a library

```sh
npm i github:RobyRew/chat-converter#v0.1.0
```

```ts
import { importConversation, exportConversation } from '@robyrew/chat-converter';
```

The package exports TypeScript source; bundlers (Vite, esbuild) and Vitest/tsx transpile it.

## License

Apache-2.0 — see `LICENSE` and `NOTICE`.
