# Chat Converter documentation

What exists now. Decisions and their reasons are in [`../agents.md`](../agents.md).

- [`import-targets.md`](import-targets.md) — which apps can import a chat, what they accept, and the matching target.
- Formats:
  - [`formats/telegram-desktop-export.md`](formats/telegram-desktop-export.md) — Telegram Desktop's HTML and JSON
    exports, folders, placeholders, the per-file size limit, the HTML time-zone label.
  - [`formats/whatsapp-export.md`](formats/whatsapp-export.md) — WhatsApp's export byte format, media names,
    markers in other languages.
  - [`formats/telegram-import.md`](formats/telegram-import.md) — how Telegram's iOS and Android apps import, the API
    flow, and what the `telegram-ios` / `telegram-android` packages contain.
