import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importConversation, makeSource, zonedTimeToUtc, type Conversation, type Message } from '../src/index';
import { sourceFromPath } from '../src/node/index';

const FIXTURE = fileURLToPath(new URL('./fixtures/telegram-export', import.meta.url));
const TZ = 'Europe/London';

async function load(format: 'json' | 'html'): Promise<Conversation> {
  const full = await sourceFromPath(FIXTURE);
  const files = full.files.filter((f) => (format === 'json' ? !f.path.endsWith('.html') : f.path !== 'result.json'));
  return (await importConversation(makeSource(full.name, files), { timeZone: TZ })).conversation;
}

const byTg = (c: Conversation, i: number): Message => c.messages[i]!;
const name = (c: Conversation, m: Message): string | undefined =>
  c.participants.find((p) => p.id === m.senderId)?.displayName;

describe('Telegram Desktop export — JSON', () => {
  it('reads every message, the deleted peer and the local offsets', async () => {
    const c = await load('json');
    expect(c.messages).toHaveLength(21);
    expect(c.kind).toBe('dm');
    expect(c.title).toBe('Deleted Account');
    const peer = c.participants.find((p) => p.meta?.deletedAccount);
    expect(peer?.displayName).toBe('Deleted Account');
    expect(byTg(c, 0).tzOffsetMinutes).toBe(60); // July, UTC+1
    expect(byTg(c, 20).tzOffsetMinutes).toBe(0); // December, UTC+0
    expect(new Date(byTg(c, 0).ts).toISOString()).toBe('2024-07-14T10:00:00.000Z');
  });

  it('marks media present, not included, or unavailable', async () => {
    const c = await load('json');
    const att = (i: number) => byTg(c, i).attachments?.[0];
    expect(att(1)).toMatchObject({ kind: 'image', ref: 'photos/photo_1@14-07-2024_10-00-05.jpg', present: true });
    expect(att(2)).toMatchObject({ kind: 'voice', present: true, durationSec: 7 });
    expect(att(3)).toMatchObject({ kind: 'sticker', stickerFormat: 'webp', emoji: '😀', present: true });
    expect(att(4)).toMatchObject({ kind: 'sticker', stickerFormat: 'tgs', present: true });
    expect(att(5)).toMatchObject({ kind: 'video', present: false, omitted: 'not_included' });
    expect(byTg(c, 5).content?.text).toBe('video caption');
    expect(att(6)).toMatchObject({ kind: 'gif', ref: 'video_files/IMG_0001.MOV', present: true });
    expect(att(16)).toMatchObject({ kind: 'gif', present: false, omitted: 'not_included' });
    expect(att(17)).toMatchObject({ kind: 'image', present: false, omitted: 'unavailable', selfDestructSec: 10 });
  });

  it('keeps calls, locations, contacts, polls, checklists and service events structured', async () => {
    const c = await load('json');
    expect(byTg(c, 7)).toMatchObject({ kind: 'call', call: { durationSec: 51, reason: 'hangup' } });
    expect(name(c, byTg(c, 7))).toBe('Deleted Account');
    expect(byTg(c, 8)).toMatchObject({ kind: 'location', location: { lat: 41.3851, lng: 2.1734 } });
    expect(byTg(c, 9)).toMatchObject({
      kind: 'contact',
      contact: { firstName: 'Ana', lastName: 'Pop', phone: '+40 700 000 000', vcardRef: 'contacts/contact_1.vcard' },
    });
    expect(byTg(c, 10).poll).toMatchObject({ question: '¿Vamos?', totalVoters: 2, options: [{ text: 'Sí', votes: 2, chosen: true }, { text: 'No', votes: 0 }] });
    expect(byTg(c, 11).checklist).toMatchObject({ title: 'Lista', items: [{ id: 1, text: 'Pan' }, { id: 2, text: 'Leche' }] });
    expect(byTg(c, 12).content?.text).toBe('☑️ marked done: “Pan”');
    expect(byTg(c, 15)).toMatchObject({ kind: 'service', service: { action: 'pin_message', data: { messageId: 1014 } } });
  });

  it('keeps replies, edits, reactions, forwards, inline bots and entities', async () => {
    const c = await load('json');
    const reply = byTg(c, 13);
    expect(reply.replyToId).toBe(byTg(c, 1).id);
    expect(reply.editedAt).toBe(1720951980 * 1000);
    expect(reply.reactions).toEqual([{ emoji: '❤', count: 1 }]);
    expect(reply.content?.text).toBe('line one\nline two');
    expect(byTg(c, 14).forwardedFrom).toEqual({ name: 'Ana Pop', handle: 'user77' });
    expect(byTg(c, 16).viaBot).toBe('@gif');
    const ents = byTg(c, 18).content?.entities.map((e) => `${e.type}@${e.offset}+${e.length}`);
    expect(ents).toEqual(['custom@0+2', 'spoiler@8+7']);
  });
});

describe('Telegram Desktop export — HTML matches JSON', () => {
  it('parses the HTML pages into the same messages', async () => {
    const json = await load('json');
    const html = await load('html');
    expect(html.messages).toHaveLength(json.messages.length);
    expect(html.title).toBe('Deleted Account');
    for (let i = 0; i < json.messages.length; i++) {
      const a = json.messages[i]!;
      const b = html.messages[i]!;
      expect(b.kind, `kind #${i}`).toBe(a.kind);
      if (a.kind === 'service') continue; // HTML service lines carry no timestamp or sender id
      expect(name(html, b), `sender #${i}`).toBe(name(json, a));
      expect(b.ts, `ts #${i}`).toBe(a.ts);
      if (['text', 'media', 'sticker'].includes(a.kind)) expect(b.content?.text ?? '', `text #${i}`).toBe(a.content?.text ?? '');
      expect((b.attachments ?? []).map((x) => [x.kind, x.ref, x.present, x.omitted])).toEqual(
        (a.attachments ?? []).map((x) => [x.kind, x.ref, x.present, x.omitted]),
      );
      expect(!!b.replyToId).toBe(!!a.replyToId);
      expect(!!b.forwardedFrom).toBe(!!a.forwardedFrom);
    }
    expect(html.messages[7]!.call?.durationSec).toBe(51);
    expect(html.messages[10]!.poll?.options.map((o) => o.votes)).toEqual([2, 0]);
    expect(html.messages[11]!.checklist?.items.map((i) => i.text)).toEqual(['Pan', 'Leche']);
    expect(html.messages[9]!.contact?.vcardRef).toBe('contacts/contact_1.vcard');
    expect(html.messages[14]!.forwardedFrom?.name).toBe('Ana Pop');
    expect(html.messages[16]!.viaBot).toBe('@gif');
  });

  it('reads the HTML wall clock in the given zone, not the export-day offset label', async () => {
    const html = await load('html');
    // Labelled "UTC+00:00" in the file, but 14 July in London is UTC+1.
    expect(new Date(html.messages[0]!.ts).toISOString()).toBe('2024-07-14T10:00:00.000Z');
    expect(new Date(html.messages[20]!.ts).toISOString()).toBe('2024-12-01T12:00:00.000Z');
  });
});

describe('zonedTimeToUtc', () => {
  it('takes the first occurrence in the hour the clocks go back', () => {
    const t = zonedTimeToUtc({ year: 2025, month: 10, day: 26, hour: 1, minute: 8, second: 26 }, 'Europe/London');
    expect(new Date(t).toISOString()).toBe('2025-10-26T00:08:26.000Z');
  });

  it('moves a time inside the skipped hour past the gap', () => {
    const t = zonedTimeToUtc({ year: 2025, month: 3, day: 30, hour: 1, minute: 30, second: 0 }, 'Europe/London');
    expect(new Date(t).toISOString()).toBe('2025-03-30T01:30:00.000Z');
  });
});
