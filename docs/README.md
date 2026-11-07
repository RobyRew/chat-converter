# Chat Converter documentation

What exists now. Decisions and their reasons are in [`../agents.md`](../agents.md).

- [`universalchat.md`](universalchat.md) — UniversalChat, the versioned document every import produces and every
  conversion goes through.
- [`import-targets.md`](import-targets.md) — which apps can import a chat, what they accept, and the matching target.
- [`app.md`](app.md) — the web app and CLI: the inbox for multi-conversation exports, search, batch conversion.
- Formats:
  - [`formats/telegram-desktop-export.md`](formats/telegram-desktop-export.md) — Telegram Desktop's HTML and JSON
    exports, folders, placeholders, the per-file size limit, the HTML time-zone label.
  - [`formats/whatsapp-export.md`](formats/whatsapp-export.md) — WhatsApp's export byte format, media names,
    markers in other languages.
  - [`formats/telegram-import.md`](formats/telegram-import.md) — how Telegram's iOS and Android apps import, the API
    flow, and what the `telegram-ios` / `telegram-android` packages contain.
  - [`formats/meta-export.md`](formats/meta-export.md) — Instagram and Facebook Messenger downloads (HTML and JSON):
    thread folders, message slots, shares, reactions, times without a zone.
  - [`formats/snapchat-export.md`](formats/snapchat-export.md) — Snapchat's chat and snap history, chat media by
    Media ID, display names, the HTML-only download.
  - [`formats/vsco-and-hinge-exports.md`](formats/vsco-and-hinge-exports.md) — VSCO messages and journal shares;
    Hinge matches, likes and the one-sided chats it exports.
