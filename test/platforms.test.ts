import { describe, expect, it } from 'vitest';
import { importArchive, sourceFromBytes, type Conversation } from '../src/index';
import { parseSnapchatHtml, snapTime } from '../src/importers/snapchat';
import { hingeTime } from '../src/importers/hinge';

// Synthetic exports in each platform's layout (no real data).
const enc = (s: string) => new TextEncoder().encode(s);
const json = (v: unknown) => enc(JSON.stringify(v, null, 4));
const nameOf = (c: Conversation, id?: string) => c.participants.find((p) => p.id === id)?.displayName;

describe('Snapchat', () => {
  const rec = (from: string, type: string, created: string, content: string | null, isSender: boolean, ids = '', saved = true) => ({
    From: from, 'Media Type': type, Created: `${created} UTC`, Content: content, 'Conversation Title': null,
    IsSender: isSender, 'Created(microseconds)': Date.parse(`${created.replace(' ', 'T')}Z`) + 123, IsSaved: saved, 'Media IDs': ids,
  });
  const chat = {
    'ana.pop': [ // newest first, as Snapchat writes it
      rec('ana.pop', 'STATUS', '2025-03-01 10:06:00', null, false, '', false),
      rec('me_user', 'NOTE', '2025-03-01 10:05:00', '', true, 'b~voice1'),
      rec('ana.pop', 'STICKER', '2025-03-01 10:04:00', '', false),
      rec('me_user', 'MEDIA', '2025-03-01 10:03:00', 'look', true, 'b~photo1 | b~gone'),
      rec('ana.pop', 'SHARE', '2025-03-01 10:02:00', '', false),
      rec('ana.pop', 'TEXT', '2025-03-01 10:00:00', 'hola', false),
    ],
  };
  const snaps = { 'ana.pop': [{ From: 'ana.pop', 'Media Type': 'VIDEO', Created: '2025-03-01 10:01:00 UTC', 'Conversation Title': null, IsSender: false, 'Created(microseconds)': Date.UTC(2025, 2, 1, 10, 1) }], 'bob.x': [{ From: 'bob.x', 'Media Type': 'IMAGE', Created: '2025-02-01 09:00:00 UTC', 'Conversation Title': null, IsSender: false, 'Created(microseconds)': Date.UTC(2025, 1, 1, 9) }] };
  const files = [
    { path: 'json/chat_history.json', bytes: json(chat) },
    { path: 'json/snap_history.json', bytes: json(snaps) },
    { path: 'json/friends.json', bytes: json({ Friends: [{ Username: 'ana.pop', 'Display Name': 'Ana Pop', 'Creation Timestamp': '', 'Last Modified Timestamp': '', Source: '' }], 'Deleted Friends': [] }) },
    { path: 'json/account.json', bytes: json({ 'Basic Information': { Username: 'me_user', Name: 'Cosmin', 'Creation Date': '' } }) },
    { path: 'chat_media/2025-03-01_b~photo1.jpeg', bytes: new Uint8Array([1]) },
    { path: 'chat_media/2025-03-01_b~voice1.mp4', bytes: new Uint8Array([2]) },
    { path: 'chat_media/2025-03-01_b~orphan.jpeg', bytes: new Uint8Array([3]) },
    { path: 'index.html', bytes: enc('<html></html>') },
  ];

  it('reads every chat and snap in time order with display names, media and the owner', async () => {
    const { archive, detectedPlatform, warnings } = await importArchive(sourceFromBytes('mydata', files));
    expect(detectedPlatform).toBe('snapchat');
    expect(archive.conversations.map((c) => c.title)).toEqual(['Ana Pop', 'bob.x']);
    const [ana, bob] = archive.conversations as [Conversation, Conversation];
    expect(ana.messages.map((m) => (m.meta?.['snap'] ? 'SNAP' : m.ext?.['snapchat']?.['mediaType']))).toEqual(['TEXT', 'SNAP', 'SHARE', 'MEDIA', 'STICKER', 'NOTE', 'STATUS']);
    expect(ana.messages[0]).toMatchObject({ ts: Date.UTC(2025, 2, 1, 10, 0, 0, 123), tzOffsetMinutes: 0, content: { text: 'hola' } });
    expect(nameOf(ana, ana.messages[0]!.senderId)).toBe('Ana Pop');
    expect(nameOf(ana, ana.selfId)).toBe('Cosmin');
    expect(ana.messages[1]!.attachments).toMatchObject([{ kind: 'video', present: false, omitted: 'unavailable' }]);
    expect(ana.messages[2]!.meta).toEqual({ contentUnavailable: true });
    expect(ana.messages[3]).toMatchObject({ kind: 'media', content: { text: 'look' } });
    expect(ana.messages[3]!.attachments).toMatchObject([
      { kind: 'image', ref: 'chat_media/2025-03-01_b~photo1.jpeg', present: true },
      { present: false, omitted: 'missing' },
    ]);
    expect(ana.messages[4]).toMatchObject({ kind: 'sticker' });
    expect(ana.messages[5]!.attachments).toMatchObject([{ kind: 'voice', present: true }]);
    expect(ana.messages[6]).toMatchObject({ kind: 'service', service: { action: 'status' }, ext: { snapchat: { saved: false } } });
    expect(ana.kind).toBe('dm');
    expect(bob.participants.map((p) => p.displayName).sort()).toEqual(['Cosmin', 'bob.x']);
    expect(warnings.join('\n')).toMatch(/1 file\(s\) in chat_media\/ are not named/);
    expect(warnings.join('\n')).toMatch(/1 media item\(s\) named by messages are not in the export/);
  });

  it('reads the HTML pages when the export has no JSON', async () => {
    const block = (from: string, type: string, content: string | null, when: string) =>
      `<div><span><div><div><button class="saved">Saved</button><h4>${from}</h4></div><div><svg class="icons"><path/><path/></svg><span>${type}</span></div></div><hr>${content === null ? '' : `<p>${content}</p>`}<h6>${when} UTC</h6></span></div>`;
    const page = `<html><head><style>body{}</style></head><body><div><h1>Chat History with ana.pop</h1></div>${block('ana.pop', 'TEXT', 'second', '2025-03-01 10:01:00')}${block('me_user', 'TEXT', 'first', '2025-03-01 10:00:00')}</body></html>`;
    expect(parseSnapchatHtml(page).map((r) => r.Content)).toEqual(['second', 'first']);
    const { archive } = await importArchive(sourceFromBytes('mydata', [{ path: 'html/chat_history/ana.pop.html', bytes: enc(page) }, { path: 'index.html', bytes: enc('x') }]));
    const [c] = archive.conversations;
    expect(c!.meta?.['exportFormat']).toBe('snapchat-html');
    expect(c!.messages.map((m) => m.content?.text)).toEqual(['first', 'second']);
    expect(nameOf(c!, c!.selfId)).toBe('me_user');
  });

  it('takes milliseconds from Created(microseconds) and falls back to Created', () => {
    expect(snapTime({ 'Created(microseconds)': 1740823200123 })).toBe(1740823200123);
    expect(snapTime({ 'Created(microseconds)': 1740823200123456 })).toBe(1740823200123);
    expect(snapTime({ Created: '2025-03-01 10:00:00 UTC' })).toBe(Date.UTC(2025, 2, 1, 10));
  });
});

describe('VSCO', () => {
  const data = [
    {
      id: 'conv-1', userID: 100, creatorUserID: 200, createdAt: 1, participantUserIds: [100, 200],
      participants: [{ user_id: 100, name: 'Cosmin', domain: 'cosmin' }, { user_id: 200, name: '', domain: 'ana' }],
      messages: [ // newest first
        { id: 'm3', conversationId: 'conv-1', fromUserId: 200, createdAt: 3000, order: 3, reference: { type: 3, journal: { title: 'Trip', subtitle: 'Notes', permalink: 'trip-notes' }, site: { domain: 'ana' } } },
        { id: 'm2', conversationId: 'conv-1', fromUserId: 100, createdAt: 2000, order: 2, text: 'hey', localizations: [{ message: 'hey' }] },
        { id: 'm1', conversationId: 'conv-1', fromUserId: 200, createdAt: 1000, order: 1, text: 'hola' },
      ],
    },
  ];
  it('reads conversations oldest first, names, the owner and shared journals', async () => {
    const { archive, detectedPlatform } = await importArchive(sourceFromBytes('vsco-x', [{ path: 'messages.json', bytes: json(data) }, { path: 'user.json', bytes: json({ id: 1 }) }]));
    expect(detectedPlatform).toBe('vsco');
    const [c] = archive.conversations;
    expect(c!.title).toBe('ana');
    expect(nameOf(c!, c!.selfId)).toBe('Cosmin');
    expect(c!.messages.map((m) => m.content?.text)).toEqual(['hola', 'hey', 'Trip\nNotes\nhttps://vsco.co/ana/journal/trip-notes']);
    expect(c!.messages[2]!.content?.entities).toEqual([{ type: 'link', offset: 11, length: 38 }]);
  });
});

describe('Hinge', () => {
  const records = [
    { like: [{ timestamp: '2026-05-17 10:00:00.123456', like: [{ timestamp: '2026-05-17 10:00:00.123456', comment: 'nice photo' }] }] },
    {
      chats: [{ body: 'hi!', timestamp: '2026-05-18 12:00:00.5' }, { body: 'how are you', timestamp: '2026-05-18 12:01:00.25' }],
      like: [{ timestamp: '2026-05-18 11:00:00.000001', like: [{ timestamp: '2026-05-18 11:00:00.000001' }] }],
      match: [{ timestamp: '2026-05-18 11:30:00.000' }],
    },
  ];
  it("makes one conversation per match with the owner's messages, and gathers lone likes", async () => {
    const { archive, warnings } = await importArchive(sourceFromBytes('Hinge Data Export', [
      { path: 'export/matches.json', bytes: json(records) },
      { path: 'export/user.json', bytes: json({ profile: { first_name: 'Cosmin', last_name: '' } }) },
    ]));
    const match = archive.conversations.find((c) => c.kind === 'dm')!;
    const likes = archive.conversations.find((c) => c.meta?.['likesOnly'])!;
    expect(match.title).toBe('Hinge match 1');
    expect(match.messages.map((m) => m.service?.action ?? m.content?.text)).toEqual(['like', 'match', 'hi!', 'how are you']);
    expect(match.messages[2]!.ts).toBe(Date.UTC(2026, 4, 18, 12, 0, 0, 500));
    expect(nameOf(match, match.messages[2]!.senderId)).toBe('Cosmin');
    expect(match.participants[1]!.meta).toEqual({ nameNotExported: true });
    expect(likes.messages.map((m) => m.content?.text)).toEqual(['nice photo']);
    expect(warnings.join('\n')).toMatch(/only the messages you sent/);
  });
  it('reads microsecond timestamps as UTC', () => {
    expect(hingeTime('2026-05-17 10:00:00.123456')).toBe(Date.UTC(2026, 4, 17, 10, 0, 0, 123));
    expect(hingeTime('2026-05-17 10:00:00')).toBe(Date.UTC(2026, 4, 17, 10));
    expect(hingeTime('bad')).toBe(0);
  });
});
