# Snapchat ("My Data")

Layout observed on a download made 2025-04-03 with JSON files included: 60 chat conversations, 3,639 chat
messages, 227 snaps, 303 files in `chat_media/`. Importer: `src/importers/snapchat.ts` (platform `snapchat`).

```
<root>/
├── json/chat_history.json      every chat message, by conversation
├── json/snap_history.json      every snap sent/received (no media)
├── json/friends.json           usernames → display names (Friends, Deleted Friends, Friend Requests Sent, …)
├── json/account.json           "Basic Information": Username, Name (the owner)
├── html/chat_history/<key>.html  the same messages as pages (no Media IDs)
├── chat_media/YYYY-MM-DD_<media id>.<ext>   saved chat media (jpeg, mp4, webp, png)
├── memories/ …                 Memories (not chat)
└── index.html
```

## chat_history.json

`{ "<conversation key>": [ message, … ] }`, each list newest first. The key is the other person's username in a
private chat; a group's messages carry a `Conversation Title`.

| Key | Value |
|---|---|
| `From` | sender's username |
| `Media Type` | `TEXT`, `MEDIA`, `STICKER`, `NOTE` (voice note), `SHARE`, `STATUS` (observed counts 3581, 40, 8, 1, 1, 8) |
| `Created` | `YYYY-MM-DD HH:MM:SS UTC` |
| `Created(microseconds)` | epoch **milliseconds** (13 digits), within the same second as `Created` |
| `Content` | text; empty for stickers/shares, `null` for statuses |
| `Conversation Title` | `null` in private chats |
| `IsSender` | `true` for the owner's messages (one username throughout) |
| `IsSaved` | saved in chat |
| `Media IDs` | `b~…` ids separated by ` \| `, naming files in `chat_media/` |

Read as: TEXT → text; MEDIA/NOTE → attachments resolved by Media ID (75 of 81 ids had a file; the other 6 are
reported missing); STICKER → sticker without a file; STATUS → `service` event; SHARE without content →
`meta.contentUnavailable`. Times are UTC (`tzOffsetMinutes: 0`). `ext.snapchat` keeps `mediaType` and `saved`.

**Unplaced media:** 228 files in `chat_media/` are named by no message; nothing in the download says which
conversation they belong to, so they are left out and the import says how many.

## snap_history.json

Same keys without `Content`/`IsSaved`/`Media IDs`; `Media Type` is `IMAGE` or `VIDEO`. Snaps are merged into their
conversation as media messages with `meta.snap` and an attachment marked `unavailable` (snap media is never in the
download). 14 conversations had snaps and no chat messages.

## Names and the owner

Display names come from every list in `friends.json` (48 of the chat usernames had one) and `account.json`; the
username is kept in `handles`. The owner is `account.json`'s Username, else the sender of `IsSender` messages, and
is added to every conversation.

## HTML only

Without the JSON option the download has only `html/chat_history/<key>.html` (title `Chat History with <key>`).
Each message: `h4` sender, a `span` with the media type, `p` content, `h6` time (`… UTC`), `button.saved`. On the
download above the HTML held the same messages as the JSON, in the same order. HTML has no Media IDs, so chat
media cannot be linked.
