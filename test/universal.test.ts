import { describe, expect, it } from 'vitest';
import { importConversation, readUniversalChat } from '../src/index';

describe('readUniversalChat', () => {
  it('normalises a copy and leaves the value it was given unchanged', async () => {
    const txt = '[14/07/2024, 11:00:00] Ana: hola\r\n[14/07/2024, 11:01:00] Bob: hi\r\n';
    const { conversation } = await importConversation({ name: '_chat.txt', bytes: new TextEncoder().encode(txt) });
    const value = JSON.parse(JSON.stringify(conversation)) as { kind: string; messages: Array<{ kind: string }> };
    // Values a newer version might add.
    value.kind = 'broadcast';
    value.messages[0]!.kind = 'hologram';
    const before = JSON.stringify(value);

    const doc = readUniversalChat(value);

    expect(JSON.stringify(value)).toBe(before);
    const c = doc.conversations[0]!;
    expect(c.kind).toBe('group');
    expect(c.messages[0]!.kind).toBe('text');
    expect(c.messages[0]!.ext?.['universalchat']).toMatchObject({ original_kind: 'hologram' });
    expect(c.messages).toHaveLength(2);
  });
});
