import { describe, expect, it } from 'vitest';
import { convert } from '../src/index';
import type { Conversation } from '../src/model';
import { load } from './util';

describe('whatsapp importer', () => {
  it('parses messages, participants, attachments and multiline', async () => {
    const { conversation: c } = await convert(load('whatsapp-sample.txt'), {
      target: 'json',
      source: 'whatsapp',
    });
    expect(c.originPlatform).toBe('whatsapp');
    expect(c.kind).toBe('dm');
    expect(c.messages).toHaveLength(6);

    const names = c.participants.map((p) => p.displayName).sort();
    expect(names).toEqual(['Alice', 'Bob']);

    expect(c.messages[0]!.content?.text).toBe('Hey, how are you?');
    expect(c.messages[0]!.ts).toBe(Date.UTC(2025, 2, 12, 10, 45, 30));

    const media = c.messages[3]!;
    expect(media.kind).toBe('media');
    expect(media.attachments?.[0]?.fileName).toBe('IMG-001.jpg');
    expect(media.attachments?.[0]?.kind).toBe('image');

    expect(c.messages[4]!.content?.text).toBe("Nice photo 😀\nThis is a second line of Bob's message");
  });

  it('round-trips whatsapp -> whatsapp-txt -> whatsapp losslessly', async () => {
    const r1 = await convert(load('whatsapp-sample.txt'), { target: 'whatsapp-txt', source: 'whatsapp' });
    const out = r1.artifact.files[0]!;
    const r2 = await convert({ name: '_chat.txt', bytes: out.bytes }, { target: 'json', source: 'whatsapp' });

    const simplify = (c: Conversation) =>
      c.messages.map((m) => ({
        ts: m.ts,
        sender: m.senderId ? c.participants.find((p) => p.id === m.senderId)?.displayName : undefined,
        text: m.content?.text ?? '',
        atts: (m.attachments ?? []).map((a) => a.fileName ?? '').filter(Boolean),
      }));

    expect(simplify(r2.conversation)).toEqual(simplify(r1.conversation));
  });
});
