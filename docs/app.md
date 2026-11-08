# The web app and the CLI

## Web app (`web/`, the `<chat-converter-app>` element)

Everything runs in the browser; the engine runs in a module Web Worker (`src/worker/worker.ts`).

1. **Drop** a folder, a `.zip` or loose files. Several exports dropped together are listed and one is chosen.
2. **Import.** The worker builds a UniversalChat archive of every conversation in the export and keeps it, with
   the file handles, under the import's id. The page receives one summary per conversation (`ConversationSummary`:
   title, kind, counts, first/last time, last message preview, media present/total/bytes, folder, flags).
3. **Inbox** (exports with more than one conversation: Instagram, Messenger, Snapchat, VSCO, Hinge, UniversalChat
   packages):
   - search conversation names, or every message (accent- and case-insensitive; up to 500 hits listed with the
     total); a hit opens its conversation scrolled to the message;
   - sort by latest activity, oldest, most messages, name; filter by folder (inbox, requests, archived…), private
     or group, with media;
   - tick conversations and convert them together (below).
4. **Conversation** — the same workspace as a single-chat export: title, chat type, participants (rename, "Me"),
   date range, time zone, order, preview with remove/restore per message, output preview, convert. "← All
   conversations" returns to the inbox and ‹ › step through it; what was set on each conversation is kept while
   moving between them (an "edited" badge marks it in the inbox).
5. **Convert several** — one download for the ticked conversations, each with what was set on it:
   - UniversalChat (`.universalchat.zip` / `.json`): one archive holding all of them;
   - Telegram / WhatsApp packages: a zip holding one package per conversation (each inner `.zip` is the file to
     share to Telegram), streamed as it is written;
   - text formats: a zip with one file per conversation.

Saving a package (`.zip`):

- **Chromium** (Chrome, Edge): a save dialog; the worker writes into the picked file.
- **Safari 15.4+, Firefox:** a streamed download. The page registers `src/ui/download-sw.js` (a service worker
  the bundler emits next to the element), opens a hidden frame on `<scope>cc-download/<id>/<name>`, and the
  service worker answers it with a `Content-Disposition: attachment` response whose bytes the conversion worker
  writes through a MessagePort, one chunk per `pull`. Nothing is held in memory or in site storage; the page
  sends a keep-alive every 10 s while it runs.
- **Fallback** (no service worker, or the download did not start within 10 s): the package is built in this
  site's browser storage (OPFS) and then offered as a download; above 2 GiB a notice comes first. Stored
  packages are removed when the page opens, before the next conversion, on Start over and from "Remove from
  browser storage".
- Safari unzips downloaded `.zip` files while "Open safe files after downloading" is on (Settings → General);
  the page says so, because Telegram needs the `.zip` itself.

Worker requests: `import`, `open`, `search`, `export`, `package`, `batch`, `cancel`, `release`
(`src/worker/types.ts`). Host pages (ChatForge) listen to `cc-imported`, `cc-opened`, `cc-change`, `cc-converted`
and read `getConversation()`.

## CLI

```bash
npm run cli -- inspect <path>
```

```bash
npm run cli -- convert <path> --target telegram-ios --chat "Ana Pop"
```

```bash
npm run cli -- convert <path> --target universalchat-zip --all
```

- `inspect` lists every conversation of a multi-conversation export with its number, counts, dates, media and
  folder.
- `convert` takes `--chat <number|title>` (repeatable) or `--all`; one conversation is written as before, several
  are written as one download (same layouts as the web app). `--rename`, `--self` and `--mode` apply to every
  conversation that has the named participant.
