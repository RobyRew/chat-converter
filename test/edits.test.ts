import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  convert,
  dateBounds,
  exportConversation,
  importConversation,
  participantMessageCounts,
} from '../src/index';
import { load, text } from './util';

describe('import/export split', () => {
  it('importConversation + exportConversation composes to convert()', async () => {
    const file = load('telegram-sample.json');
    const oneShot = await convert(file, { target: 'telegram-json', source: 'telegram' });
    const imp = await importConversation(file, { source: 'telegram' });
    const exp = await exportConversation(imp.conversation, { target: 'telegram-json' });
    expect(imp.detectedPlatform).toBe('telegram');
    expect(text(exp.artifact.files[0]!.bytes)).toBe(text(oneShot.artifact.files[0]!.bytes));
  });
});

describe('applyEdits', () => {
  it('renames a participant in the exported output', async () => {
    const { conversation } = await importConversation(load('whatsapp-sample.txt'), { source: 'whatsapp' });
    const alice = conversation.participants.find((p) => p.displayName === 'Alice')!;
    const edited = applyEdits(conversation, { renames: { [alice.id]: 'Renamed' } });
    expect(edited.participants.find((p) => p.id === alice.id)?.displayName).toBe('Renamed');

    const out = text((await exportConversation(edited, { target: 'whatsapp-txt' })).artifact.files[0]!.bytes);
    expect(out).toContain('Renamed:');
    expect(out).not.toContain('Alice');
  });

  it('drops messages by id and the report reflects the lower count', async () => {
    const { conversation } = await importConversation(load('telegram-sample.json'), { source: 'telegram' });
    const edited = applyEdits(conversation, { removedIds: [conversation.messages[0]!.id] });
    expect(edited.messages).toHaveLength(conversation.messages.length - 1);
    const exp = await exportConversation(edited, { target: 'whatsapp-txt' });
    expect(exp.report.stats.messages).toBe(conversation.messages.length - 1);
  });

  it('filters by date range', async () => {
    const { conversation } = await importConversation(load('telegram-sample.json'), { source: 'telegram' });
    const earliest = conversation.messages[0]!.ts;
    const filtered = applyEdits(conversation, { dateTo: earliest });
    expect(filtered.messages.length).toBeLessThan(conversation.messages.length);
    expect(filtered.messages.every((m) => m.ts <= earliest)).toBe(true);
    const bounds = dateBounds(conversation)!;
    expect(bounds.min).toBeLessThanOrEqual(bounds.max);
  });

  it('overrides title and kind; empty edits keeps message count', async () => {
    const { conversation } = await importConversation(load('telegram-sample.json'), { source: 'telegram' });
    const edited = applyEdits(conversation, { title: 'New Title', kind: 'group' });
    expect(edited.title).toBe('New Title');
    expect(edited.kind).toBe('group');
    expect(applyEdits(conversation, {}).messages).toHaveLength(conversation.messages.length);
  });

  it('participantMessageCounts sums to the number of messages with a sender', async () => {
    const { conversation } = await importConversation(load('whatsapp-sample.txt'), { source: 'whatsapp' });
    const counts = participantMessageCounts(conversation);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(conversation.messages.filter((m) => m.senderId).length);
  });
});
