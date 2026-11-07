# Telegram — "Import chat history"

How Telegram imports chats from other apps, as read from its open-source clients — Telegram-iOS `master`
@ [`24638bc`](https://github.com/TelegramMessenger/Telegram-iOS/tree/24638bc69bd083981b178dd1e7f921eebbf7fc46),
Telegram Android `master` @ [`3de37c8`](https://github.com/DrKLO/Telegram/tree/3de37c8cfb039452be7398909461da6288babf15),
tdesktop `dev` @ `7381fb1` — and from the MTProto documentation at
[core.telegram.org/api/import](https://core.telegram.org/api/import), read on 2026-11-07.

The parsing of the chat text happens on Telegram's **servers**, which are not open source. What the clients accept
and upload is documented below; how the server reads the text is recorded under "Observed" once tested.

## Which clients import

| Client | Imports? | Accepts | Media |
|---|---|---|---|
| Telegram for iPhone/iPad | yes, from the share sheet | **one `.zip`**; a bare `.txt` only if it begins with `[LINE]` | yes |
| Telegram for Android | yes, from a share | a file whose name contains `WhatsApp` and ends in `.zip`/`.txt`, or shares from WhatsApp, LINE, KakaoTalk | **not from a zip** |
| Telegram Desktop, Web A, Web K, macOS | no — only the API schema is present | — | — |

## Telegram for iPhone/iPad

Share extension: [ShareExtensionContext.swift#L652-L842](https://github.com/TelegramMessenger/Telegram-iOS/blob/24638bc69bd083981b178dd1e7f921eebbf7fc46/submodules/TelegramUI/Components/ShareExtensionContext/Sources/ShareExtensionContext.swift#L652-L842).

- Exactly one shared item; its first file URL is used. `.zip` and `.txt` only (case-insensitive extension).
- In a zip, the **first entry, in zip order,** whose name (with `/` turned into `_`) matches `_chat\.txt`,
  `KakaoTalkChats\.txt` or `Talk_.*?\.txt` (unanchored, case-sensitive) is the chat. The server can replace these
  patterns (`history_import_filters` app config).
- The first **3000 bytes** of it (UTF-8, extended by up to 10 bytes to end on a character) go to
  `messages.checkHistoryImport`, which answers private chat / group / unknown and a title. A failure there opens the
  normal share sheet instead — no error is shown.
- Every other non-empty entry is uploaded as media and typed by its **name**
  ([ShareExtensionContext.swift#L718-L754](https://github.com/TelegramMessenger/Telegram-iOS/blob/24638bc69bd083981b178dd1e7f921eebbf7fc46/submodules/TelegramUI/Components/ShareExtensionContext/Sources/ShareExtensionContext.swift#L718-L754)):
  `.*?\.jpg` → photo, `\d+-VIDEO-.*?\.mp4` → video, `\d+-STICKER-.*?\.webp` → sticker,
  `\d+-AUDIO-.*?\.opus` → voice, anything else → file. There is **no GIF type**.
- The uploaded `file_name` is the entry's path inside the zip; zero-byte entries are skipped but still counted;
  entry names without the UTF-8 flag from a DOS-made zip are decoded as CP437 (SSZipArchive).
- At most 3 uploads run at once, and **one failed upload stops the whole import** (Retry starts over).
- Errors shown: not an admin, wrong chat type (`IMPORT_PEER_TYPE_INVALID`), privacy settings (`USER_IS_BLOCKED`),
  not a mutual contact, "Daily maximum reached" (`FLOOD_WAIT`); everything else is "An error occurred".

## Telegram for Android

[LaunchActivity.java#L1695-L1877, #L3672-L3792](https://github.com/DrKLO/Telegram/blob/3de37c8cfb039452be7398909461da6288babf15/TMessagesProj/src/main/java/org/telegram/ui/LaunchActivity.java#L3672-L3792),
[SendMessagesHelper.java#L9175-L9285](https://github.com/DrKLO/Telegram/blob/3de37c8cfb039452be7398909461da6288babf15/TMessagesProj/src/main/java/org/telegram/messenger/SendMessagesHelper.java#L9175-L9285).

- Detection by the shared URI or file name: `.*WhatsApp.*\.txt$`, `.*WhatsApp.*\.zip$`, WhatsApp/WhatsApp
  Business/LINE providers, or KakaoTalk (server-overridable).
- In a zip, the first entry ending in `.txt` is the chat; **media inside the zip is never uploaded**.
- The first **100 lines** go to `checkHistoryImport`; the chat file must be **32 MiB or smaller**.
- Only JPEG becomes a photo; everything else is uploaded as a document by MIME type, without a file-name attribute.
- A failed media upload is skipped rather than stopping the import.

## The API flow

`messages.checkHistoryImport(import_head)` → the user picks a chat → `messages.checkHistoryImportPeer(peer)` (shows
`confirm_text`) → upload the chat file → `messages.initHistoryImport(peer, file, media_count)` →
`messages.uploadImportedMedia(peer, import_id, file_name, media)` per file → `messages.startHistoryImport`.
Documented errors include `IMPORT_FORMAT_UNRECOGNIZED`, `IMPORT_FILE_INVALID`, `IMPORT_FORMAT_DATE_INVALID`,
`IMPORT_LANG_NOT_FOUND` ("Unknown file language" — the server recognises the export's language) and
`406 PREVIOUS_CHAT_IMPORT_ACTIVE_WAIT_%dMIN` (one import per chat at a time). Imported messages keep their dates,
are marked as imported, and are visible to everyone in the chat. Private chats only with mutual contacts; groups need
an admin who can change group info.

## What Chat Converter writes for Telegram

`telegram-ios` (and `telegram-android`, the same zip) follows WhatsApp's iOS format and the rules above:

- `_chat.txt` is the **first** entry (iOS takes the first match, Android the first `.txt`); entries are flat;
  every name carries the UTF-8 flag; no zero-byte or junk entries.
- Photos `NNNNNNNN-PHOTO-….jpg`; videos, round videos **and GIFs** `NNNNNNNN-VIDEO-….mp4` (as a GIF name they would be
  uploaded as plain files); Telegram's `.ogg` voice notes as `NNNNNNNN-AUDIO-….opus` (the same Ogg Opus bytes); webp
  stickers `NNNNNNNN-STICKER-….webp`; animated `.tgs`/`.webm` stickers become `sticker omitted` with their emoji
  (or files, if chosen); documents keep their names, rewritten only where a name would be typed wrongly or taken for
  the chat file; contacts as `.vcf` (rebuilt from the contact fields when the export has no vCard).
- The encryption notice comes first, attributed to the other person (private chat) or the group title.
- `.MOV` videos are renamed `.mp4`; this is the one upload the server could reject.

## Observed

_Not yet recorded._ After a test import, note the date, the Telegram version, and how the server treated: which
side "you" are on in a private chat, the time zone of the times, WhatsApp markup (`*bold*`), the edit marker, polls,
locations, and the renamed `.MOV` videos.
