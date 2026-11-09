# The web app and the CLI

## Web app (`web/`, the `<chat-converter-app>` element)

Everything runs in the browser; the engine runs in a module Web Worker (`src/worker/worker.ts`).

### Layout

- **Start screen:** a drop area (folder, `.zip` or loose files; on touch screens "Choose a file" comes first), the
  source apps — each opens the steps to get its export (`EXPORT_GUIDES`, `src/targets/index.ts`) — and the three
  steps. Files dropped anywhere on the element open as a new export.
- **App frame** (once an export is open): a top bar (title, counts, a notes button when the export has notes, the
  ⋯ menu) over panes. The element is a size container (`container: cc`), so its own width decides the layout:

  | element width | one conversation | export with many conversations |
  |---|---|---|
  | < 760 px | one pane at a time; bottom tabs Chat · Details · Export | bottom tabs Chats · Convert |
  | 760–1179 px | Chat beside Details or Export (a switch tops the side pane) | list beside Convert several |
  | ≥ 1180 px | Details · Chat · Export side by side | list beside Convert several |

  The frame's height is `--cc-app-h` (default `100dvh - 7rem`). The site sets it to the space under its header
  and, on phones, drops the frame's radius and side borders so it fills the screen.
- **Details:** overview tiles (messages included, people, media in the export, dates), the source file or the
  export picker, notes about the export, title and chat type, people (rename, "Me"), date range and "put back"
  for left-out messages, time zone and order, "Reset all changes".
- **Chat:** bubbles with day separators; consecutive messages from one sender within five minutes are grouped;
  the − beside a message leaves it out (shown on hover, or after a tap on touch screens); a calendar control
  jumps to a date. **Output** shows the first 400 lines of the main file; **Report** groups the fidelity report
  into kept, rewritten and not carried.
- **Export:** the targets grouped as in `OUTPUT_FORMATS` / `OUTPUT_GROUPS` (`src/targets/index.ts`), options for
  WhatsApp-format targets, notices, the result with the import steps; the file name, the convert button and the
  progress stay pinned at the bottom. Host actions (`slot="actions"`) sit at the end of this pane.
- **Menus and sheets** (`src/ui/overlay.ts`) are modal `<dialog>`s appended inside the element: a popover under
  its button on wide screens, a sheet from the bottom edge below 640 px; Escape or a click outside closes them.
- **Theme:** dark by default; the light palette applies under an ancestor with `data-theme="light"` (the house
  theme stamp), not under `prefers-color-scheme`, so a dark host without that stamp stays dark. Colours read the
  house tokens (`--panel`, `--ink`, `--accent`…) when the page defines them.
- The element mirrors `data-phase` (empty | reading | ready | converting | done | error) and `data-view`
  (start | inbox | work) for host styling; the site hides its hero once `data-view` is not `start`.
- Icons are SVG strings in `src/ui/icons.ts`; the site renders the same set at build time (`./ui/icons`).

### Flow

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
4. **Conversation** — the same workspace as a single-chat export. "‹ Chats" returns to the inbox and ‹ › (or the
   ⋯ menu on phones) step through it; what was set on each conversation is kept while moving between them (an
   "edited" badge marks it in the inbox).
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

## Site pages (`web/src/pages/`)

- `/` — the converter. The hero shows only with the start screen.
- `/formats` — what the converter reads (`EXPORT_GUIDES`), what it writes (`OUTPUT_FORMATS`) and where the output
  imports (`IMPORT_TARGETS`), built from the library's data at build time.
- `/guide` — get your export, convert, import into Telegram (steps, limits and sources from `IMPORT_TARGETS`),
  questions.
- Header: Convert · Formats · Guide, a theme switch (Auto · Light · Dark; Light and Dark are stored under
  `localStorage.theme`, which the house theme bootstrap reads) and Source; below 760 px a menu button opens the
  same links and the theme switch. The header measures itself into `--site-head`.

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
