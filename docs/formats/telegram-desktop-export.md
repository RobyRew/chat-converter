# Telegram Desktop — "Export chat history"

What Telegram Desktop writes when you export one chat (or your whole account), as read from its source at
tdesktop `dev` @ [`7381fb1`](https://github.com/telegramdesktop/tdesktop/tree/7381fb1df75d863eb3463fdddef57a2ac51f1d56/Telegram/SourceFiles/export)
(2026-11-06), and as observed in a real 32,405-message export made with Telegram Desktop on macOS on 2026-11-07.

## Formats

The dialog offers **Human-readable HTML**, **Machine-readable JSON**, or **both**. Chat Converter reads all three:

| Export | Files | What Chat Converter uses |
|---|---|---|
| JSON | `result.json` | `result.json` |
| HTML | `messages.html`, `messages2.html`, … | the HTML pages |
| Both | both of the above | `result.json` (it has more); the HTML pages can be cross-checked |

In the real export all three variants held the same 32,405 message ids in the same order; the HTML pages add one
"date separator" block per day (negative ids), which are not messages.

## The size limit is per file

The **Size limit** slider (`SizeLimitByIndex`, [export_view_settings.cpp#L98-L122](https://github.com/telegramdesktop/tdesktop/blob/7381fb1df75d863eb3463fdddef57a2ac51f1d56/Telegram/SourceFiles/export/view/export_view_settings.cpp#L98-L122))
goes from 1 MB to **4000 MB** — Telegram's largest possible file. It is checked **for each file on its own**
([export_api_wrap.cpp#L3327-L3346](https://github.com/telegramdesktop/tdesktop/blob/7381fb1df75d863eb3463fdddef57a2ac51f1d56/Telegram/SourceFiles/export/export_api_wrap.cpp#L3327-L3346)):
a file larger than the limit is skipped and the message keeps a placeholder. There is no total-size limit anywhere in
the export code. To export everything, set the slider to 4000 MB and tick every media type (Photos, Videos, Voice
messages, Video messages, Stickers, GIFs, Files). The default is photos only, up to 8 MB.

## Folders and file names

| Folder | Holds |
|---|---|
| `photos/` | `photo_<n>@DD-MM-YYYY_HH-MM-SS.jpg` (+ `_thumb.jpg`) |
| `video_files/` | videos **and** GIF animations and video stickers (any document with video attributes) |
| `voice_messages/` | `audio_<n>@….ogg` (Ogg Opus) |
| `round_video_messages/` | round video messages |
| `stickers/` | `.webp` (static), `.tgs` (animated, Lottie), `.webm` (video) |
| `files/` | documents, by their original name |
| `contacts/` | `contact_<n>.vcard` |

Name collisions get ` (1)`, ` (2)` before the first dot. A full-account export puts each chat under
`chats/chat_<NNN>/`.

## JSON — `result.json`

Root: `{ name, type, id, messages: [...] }` (`name` is `null` for a deleted account). `type` is one of
`personal_chat`, `bot_chat`, `private_group`, `private_supergroup`, `public_supergroup`, `private_channel`,
`public_channel`, `saved_messages`, `replies`, `verification_codes`.

Every message has `id`, `type` (`message` | `service`), `date` (the exporting machine's wall-clock time, no offset)
and `date_unixtime` (the instant, as a string). Other keys appear only when they have a value:

- sender: `from`, `from_id` (`user<id>`, `channel<id>`); `from: null` is a deleted account. Service messages use
  `actor` / `actor_id`.
- text: `text` (a string, or an array of strings and `{type, text, href?}` parts) and `text_entities`.
  Entity types: `plain`, `bold`, `italic`, `underline`, `strikethrough`, `spoiler`, `code`, `pre` (+`language`),
  `blockquote` (+`collapsed`), `link`, `text_link` (+`href`), `mention`, `mention_name` (+`user_id`), `hashtag`,
  `cashtag`, `bot_command`, `email`, `phone`, `bank_card`, `ton_address`, `custom_emoji` (+`document_id`, which the
  exporter replaces with the sticker's file path).
- edits: `edited`, `edited_unixtime`. Replies: `reply_to_message_id` (+`reply_to_peer_id` across chats).
  Forwards: `forwarded_from`, `forwarded_from_id` (no forward date in JSON). `via_bot`, `saved_from`, `author`.
- media: `photo`, `photo_file_size`, `width`, `height`; documents: `file`, `file_name`, `file_size`, `thumbnail`,
  `media_type` (`sticker`, `video_message`, `voice_message`, `animation`, `video_file`, `audio_file`; a plain
  document has none), `mime_type`, `duration_seconds`, `sticker_emoji`, `performer`, `title`, `media_spoiler`,
  `self_destruct_period_seconds`.
- structured: `contact_information` + `contact_vcard`, `location_information` (+`live_location_period_seconds`),
  `place_name`, `address`, `poll {question, closed, total_voters, answers[{text, voters, chosen}]}`,
  `todo_list {title, answers[{text, id}]}` (a checklist), `invoice_information`, `game_*`, giveaways.
- `reactions [{type, count, emoji | document_id, recent[{from, from_id, date}]}]`.
- service messages: `action` (e.g. `phone_call` with `duration_seconds` and `discard_reason`, `pin_message` with
  `message_id`, `todo_completions`, `todo_append_tasks`, `send_star_gift`, `edit_chat_theme`, `take_screenshot`,
  `create_group`, `invite_members`, … — about 70 in all).

A file that was not downloaded is replaced by a placeholder
([export_output_json.cpp#L1656-L1678](https://github.com/telegramdesktop/tdesktop/blob/7381fb1df75d863eb3463fdddef57a2ac51f1d56/Telegram/SourceFiles/export/output/export_output_json.cpp#L1656-L1678)):

| Placeholder | Why |
|---|---|
| `(File not included. Change data exporting settings to download.)` | that media type was not ticked |
| `(File exceeds maximum size. Change data exporting settings to download.)` | larger than the size limit |
| `(File unavailable, please try again later)` | expired self-destructing media, a skipped or failed download |

Chat Converter keeps such attachments with `present: false` and `omitted: not_included | too_large | unavailable`.

## HTML — `messages*.html`

1000 messages per page (`kMessagesInFile`), named `messages.html`, `messages2.html`, …. Each message is
`<div class="message default clearfix" id="message<ID>">`; `joined` is added when the sender is the same as the
previous message's (the sender is then not repeated). Service lines are `message service` and have **no time**.

Compared with JSON, HTML has no sender ids, no unix times, no edit marks, and no `mention_name` user ids; it does have
the forward date. Its time tooltip is `DD.MM.YYYY HH:MM:SS UTC±HH:MM`, but the offset is the export machine's
**standard** offset for every message: in the real export, summer messages (really UTC+1, Europe/London) carry
`UTC+00:00`. Chat Converter therefore reads the wall-clock time and converts it with a time zone you choose (the
browser's by default) instead of trusting the label. In the hour repeated when clocks go back, the earlier instant is
used.

Media markup: `photo_wrap` (photo), `animated_wrap` (GIF), `sticker_wrap` (sticker), and `media_*` blocks
(`media_video`, `media_voice_message`, `media_audio_file`, `media_file`, `media_photo` — also used for animated and
video stickers and expired self-destructing photos — `media_call`, `media_location`, `media_live_location`,
`media_venue`, `media_contact`, `media_poll` — also used for checklists, "To-do List"). Missing files carry the
sentence "Not included, change data exporting settings to download." (or "Exceeds maximum size…",
"Unavailable…").

## Quirk worth knowing

Choosing **both** formats appears to reset the saved export settings the next time they are read
(`Settings::validate()` accepts only HTML or JSON — [export_settings.cpp#L40](https://github.com/telegramdesktop/tdesktop/blob/7381fb1df75d863eb3463fdddef57a2ac51f1d56/Telegram/SourceFiles/export/export_settings.cpp#L40)),
so check the media types and size limit each time.
