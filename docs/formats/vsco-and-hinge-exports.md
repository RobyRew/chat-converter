# VSCO and Hinge data downloads

## VSCO

Observed on a download made 2025-11 (3 conversations, 27 messages). Importer: `src/importers/vsco.ts`.

`messages.json` at the root is an array of conversations:

```json
[{ "id": "…", "userID": 123, "creatorUserID": 456, "createdAt": 1690000000000, "lastUpdated": …,
   "participantUserIds": [123, 456],
   "participants": [{ "user_id": 123, "name": "…", "domain": "username", "profile_image_url": "…", … }],
   "messages": [{ "id": "…", "conversationId": "…", "fromUserId": 456, "createdAt": 1690000000000, "order": 20,
                  "text": "…", "localizations": [{ "message": "…" }], "reference": { … } }] }]
```

- `userID` is the account owner; `fromUserId` matches a participant's `user_id`.
- Messages are newest first (`order` counts down); times are epoch milliseconds, UTC.
- Messages sent by VSCO's own account repeat their text under `localizations` (identical to `text` in all 9
  observed); a message with only `localizations` is read from there.
- A shared journal has no text and `reference {journal {title, subtitle, permalink}, site {domain}}`; it becomes
  the title, subtitle and `https://vsco.co/<domain>/journal/<permalink>`.
- `images/` and `videos/` hold the account's own posts, not chat media.

## Hinge

Observed on a download made in 2026. Importer:
`src/importers/hinge.ts`.

`export/matches.json` is an array with one record per person the account interacted with:

| Key | Holds |
|---|---|
| `like[{timestamp, like[{timestamp, comment?}]}]` | likes the account sent, each with an optional comment |
| `match[{timestamp}]` | when they matched |
| `chats[{body, timestamp}]` | the messages **the account** sent |

Hinge exports none of the other person's messages and not their name. Each record with a match or chats becomes
a conversation titled "Hinge match N" with the owner's messages, the likes and an "It's a match" event; the other
person is a participant marked `meta.nameNotExported`. Likes sent without a match are gathered in one conversation
"Likes sent". Timestamps are `YYYY-MM-DD HH:MM:SS.ffffff` without a zone; they are read as UTC (Hinge does not
state the zone). `export/user.json` gives the owner's `profile.first_name`/`last_name`. JSON text uses ordinary
`\u` escapes (no Latin-1 re-decoding needed).
