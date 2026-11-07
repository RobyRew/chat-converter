# WhatsApp — "Export chat"

The format WhatsApp writes when you export a chat, as observed in **26 real exports** made with WhatsApp for iOS
and macOS between August 2024 and November 2026 (24 private chats, 2 groups, one chat with yourself; English and
Spanish; with and without media). It is also the format Telegram imports (see `telegram-import.md`).

Chat Converter reads these files and, while a message is unchanged, writes it back exactly as it was read: all 26
exports re-export byte-identical (`_chat.txt` and the media entry names), checked on 2026-11-07.

## Container

- **iOS / macOS:** `WhatsApp Chat - <chat name>.zip` holding `_chat.txt` and the media. Media entries come first,
  `_chat.txt` last; entries are deflated. Entry names are UTF-8 **without** the UTF-8 flag (a contact card's name can
  contain U+200E).
- **Android:** `WhatsApp Chat with <name>.txt` plus the media files, shared separately or zipped. Not yet checked
  against a real Android export.

## `_chat.txt`

- UTF-8, no BOM. **Each message ends with CRLF; a line break inside a message is a bare LF.**
- Message header: `[date, time] Sender: text`. The date and time follow the phone's locale; seen so far:
  `[01/06/2026, 09:30:25]`, `[30/1/26, 16:15:07]`, `[2/7/25, 16:10:42]`, `[14/11/25, …]` — day first, 24-hour,
  seconds always present. Android writes `30/01/2026, 16:15 - Sender: text` (no seconds).
- A message with no text after the sender is `[date, time] Sender:` (no trailing space).
- **U+200E (LRM)** marks WhatsApp's own text: before `[` on every line that carries media, before every attachment
  reference and "omitted" marker, at the start of the text of system lines, and inside some system sentences.
- Senders: your contacts by name; others as `~` + U+202F + their profile name; numbers wrapped in U+202A … U+202C.

### Media

- Reference: caption, a space, then `‎<attached: NNNNNNNN-PHOTO-YYYY-MM-DD-HH-MM-SS.jpg>`; without a caption just
  `‎<attached: …>`.
- Names: `NNNNNNNN-PHOTO-….jpg`, `-VIDEO-….mp4`, `-AUDIO-….opus` (voice notes), `-STICKER-….webp`, `-GIF-….mp4`;
  documents keep their name after the number (`00000016-Report.pdf`, preceded in the text by
  `Report.pdf • ‎1 page`); contact cards are `NNNNNNNN-<name>.vcf`. The number is not a simple sequence.
- An export made without media writes a marker instead: `‎image omitted`, `‎video omitted`, `‎audio omitted`,
  `‎sticker omitted`, `‎GIF omitted`, `‎document omitted`, `‎Contact card omitted` (after the caption, if any).
- A photo album is several consecutive messages with the same time; WhatsApp writes an empty `Sender:` line first.

### Other content

- Polls: `‎POLL:` / question / `‎OPTION: <text> (<n> votes)` per option, joined with LF.
- Edited messages end with ` ‎<This message was edited>`.
- Deleted messages read `‎You deleted this message.` / `This message was deleted.`
- The first line is the end-to-end-encryption notice, attributed to the chat title: the group's name, or "‎You" in
  a chat with yourself ("Messages to yourself are end-to-end encrypted…"). In a group, events (created, added,
  left…) are attributed to the group name too.
- Disappearing-message notices, "is a contact", and timer changes are system lines from the person concerned.

## Language

WhatsApp writes its markers in the phone's language. A Spanish export uses `‎<adjunto: …>`,
`‎<Se editó este mensaje.>` and "Los mensajes y las llamadas están cifrados de extremo a extremo…". Chat Converter
reads attachment tags in English, Spanish, Catalan, Portuguese, Italian, German, French, Dutch, Romanian, Polish and
Turkish, and — for any other language — any `<word: NNNNNNNN-…>` that names a file in the archive; edit markers,
omitted markers and the notice in English, Spanish, Catalan, Romanian, Portuguese, German, French and Italian.
English and Spanish are taken from real exports; the other languages' wording is not yet confirmed by a real file.

## What is not in a WhatsApp export

Replies (which message is being answered), reactions, read receipts, forwards, edit history, view-once media, and
call logs.
