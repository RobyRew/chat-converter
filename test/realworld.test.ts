import { describe, expect, it } from 'vitest';
import { convert } from '../src/index';
import type { InputFile } from '../src/engine/contracts';

// Synthetic inputs that mimic shapes seen in real exports (no personal data committed).
const wa = (s: string): InputFile => ({ name: '_chat.txt', bytes: new TextEncoder().encode(s) });
const tg = (obj: unknown): InputFile => ({ name: 'result.json', bytes: new TextEncoder().encode(JSON.stringify(obj)) });
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('whatsapp formatting', () => {
  it('parses *bold* _italic_ ~strike~ ```mono``` into entities', async () => {
    const { conversation: c } = await convert(
      wa('[01/06/2026, 10:00:00] A: *bold* and _italic_ and ~strike~ and ```mono```\n'),
      { target: 'json', source: 'whatsapp' },
    );
    expect(c.messages[0]!.content!.text).toBe('bold and italic and strike and mono');
    expect(c.messages[0]!.content!.entities.map((e) => e.type).sort()).toEqual([
      'bold', 'code', 'italic', 'strikethrough',
    ]);
  });

  it('does not mangle 2*3=6 or snake_case_var', async () => {
    const { conversation: c } = await convert(wa('[01/06/2026, 10:00:00] A: 2*3=6 and snake_case_var\n'), {
      target: 'json',
      source: 'whatsapp',
    });
    expect(c.messages[0]!.content!.text).toBe('2*3=6 and snake_case_var');
    expect(c.messages[0]!.content!.entities).toHaveLength(0);
  });

  it('round-trips formatting through whatsapp-txt export', async () => {
    const r = await convert(wa('[01/06/2026, 10:00:00] A: hey *bold* _it_ ~st~\n'), {
      target: 'whatsapp-txt',
      source: 'whatsapp',
    });
    const out = dec(r.artifact.files[0]!.bytes);
    expect(out).toContain('*bold*');
    expect(out).toContain('_it_');
    expect(out).toContain('~st~');
  });

  it('converts whatsapp *bold* to a telegram bold entity', async () => {
    const r = await convert(wa('[01/06/2026, 10:00:00] A: this is *bold*\n'), {
      target: 'telegram-json',
      source: 'whatsapp',
    });
    const root = JSON.parse(dec(r.artifact.files[0]!.bytes)) as { messages: Array<{ text: unknown }> };
    const text = root.messages[0]!.text;
    const hasBold =
      Array.isArray(text) &&
      (text as Array<{ type?: string; text?: string }>).some((p) => p.type === 'bold' && p.text === 'bold');
    expect(hasBold).toBe(true);
  });
});

describe('whatsapp attachments & empties', () => {
  it('extracts an inline attachment and keeps the caption', async () => {
    const { conversation: c } = await convert(
      wa('[01/06/2026, 10:00:00] A: works <attached: 00000009-VIDEO-x.mp4>\n'),
      { target: 'json', source: 'whatsapp' },
    );
    const m = c.messages[0]!;
    expect(m.kind).toBe('media');
    expect(m.attachments?.[0]).toMatchObject({ fileName: '00000009-VIDEO-x.mp4', kind: 'video' });
    expect(m.content?.text).toBe('works');
  });

  it('detects a webp sticker by filename', async () => {
    const { conversation: c } = await convert(wa('[01/06/2026, 10:00:00] A: <attached: 0000-STICKER-x.webp>\n'), {
      target: 'json',
      source: 'whatsapp',
    });
    expect(c.messages[0]!.kind).toBe('sticker');
    expect(c.messages[0]!.attachments?.[0]?.kind).toBe('sticker');
  });

  it('keeps an empty "Sender:" message attributed to its sender', async () => {
    const { conversation: c } = await convert(wa('[01/06/2026, 10:00:00] A: hi\n[01/06/2026, 10:01:00] A:\n'), {
      target: 'json',
      source: 'whatsapp',
    });
    expect(c.messages).toHaveLength(2);
    expect(c.messages[1]!.senderId).toBeDefined();
    expect(c.messages[1]!.content).toBeUndefined();
  });
});

describe('telegram poll / location / contact / root types', () => {
  const one = (extra: object) =>
    tg({
      name: 'X',
      type: 'personal_chat',
      id: 1,
      messages: [{ id: 1, type: 'message', date_unixtime: '1700000000', from: 'A', from_id: 'user1', text: '', ...extra }],
    });

  it('textualizes polls (no data loss)', async () => {
    const { conversation: c } = await convert(
      one({ poll: { question: 'Lunch?', answers: [{ text: 'yes', voters: 2 }, { text: 'no', voters: 1 }] } }),
      { target: 'json', source: 'telegram' },
    );
    expect(c.messages[0]!.kind).toBe('poll');
    expect(c.messages[0]!.content?.text).toContain('Lunch?');
    expect(c.messages[0]!.content?.text).toContain('yes (2)');
  });

  it('textualizes locations', async () => {
    const { conversation: c } = await convert(
      one({ place_name: 'Cafe', address: 'Main St', location_information: { latitude: 1.5, longitude: 2.5 } }),
      { target: 'json', source: 'telegram' },
    );
    expect(c.messages[0]!.kind).toBe('location');
    expect(c.messages[0]!.content?.text).toContain('Cafe');
  });

  it('textualizes contacts', async () => {
    const { conversation: c } = await convert(
      one({ contact_information: { first_name: 'Jane', last_name: 'Doe', phone_number: '+123' } }),
      { target: 'json', source: 'telegram' },
    );
    expect(c.messages[0]!.kind).toBe('contact');
    expect(c.messages[0]!.content?.text).toContain('Jane Doe');
  });

  it('maps supergroup and channel root types', async () => {
    const sg = await convert(
      tg({ name: 'G', type: 'private_supergroup', id: 2, messages: [{ id: 1, type: 'message', date_unixtime: '1700000000', from: 'A', from_id: 'user1', text: 'hi' }] }),
      { target: 'json', source: 'telegram' },
    );
    expect(sg.conversation.kind).toBe('group');
    const ch = await convert(
      tg({ name: 'C', type: 'public_channel', id: 3, messages: [{ id: 1, type: 'message', date_unixtime: '1700000000', from: 'C', from_id: 'channel1', text: 'post' }] }),
      { target: 'json', source: 'telegram' },
    );
    expect(ch.conversation.kind).toBe('channel');
  });
});
