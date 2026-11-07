# Where a chat can be imported

Which apps can take in a chat history from a file, what they accept, and what Chat Converter writes for them. The
machine-readable version is `src/targets/index.ts`, which the web app's "How to import" panel uses.

| App · client | Imports from a file? | Accepts | Media | Chat Converter target |
|---|---|---|---|---|
| Telegram · iPhone & iPad | yes | one `.zip` with `_chat.txt` (WhatsApp, LINE, KakaoTalk formats) | yes | `telegram-ios` |
| Telegram · Android | yes | a `WhatsApp…zip`/`.txt` share | text only from a zip | `telegram-android` |
| Telegram · Desktop, Web, macOS | no | — | — | — |
| WhatsApp | no (restores only its own backups) | — | — | `whatsapp-zip` writes its export format |
| Signal | no | — | — | — |
| Discord, Messenger, Instagram, iMessage, LINE, KakaoTalk, Viber | no | — | — | — |
| Slack (workspace owner) | yes | one CSV/text file: timestamp, channel, username, text | no | not yet |
| Rocket.Chat (admin) | yes | a Slack export zip, or its own CSV zip | partly | not yet |
| Zulip (admin) | yes | Slack, Mattermost or Rocket.Chat exports | yes | not yet |
| Mattermost (admin) | yes | its JSONL bulk-import format | yes | not yet |
| ChatForge | yes | WhatsApp and Telegram exports, UniversalChat | yes | any |

Evidence: Telegram rows from the clients' source code (see `formats/telegram-import.md`); Slack from its help article
"Move data to Slack using a CSV or text file"; Rocket.Chat, Zulip and Mattermost from their migration documentation;
"no" rows mean the app has no feature for importing a chat history from a file (WhatsApp, Signal and the others only
restore their own backups or migrate between their own devices).

## Telegram, step by step

**iPhone / iPad (text and media)**

1. Move the `.zip` to the device (AirDrop, iCloud Drive, or the Files app).
2. In Files, long-press the `.zip` → Share → Telegram.
3. Pick the chat: a private chat with a **mutual contact**, a group where you are an admin who can change group info,
   or a new group.
4. Confirm and keep Telegram open until it reports the import finished.

**Android (text only)** — keep "WhatsApp" in the file name, share the `.zip` to Telegram from a file manager, pick
the chat.

Limits: one import per chat at a time, a daily maximum, and on iPhone one failed upload stops the import.
