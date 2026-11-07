import { describe, expect, it } from 'vitest';
import { convert } from '../src/index';
import { load } from './util';

describe('telegram importer', () => {
  it('parses entities, replies and reactions', async () => {
    const { conversation: c } = await convert(load('telegram-sample.json'), {
      target: 'json',
      source: 'telegram',
    });
    expect(c.originPlatform).toBe('telegram');
    expect(c.messages).toHaveLength(3);

    const m2 = c.messages[1]!;
    expect(m2.content?.text).toBe('Check this out: link');
    expect(m2.content?.entities.find((e) => e.type === 'bold')).toMatchObject({ offset: 6, length: 4 });
    expect(m2.content?.entities.find((e) => e.type === 'link')).toMatchObject({
      offset: 16,
      length: 4,
      url: 'https://example.com',
    });

    const m3 = c.messages[2]!;
    expect(m3.replyToId).toBe(c.messages[1]!.id);
    expect(m3.reactions?.[0]).toMatchObject({ emoji: '👍', count: 2 });

    expect(c.messages[0]!.ts).toBe(1741776330 * 1000);
  });

  it('round-trips telegram -> telegram-json -> telegram preserving entities and replies', async () => {
    const r1 = await convert(load('telegram-sample.json'), { target: 'telegram-json', source: 'telegram' });
    const out = r1.artifact.files[0]!;
    const r2 = await convert({ name: 'result.json', bytes: out.bytes }, { target: 'json', source: 'telegram' });
    const a = r1.conversation;
    const b = r2.conversation;

    expect(b.messages.map((m) => m.ts)).toEqual(a.messages.map((m) => m.ts));
    expect(b.messages[1]!.content?.text).toBe('Check this out: link');
    expect(b.messages[1]!.content?.entities.map((e) => e.type).sort()).toEqual(['bold', 'link']);
    expect(b.messages[2]!.replyToId).toBe(b.messages[1]!.id);
    expect(b.participants.map((p) => p.displayName).sort()).toEqual(['Alice', 'Bob']);
  });
});
