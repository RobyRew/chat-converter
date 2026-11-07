# UniversalChat 1.0

UniversalChat is the format every importer writes and every exporter reads: one versioned document that can hold
any number of conversations from any app without losing what the source export contained. Chat Converter converts
*through* it (WhatsApp → UniversalChat → Telegram, Instagram → UniversalChat → HTML, …), and stores it as a file of
its own.

The schemas are `src/model/universal.ts` (archive) and `src/model/canonical.ts` (conversation, message, …), written
in zod; TypeScript types are derived from them.

## Files

| Kind | Name | Content |
|---|---|---|
| Document | `<name>.universalchat.json` | the JSON document below, without media bytes |
| Package | `<name>.universalchat.zip` | `universalchat.json` as the first entry, then `media/<conversation index>/<original path>`; Zip64 when larger than 4 GB |

## Document

```json
{
  "format": "UniversalChat",
  "version": "1.0.0",
  "generator": { "name": "chat-converter", "version": "0.1.0" },
  "createdAt": 1794057935500,
  "source": { "platform": "telegram", "variant": "json", "name": "ChatExport_2026-11-07" },
  "conversations": [
    {
      "schemaVersion": 2,
      "id": "c_…",
      "kind": "dm",
      "title": "Sam Rivers",
      "originPlatform": "telegram",
      "selfId": "p_…",
      "participants": [{ "id": "p_…", "displayName": "Cosmin Calin", "handles": ["user100000001"] }],
      "messages": [
        {
          "id": "m_…",
          "senderId": "p_…",
          "ts": 1682706267000,
          "tzOffsetMinutes": 60,
          "kind": "media",
          "content": { "text": "mira esto", "entities": [{ "type": "bold", "offset": 5, "length": 4 }] },
          "attachments": [{ "id": "a_…", "kind": "image", "ref": "photos/photo_1@….jpg", "present": true, "size": 23 }],
          "raw": { "…": "the source record, verbatim" }
        }
      ],
      "media": [{ "ref": "photos/photo_1@….jpg", "path": "media/0/photos/photo_1@….jpg", "size": 23, "present": true }]
    }
  ]
}
```

### Conversation

`id`, `kind` (`dm` | `group` | `channel`), `title`, `originPlatform`, `selfId` (the exporting account, when known),
`participants`, `messages`, `media` (manifest), `meta`, `ext`, and `schemaVersion` (2; kept for ChatForge).

### Message

| Field | Meaning |
|---|---|
| `id` | deterministic (hash of the source identity) — the same export always yields the same ids |
| `senderId` | a participant id; absent for system lines |
| `ts`, `tzOffsetMinutes` | the instant (epoch ms, UTC) and the offset of the wall clock the source showed |
| `kind` | `text`, `media`, `sticker`, `system`, `service`, `call`, `poll`, `checklist`, `location`, `contact` |
| `content` | `{ text, entities[] }`; entity offsets and lengths count UTF-16 code units |
| `attachments[]` | `kind`, `ref` (path in the source), `fileName`, `mimeType`, `size`, `width`, `height`, `durationSec`, `present`, `omitted` (`not_included` \| `too_large` \| `unavailable` \| `missing`), `stickerFormat`, `emoji`, `round`, `spoiler`, `selfDestructSec`, `thumbnailRef`, `caption` |
| `replyToId`, `forwardedFrom`, `reactions[]`, `editedAt`, `deleted`, `viaBot` | as named |
| `poll`, `checklist`, `location`, `contact`, `call`, `service` | structured events |
| `raw` | the source record, verbatim |
| `meta`, `ext` | see below |

## Extensions

Data with no common field lives under one namespace per platform, on the archive, a conversation, a participant, a
message or an attachment:

| Namespace | Holds |
|---|---|
| `whatsapp` | `raw` (the message text exactly as written, marks included), `stamp`, `sender`, `lead`, `contentText`, `notice`, `attributedTo`; conversation: `headerStyle` (`ios`/`android`), `eol` — what makes a WhatsApp → WhatsApp conversion byte-identical |
| `universalchat` | `originalRef` (an attachment's path in the original export when it is read back from a package); `original_<field>` (a value from a newer version this reader did not know) |
| others | added by importers as needed (`telegram`, `instagram`, `messenger`, `snapchat`, …) |

`meta` holds cross-platform notes (`exportFormat`, `deletedAccount`, `htmlTimeInferred`, `editedTimeUnknown`).

## Versioning

`version` is semver:

- **MAJOR** — a field changes meaning or disappears. A reader refuses a newer major.
- **MINOR** — additions only: optional fields, values added to a list, new `ext` namespaces. Every object keeps the
  fields a reader does not know (the zod objects are loose), and a list value a reader does not know is replaced by
  its fallback (`text`, `unknown`, `custom`, `group`, `generic`) with the original kept as
  `ext.universalchat.original_<field>`.
- **PATCH** — wording only.

`readUniversalChat()` reads a document of this major version, or a single conversation in ChatForge's earlier
shape (`schemaVersion` 1 or 2), and returns a UniversalChat document.
