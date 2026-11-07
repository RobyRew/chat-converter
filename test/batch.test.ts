import { BlobReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';
import {
  arrayBufferView,
  importArchive,
  memoryWritable,
  readUniversalChat,
  searchConversations,
  sourceFromBytes,
  summarizeArchive,
  summarizeConversation,
  writeBatch,
} from '../src/index';

// Two synthetic VSCO conversations: the smallest multi-conversation export.
const enc = (s: string) => new TextEncoder().encode(s);
const convo = (id: string, other: string, texts: string[]) => ({
  id, userID: 1, participantUserIds: [1, 2],
  participants: [{ user_id: 1, name: 'Cosmin', domain: 'cosmin' }, { user_id: id === 'a' ? 2 : 3, name: other, domain: other.toLowerCase() }],
  messages: texts.map((text, i) => ({ id: `${id}${i}`, fromUserId: i % 2 ? 1 : id === 'a' ? 2 : 3, createdAt: (id === 'a' ? 1_000_000 : 2_000_000) + (texts.length - i) * 1000, order: texts.length - i, text })),
});
const source = () => sourceFromBytes('vsco-test', [{ path: 'messages.json', bytes: enc(JSON.stringify([convo('a', 'Ana', ['último', 'hola Ana']), convo('b', 'Bob', ['see you', 'Ñandú time', 'hey'])])) }]);

async function unzip(bytes: Uint8Array) {
  const reader = new ZipReader(new BlobReader(new Blob([arrayBufferView(bytes)])));
  const entries = await reader.getEntries();
  return { entries, reader };
}

describe('summaries and search', () => {
  it('summarizes each conversation for an inbox', async () => {
    const { archive } = await importArchive(source());
    const rows = archive.conversations.map((c, i) => summarizeConversation(c, i));
    const bob = rows.find((r) => r.title === 'Bob')!;
    expect(bob).toMatchObject({ kind: 'dm', messageCount: 3, participants: ['Bob'], selfName: 'Cosmin', media: { total: 0, present: 0, bytes: 0 } });
    expect(bob.preview).toEqual({ text: 'see you', sender: 'Bob', mine: false });
    expect(bob.lastTs).toBeGreaterThan(bob.firstTs!);
    expect(summarizeArchive(rows, archive.source)).toMatchObject({ platform: 'vsco', conversations: 2, messages: 5 });
  });

  it('finds text in every conversation, ignoring case and accents', async () => {
    const { archive } = await importArchive(source());
    const { hits, total } = searchConversations(archive.conversations, 'nandu');
    expect(total).toBe(1);
    expect(hits[0]!.snippet).toBe('Ñandú time');
    expect(hits[0]!.snippet.slice(hits[0]!.at, hits[0]!.at + hits[0]!.length)).toBe('Ñandú');
    expect(searchConversations(archive.conversations, 'ULTIMO').total).toBe(1);
    expect(searchConversations(archive.conversations, 'x').total).toBe(0);
  });
});

describe('batch conversion', () => {
  it('writes a zip holding one Telegram import package per conversation', async () => {
    const src = source();
    const { archive } = await importArchive(src);
    const out = memoryWritable();
    const r = await writeBatch(archive.conversations.map((conversation) => ({ conversation })), { target: 'telegram-ios', source: src, destination: out.writable, name: 'vsco-test' });
    expect(r).toMatchObject({ layout: 'zip-of-files', conversations: 2, messagesIn: 5, messagesOut: 5, suggestedName: 'vsco-test - 2 chats.zip' });
    const { entries, reader } = await unzip(out.result());
    expect(entries.map((e) => e.filename).sort()).toEqual(['WhatsApp Chat - Ana.zip', 'WhatsApp Chat - Bob.zip']);
    for (const e of entries) {
      if (e.directory) continue;
      const inner = new ZipReader(new Uint8ArrayReader(await e.getData(new Uint8ArrayWriter())));
      const innerEntries = await inner.getEntries();
      expect(innerEntries[0]!.filename).toBe('_chat.txt');
      const first = innerEntries[0]!;
      const text = first.directory ? '' : await first.getData(new TextWriter());
      expect(text).toMatch(/Messages and calls are end-to-end encrypted/);
      await inner.close();
    }
    await reader.close();
  });

  it('writes one UniversalChat package holding every selected conversation', async () => {
    const src = source();
    const { archive } = await importArchive(src);
    const out = memoryWritable();
    const r = await writeBatch(archive.conversations.map((conversation) => ({ conversation })), { target: 'universalchat-zip', source: src, destination: out.writable, name: 'vsco-test', ...(archive.source ? { archiveSource: archive.source } : {}) });
    expect(r.layout).toBe('universalchat');
    const { entries, reader } = await unzip(out.result());
    const doc = entries.find((e) => e.filename === 'universalchat.json')!;
    const back = readUniversalChat(JSON.parse(doc.directory ? '' : await doc.getData(new TextWriter())));
    expect(back.conversations.map((c) => c.title).sort()).toEqual(['Ana', 'Bob']);
    expect(back.source?.platform).toBe('vsco');
    await reader.close();
  });

  it('writes a zip with one text file per conversation, applying each one’s options', async () => {
    const src = source();
    const { archive } = await importArchive(src);
    const out = memoryWritable();
    const items = archive.conversations.map((conversation, i) => ({ conversation, ...(i === 0 ? { exportOptions: { title: 'Renamed' } } : {}) }));
    await writeBatch(items, { target: 'markdown', source: src, destination: out.writable });
    const { entries, reader } = await unzip(out.result());
    expect(entries.map((e) => e.filename).sort()).toEqual([`${archive.conversations[1]!.title}.md`, 'Renamed.md'].sort());
    await reader.close();
  });
});
