import { describe, expect, it } from 'vitest';
import { importArchive, sourceFromBytes, type Conversation } from '../src/index';
import { fixMojibake, parseDuration, parseMetaDate, splitReaction } from '../src/importers/meta';
import { WallClockSequence } from '../src/engine/time';

// Synthetic pages in the layout of Meta's 2025 "Download your information" HTML (no real data).
const enc = (s: string) => new TextEncoder().encode(s);
const IG = 'your_instagram_activity/messages/inbox';

function igPage(title: string, blocks: string[]): string {
  return `<html><head><title>${title}</title></head><body class="_5vb_ _2yq _a7o5"><div class="clearfix _ikh"><div class="_4bl9"><div><img src="files/Instagram-Logo.png" height="28" alt="Instagram" /></div><div class="_a705"><header class="_a70a"><div class="_a70d"><h1>${title}</h1></div></header><main class="_a706" role="main">${blocks.join('')}</main></div></div></div></body></html>`;
}
function igBlock(sender: string, date: string | null, slots: string[]): string {
  const content = slots.length ? `<div class="_3-95 _a6-p"><div>${slots.join('')}</div></div>` : '';
  const when = date ? `<div class="_3-94 _a6-o">${date}</div>` : '';
  return `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><h2 class="_3-95 _2ph- _a6-h _a6-i">${sender}</h2>${content}${when}</div>`;
}
const text = (html: string) => ['<div></div>', `<div>${html}</div>`, '<div></div>', '<div></div>'];
const media = (inner: string) => ['<div></div>', '<div></div>', '<div></div>', '<div></div>', `<div><div>${inner}<div></div></div></div>`];
const reactions = (...items: string[]) => `<div><ul class="_a6-q">${items.map((i) => `<li><span>${i}</span></li>`).join('')}</ul></div>`;

const ME = '🇷🇴Cosmin Calin🇷🇴';
const ANA = 'Ana Pop';
const T1 = `${IG}/anapop_1`;

function instagramExport() {
  // message_1 is the newest page and each page lists the newest message first.
  const page1 = igPage(ANA, [
    igBlock(ANA, null, []), // Meta wrote this one with neither content nor time
    igBlock(ANA, 'Jul 14, 2024 11:20 am', ['<div></div>', '<div></div>', '<div></div>', '<div></div>']),
    igBlock(ME, 'Jul 14, 2024 11:15 am', ['<div></div>', '<div>Llamada de audio finalizada</div>', '<div></div>', '<div></div>', '<div><span class="_idm">Duration: 3 minutes</span></div>']),
    igBlock(ANA, 'Jul 14, 2024 11:12 am', media(`<video src="${T1}/videos/3.mp4" controls="1" class="_a6_o _3-96"><a href="${T1}/videos/3.mp4"><div>Click for video</div></a></video>`)),
    igBlock(ME, 'Jul 14, 2024 11:11 am', media(`<audio src="${T1}/audio/2.mp4" controls="1"><a href="${T1}/audio/2.mp4">Click for audio</a></audio>`)),
  ]);
  const page2 = igPage(ANA, [
    igBlock(ANA, 'Jul 14, 2024 11:10 am', [
      ...media(`<a target="_blank" href="${T1}/photos/1.jpg"><img src="${T1}/photos/1.jpg" class="_a6_o _3-96" /></a>`),
      reactions(`❤${ME}<span> (Jul 14, 2024 11:30 am)</span>`),
    ]),
    igBlock(ME, 'Jul 14, 2024 11:05 am', [
      '<div></div>',
      `<div>${ME} sent an attachment.</div>`,
      '<div><div><div>Best caption</div><div>some.owner</div><div><a target="_blank" href="https://www.instagram.com/reel/ABC/">https://www.instagram.com/reel/ABC/</a></div></div></div>',
      '<div></div>',
    ]),
    igBlock(ANA, 'Jul 14, 2024 11:01 am', text('mira esto<br /><br /><a target="_blank" href="https://example.com/x">https://example.com/x</a> genial')),
    igBlock(ANA, 'Jul 14, 2024 11:00 am', [...text('Hola 👋'), reactions(`😂${ME}`)]),
  ]);
  const page3 = igPage('Bob', [igBlock(ME, 'Jul 15, 2024 9:00 am', text('hey')), igBlock('Bob', 'Jul 15, 2024 8:59 am', text('yo'))]);
  return sourceFromBytes('instagram-someone-2025-09-08-abc', [
    { path: `${T1}/message_1.html`, bytes: enc(page1) },
    { path: `${T1}/message_2.html`, bytes: enc(page2) },
    { path: `${T1}/photos/1.jpg`, bytes: new Uint8Array([0xff, 0xd8, 0xff]) },
    { path: `${T1}/audio/2.mp4`, bytes: new Uint8Array([1]) },
    // videos/3.mp4 is missing on purpose
    { path: `${IG}/bob_2/message_1.html`, bytes: enc(page3) },
  ]);
}

const nameOf = (c: Conversation, id?: string) => c.participants.find((p) => p.id === id)?.displayName;

describe('Meta HTML (Instagram)', () => {
  it('reads every thread oldest message first, with wall-clock times in the chosen zone', async () => {
    const { archive, detectedPlatform } = await importArchive(instagramExport(), { timeZone: 'Europe/Madrid' });
    expect(detectedPlatform).toBe('instagram');
    expect(archive.source?.platform).toBe('instagram');
    expect(archive.conversations).toHaveLength(2);
    const ana = archive.conversations.find((c) => c.title === ANA)!;
    expect(ana.messages).toHaveLength(9);
    expect(ana.messages[0]!.ts).toBe(Date.UTC(2024, 6, 14, 9, 0)); // 11:00 CEST
    expect(ana.messages[0]!.tzOffsetMinutes).toBe(120);
    expect(ana.messages.map((m) => m.ts)).toEqual([...ana.messages.map((m) => m.ts)].sort((a, b) => a - b));
    expect(ana.meta?.['wallClockZone']).toBe('Europe/Madrid');
    expect(ana.kind).toBe('dm');
  });

  it('keeps the text around an inline link and marks the link', async () => {
    const ana = (await importArchive(instagramExport(), { timeZone: 'Europe/Madrid' })).archive.conversations.find((c) => c.title === ANA)!;
    const m = ana.messages[1]!;
    expect(m.content?.text).toBe('mira esto\n\nhttps://example.com/x genial');
    expect(m.content?.entities).toEqual([{ type: 'link', offset: 11, length: 21 }]);
  });

  it("writes a share card as caption, owner and link, keeping Meta's own line apart", async () => {
    const ana = (await importArchive(instagramExport(), { timeZone: 'Europe/Madrid' })).archive.conversations.find((c) => c.title === ANA)!;
    const m = ana.messages[2]!;
    expect(m.content?.text).toBe('Best caption\nsome.owner\nhttps://www.instagram.com/reel/ABC/');
    expect(m.content?.entities).toEqual([{ type: 'link', offset: 24, length: 35 }]);
    expect(m.ext?.['instagram']).toMatchObject({ generated: `${ME} sent an attachment.`, share: { url: 'https://www.instagram.com/reel/ABC/', notes: ['Best caption', 'some.owner'] } });
  });

  it('reads photos, voice notes and videos, and flags a file the export lacks', async () => {
    const ana = (await importArchive(instagramExport(), { timeZone: 'Europe/Madrid' })).archive.conversations.find((c) => c.title === ANA)!;
    const [photo, voice, video] = [ana.messages[3]!, ana.messages[4]!, ana.messages[5]!];
    // Every file shares your_instagram_activity/messages/inbox/, which the source strips: refs are source paths.
    expect(photo.attachments).toMatchObject([{ kind: 'image', ref: 'anapop_1/photos/1.jpg', present: true }]);
    expect(voice.attachments).toMatchObject([{ kind: 'voice', ref: 'anapop_1/audio/2.mp4', present: true }]);
    expect(video.attachments).toMatchObject([{ kind: 'video', present: false, omitted: 'missing' }]);
    expect(photo.content).toBeUndefined();
  });

  it('reads reactions with their actor and time', async () => {
    const ana = (await importArchive(instagramExport(), { timeZone: 'Europe/Madrid' })).archive.conversations.find((c) => c.title === ANA)!;
    const [r] = ana.messages[3]!.reactions!;
    expect(r!.emoji).toBe('❤');
    expect(nameOf(ana, r!.senderId)).toBe(ME);
    expect(r!.ts).toBe(Date.UTC(2024, 6, 14, 9, 30));
    expect(ana.messages[0]!.reactions![0]).toMatchObject({ emoji: '😂' });
    expect(ana.messages[0]!.reactions![0]!.ts).toBeUndefined();
  });

  it('reads a call with its duration, an empty message and an undated one', async () => {
    const ana = (await importArchive(instagramExport(), { timeZone: 'Europe/Madrid' })).archive.conversations.find((c) => c.title === ANA)!;
    expect(ana.messages[6]).toMatchObject({ kind: 'call', call: { durationSec: 180, label: 'Llamada de audio finalizada' } });
    expect(ana.messages[7]!.meta).toEqual({ contentUnavailable: true });
    expect(ana.messages[8]!.meta).toEqual({ timeInferred: true, contentUnavailable: true });
    expect(ana.messages[8]!.ts).toBe(ana.messages[7]!.ts);
  });

  it('reads one thread folder dropped on its own', async () => {
    const full = instagramExport();
    const files = full.files.filter((f) => f.path.startsWith('anapop_1/'));
    const { archive, detectedPlatform } = await importArchive({ name: 'anapop_1', files }, { timeZone: 'Europe/Madrid' });
    expect(detectedPlatform).toBe('instagram');
    const [c] = archive.conversations;
    expect(c!.messages).toHaveLength(9);
    expect(c!.messages[3]!.attachments).toMatchObject([{ ref: 'anapop_1/photos/1.jpg', present: true }]);
  });

  it('finds the account owner from the name present in every thread', async () => {
    const { archive } = await importArchive(instagramExport(), { timeZone: 'Europe/Madrid' });
    for (const c of archive.conversations) expect(nameOf(c, c.selfId)).toBe(ME);
  });
});

describe('Meta HTML (Facebook)', () => {
  const FB = 'your_facebook_activity/messages/archived_threads/anapop_9';
  const page = (blocks: string) =>
    `<html><body class="_a7o5"><div><div class="_a705"><header class="_a709"><div class="_a70c"><img src="x.png" /></div><div class="_a70d"><h1>${ANA}</h1><aside>Generated by Cosmin Calin on <time datetime="2025-09-08T22:03Z">Tuesday, Sep 9, 2025 at 12:03 AM UTC+02:00</time></aside></div></header><main class="_a706">${blocks}</main></div></div></body></html>`;
  const block = (sender: string, date: string, body: string) =>
    `<section class="_a6-g"><h2 class="_2ph_ _a6-h _a6-i">${sender}</h2><div class="_2ph_ _a6-p"><div><div></div><div>${body}</div><div></div><div></div></div></div><footer class="_3-94 _a6-o"><div class="_a72d">${date}</div></footer></section>`;
  const source = () =>
    sourceFromBytes('facebook-someone-2025-09-09', [
      { path: `${FB}/message_1.html`, bytes: enc(page(block('Cosmin Calin', 'Jun 10, 2025 10:15:03 pm', 'second') + block(ANA, 'Jun 10, 2025 10:14:59 pm', 'first'))) },
    ]);

  it('reads the section layout with seconds and takes the owner from the page footer', async () => {
    const { archive, detectedPlatform, warnings } = await importArchive(source(), { timeZone: 'Europe/Madrid' });
    expect(detectedPlatform).toBe('messenger');
    const [c] = archive.conversations;
    expect(c!.messages.map((m) => m.content?.text)).toEqual(['first', 'second']);
    expect(c!.messages[1]!.ts).toBe(Date.UTC(2025, 5, 10, 20, 15, 3));
    expect(nameOf(c!, c!.selfId)).toBe('Cosmin Calin');
    expect(c!.meta?.['folder']).toBe('archived_threads');
    expect(warnings).toEqual([]);
  });

  it('warns when the chosen zone disagrees with the offset the export states', async () => {
    const { warnings } = await importArchive(source(), { timeZone: 'Europe/London' });
    expect(warnings.join('\n')).toMatch(/UTC\+02:00.*Europe\/London.*UTC\+01:00/s);
  });
});

describe('Meta JSON', () => {
  const T = 'messages/inbox/anapop_5';
  // Meta writes UTF-8 bytes as Latin-1 escapes in its JSON.
  const latin1 = (s: string) => String.fromCharCode(...new TextEncoder().encode(s));
  const json = {
    participants: [{ name: latin1('Ana Pop') }, { name: latin1('Cosmin Călin') }, { name: 'Bob' }],
    title: latin1('Grupo ñ'),
    messages: [
      { sender_name: 'Bob', timestamp_ms: 1720954000000, type: 'Unsubscribe', users: [{ name: 'Bob' }], content: 'Bob left the group.' },
      { sender_name: latin1('Cosmin Călin'), timestamp_ms: 1720953900000, call_duration: 0, type: 'Call', content: 'Missed call' },
      { sender_name: 'Ana Pop', timestamp_ms: 1720953800000, is_unsent: true },
      { sender_name: 'Ana Pop', timestamp_ms: 1720953700000, content: 'Ana Pop sent an attachment.', share: { link: 'https://www.instagram.com/p/XYZ/', share_text: 'nice', original_content_owner: 'owner.x' } },
      { sender_name: 'Ana Pop', timestamp_ms: 1720953600000, content: latin1('¿Qué tal? 👋'), photos: [{ uri: `${T}/photos/1.jpg` }], reactions: [{ reaction: latin1('❤'), actor: latin1('Cosmin Călin') }] },
    ],
  };
  const source = () =>
    sourceFromBytes('facebook-json', [
      { path: `${T}/message_1.json`, bytes: enc(JSON.stringify(json)) },
      { path: `${T}/photos/1.jpg`, bytes: new Uint8Array([1, 2]) },
    ]);

  it('re-decodes Latin-1-escaped text, orders oldest first and keeps the record', async () => {
    const { archive } = await importArchive(source(), { source: 'messenger' });
    const [c] = archive.conversations;
    expect(c!.title).toBe('Grupo ñ');
    expect(c!.kind).toBe('group');
    expect(c!.participants.map((p) => p.displayName)).toContain('Cosmin Călin');
    expect(c!.messages.map((m) => m.ts)).toEqual([1720953600000, 1720953700000, 1720953800000, 1720953900000, 1720954000000]);
    const [photo, share, unsent, call, left] = c!.messages;
    expect(photo).toMatchObject({ kind: 'media', content: { text: '¿Qué tal? 👋' }, attachments: [{ kind: 'image', present: true }] });
    expect(nameOf(c!, photo!.reactions![0]!.senderId)).toBe('Cosmin Călin');
    expect(share!.content?.text).toBe('nice\nowner.x\nhttps://www.instagram.com/p/XYZ/');
    expect(share!.ext?.['messenger']?.['generated']).toBe('Ana Pop sent an attachment.');
    expect(unsent!.deleted).toBe(true);
    expect(call).toMatchObject({ kind: 'call', call: { durationSec: 0, reason: 'missed' } });
    expect(left).toMatchObject({ kind: 'service', service: { action: 'unsubscribe', data: { users: ['Bob'] } } });
    expect(photo!.raw).toBeDefined();
    expect(c!.meta?.['exportFormat']).toBe('dyi-json');
  });
});

describe('Meta helpers', () => {
  it('parses both date formats and durations', () => {
    expect(parseMetaDate('Sep 08, 2025 10:15 am')).toEqual({ year: 2025, month: 9, day: 8, hour: 10, minute: 15, second: 0 });
    expect(parseMetaDate('Jun 10, 2025 12:05:03 am')).toEqual({ year: 2025, month: 6, day: 10, hour: 0, minute: 5, second: 3 });
    expect(parseMetaDate(' (Jul 14, 2024 12:30 pm)')).toMatchObject({ hour: 12, minute: 30 });
    expect(parseMetaDate('')).toBeNull();
    expect(parseDuration('Duration: 3 minutes')).toBe(180);
    expect(parseDuration('1 hour 2 minutes 5 seconds')).toBe(3725);
    expect(parseDuration('no')).toBeUndefined();
  });

  it('splits a reaction into the first emoji and the name, flags included', () => {
    expect(splitReaction('❤🇷🇴Ana Pop🇷🇴')).toEqual({ emoji: '❤', name: '🇷🇴Ana Pop🇷🇴' });
    expect(splitReaction('❤️Ana')).toEqual({ emoji: '❤️', name: 'Ana' });
    expect(splitReaction('👍🏽 Bob')).toEqual({ emoji: '👍🏽', name: 'Bob' });
    expect(splitReaction('👨‍👩‍👧Ana')).toEqual({ emoji: '👨‍👩‍👧', name: 'Ana' });
  });

  it('re-decodes only real mojibake', () => {
    expect(fixMojibake('Ã±')).toBe('ñ');
    expect(fixMojibake('ñ')).toBe('ñ');
    expect(fixMojibake('plain')).toBe('plain');
    expect(fixMojibake('ñ ✓')).toBe('ñ ✓');
  });

  it('keeps a wall-clock sequence in order across the hour that repeats when clocks go back', () => {
    const seq = new WallClockSequence('Europe/Madrid');
    const at = (h: number, m: number) => seq.at({ year: 2024, month: 10, day: 27, hour: h, minute: m, second: 0 });
    const a = at(2, 40); // CEST, first pass
    const b = at(2, 10); // after the change: the second 02:10 (CET)
    expect(a).toBe(Date.UTC(2024, 9, 27, 0, 40));
    expect(b).toBe(Date.UTC(2024, 9, 27, 1, 10));
  });
});
