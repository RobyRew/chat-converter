import { fileURLToPath } from 'node:url';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  arrayBufferView,
  E2E_NOTICE,
  importConversation,
  memoryWritable,
  neutralizeDocumentName,
  sourceFromBytes,
  writePackage,
  type Conversation,
  type ExportFormatId,
  type Source,
} from '../src/index';
import { sourceFromPath } from '../src/node/index';

const FIXTURE = fileURLToPath(new URL('./fixtures/telegram-export', import.meta.url));
const LRM = '‎';

// Telegram-iOS ShareExtensionContext.swift @ 24638bc: how an entry name decides the uploaded media type.
const IOS = {
  main: [/_chat\.txt/, /KakaoTalkChats\.txt/, /Talk_.*?\.txt/],
  photo: /.*?\.jpg/,
  video: /[\d]+-VIDEO-.*?\.mp4/,
  sticker: /[\d]+-STICKER-.*?\.webp/,
  voice: /[\d]+-AUDIO-.*?\.opus/,
};
const iosType = (name: string): string =>
  IOS.photo.test(name) ? 'photo' : IOS.video.test(name) ? 'video' : IOS.sticker.test(name) ? 'sticker' : IOS.voice.test(name) ? 'voice' : 'file';

async function telegramFixture(): Promise<{ conv: Conversation; source: Source }> {
  const source = await sourceFromPath(FIXTURE);
  const { conversation } = await importConversation(source, { timeZone: 'Europe/London' });
  const deleted = conversation.participants.find((p) => p.meta?.deletedAccount)!;
  return { conv: applyEdits(conversation, { renames: { [deleted.id]: 'Sam Rivers' } }), source };
}

async function pack(conv: Conversation, source: Source, target: ExportFormatId, whatsapp = {}) {
  const out = memoryWritable();
  const result = await writePackage(conv, { target, source, destination: out.writable, exportOptions: { whatsapp } });
  const zip = out.result();
  const reader = new ZipReader(new BlobReader(new Blob([arrayBufferView(zip)])));
  const entries = await reader.getEntries();
  const chatEntry = entries.find((e) => e.filename === '_chat.txt');
  const text = chatEntry && !chatEntry.directory ? await chatEntry.getData(new TextWriter()) : '';
  await reader.close();
  return { result, zip, entries, text };
}

describe('telegram-ios package', () => {
  it('puts _chat.txt first, flags names UTF-8 and names media the way Telegram-iOS types it', async () => {
    const { conv, source } = await telegramFixture();
    const { entries, result } = await pack(conv, source, 'telegram-ios');
    const names = entries.map((e) => e.filename);
    expect(names[0]).toBe('_chat.txt');
    expect(entries.every((e) => e.filenameUTF8)).toBe(true);
    expect(entries.every((e) => e.uncompressedSize > 0)).toBe(true);
    expect(names.every((n) => !n.includes('/'))).toBe(true);
    // Only _chat.txt may look like a main chat file.
    expect(names.filter((n) => IOS.main.some((re) => re.test(n)))).toEqual(['_chat.txt']);

    const media = names.slice(1);
    expect(media.map(iosType)).toEqual(['photo', 'voice', 'sticker', 'video', 'file']);
    expect(media[0]).toMatch(/^00000002-PHOTO-2024-07-14-11-00-05\.jpg$/);
    expect(media[1]).toMatch(/^00000003-AUDIO-2024-07-14-11-01-00\.opus$/);
    expect(media[2]).toMatch(/^00000004-STICKER-2024-07-14-11-02-00\.webp$/);
    expect(media[3]).toMatch(/^00000007-VIDEO-2024-07-14-11-05-00\.mp4$/); // GIF (.MOV) as an inline video
    expect(media[4]).toBe('00000010-Ana Pop.vcf');
    expect(result.summary.suggestedName).toBe('WhatsApp Chat - Sam Rivers.zip');
  });

  it("writes WhatsApp's byte format: CRLF per message, LF inside, LRM on media lines", async () => {
    const { conv, source } = await telegramFixture();
    const { text, result } = await pack(conv, source, 'telegram-ios');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    const msgs = text.split('\r\n');
    expect(msgs.at(-1)).toBe('');
    expect(msgs[0]).toBe(`[14/07/2024, 11:00:00] Sam Rivers: ${LRM}${E2E_NOTICE}`);
    expect(msgs[1]).toBe('[14/07/2024, 11:00:00] Sam Rivers: Hola 👋');
    expect(msgs[2]).toBe(`${LRM}[14/07/2024, 11:00:05] Cosmin Calin: mira *esto* ${LRM}<attached: 00000002-PHOTO-2024-07-14-11-00-05.jpg>`);
    expect(msgs[5]).toBe(`${LRM}[14/07/2024, 11:03:00] Sam Rivers: 🚙 ${LRM}sticker omitted`);
    expect(msgs[6]).toBe(`${LRM}[14/07/2024, 11:04:00] Cosmin Calin: video caption ${LRM}video omitted`);
    expect(msgs[8]).toBe('[14/07/2024, 11:06:00] Sam Rivers: 📞 Call · 0:51');
    expect(msgs[9]).toBe(`[14/07/2024, 11:07:00] Cosmin Calin: ${LRM}Location: https://maps.google.com/?q=41.3851,2.1734`);
    expect(msgs[11]).toBe(`[14/07/2024, 11:09:00] Cosmin Calin: ${LRM}POLL:\n¿Vamos?\n${LRM}OPTION: Sí (2 votes)\n${LRM}OPTION: No (0 votes)`);
    expect(msgs[14]).toBe('[14/07/2024, 11:12:00] Sam Rivers: line one\nline two');
    expect(msgs[17]).toBe(`${LRM}[14/07/2024, 11:15:00] Cosmin Calin: ${LRM}GIF omitted`);
    expect(msgs[18]).toBe(`${LRM}[14/07/2024, 11:16:00] Sam Rivers: ${LRM}image omitted`);
    expect(msgs[21]).toBe('[01/12/2024, 12:00:00] Cosmin Calin: invierno');

    expect(result.summary.messagesIn).toBe(21);
    expect(result.summary.messagesOut).toBe(21);
    expect(result.summary.mediaWritten).toBe(5);
    expect(result.summary.dropped).toMatchObject({ replies: 1, reactions: 1, editMarks: 1, forwardLabels: 1 });
  });

  it('references every written entry exactly once', async () => {
    const { conv, source } = await telegramFixture();
    const { text, entries } = await pack(conv, source, 'telegram-ios');
    const refs = [...text.matchAll(/<attached: ([^>]+)>/g)].map((m) => m[1]);
    expect(refs.sort()).toEqual(entries.map((e) => e.filename).filter((n) => n !== '_chat.txt').sort());
  });

  it('re-imports with every message, sender and time intact', async () => {
    const { conv, source } = await telegramFixture();
    const { zip } = await pack(conv, source, 'telegram-ios');
    const back = (await importConversation({ name: 'WhatsApp Chat - Sam Rivers.zip', bytes: zip })).conversation;
    expect(back.title).toBe('Sam Rivers');
    expect(back.messages[0]!.ext?.['whatsapp']?.['notice']).toBe(true);
    const rest = back.messages.slice(1);
    expect(rest).toHaveLength(conv.messages.length);
    const name = (c: Conversation, id?: string) => c.participants.find((p) => p.id === id)?.displayName;
    rest.forEach((m, i) => {
      const o = conv.messages[i]!;
      expect(name(back, m.senderId) ?? 'Sam Rivers').toBe(name(conv, o.senderId) ?? 'Sam Rivers');
      expect(m.ts).toBe(o.ts + (o.tzOffsetMinutes ?? 0) * 60000);
    });
    expect(rest[1]!.attachments?.[0]?.fileName).toBe('00000002-PHOTO-2024-07-14-11-00-05.jpg');
    expect(rest[10]!.poll?.options.map((o) => o.votes)).toEqual([2, 0]);
  });

  it('writes a group export with the group title and a creation line', async () => {
    const { conv, source } = await telegramFixture();
    const { text } = await pack(conv, source, 'telegram-ios', { mode: 'group' });
    const [notice, created] = text.split('\r\n');
    expect(notice).toBe(`[14/07/2024, 11:00:00] Deleted Account: ${LRM}${E2E_NOTICE}`);
    expect(created).toBe(`[14/07/2024, 11:00:00] Cosmin Calin: ${LRM}Cosmin Calin created this group`);
  });
});

describe('whatsapp-zip and telegram-android', () => {
  it("whatsapp-zip keeps WhatsApp's own layout: media first, _chat.txt last, -GIF- names", async () => {
    const { conv, source } = await telegramFixture();
    const { entries } = await pack(conv, source, 'whatsapp-zip');
    const names = entries.map((e) => e.filename);
    expect(names.at(-1)).toBe('_chat.txt');
    expect(names).toContain('00000007-GIF-2024-07-14-11-05-00.mp4');
  });

  it('telegram-android warns that only the text is imported', async () => {
    const { conv, source } = await telegramFixture();
    const { result } = await pack(conv, source, 'telegram-android');
    expect(result.warnings.join('\n')).toMatch(/only the chat text/);
  });
});

describe('text safety', () => {
  it('escapes a continuation line that looks like a message header', async () => {
    const source = sourceFromBytes('x', [
      { path: 'result.json', bytes: new TextEncoder().encode(JSON.stringify({
        name: 'A', type: 'personal_chat', id: 1,
        messages: [{ id: 1, type: 'message', date: '2024-01-01T10:00:00', date_unixtime: '1704103200', from: 'A', from_id: 'user1',
          text: 'first\n[01/01/2020, 10:00:00] B: fake' }],
      })) },
    ]);
    const { conversation } = await importConversation(source);
    const { text } = await pack(conversation, source, 'telegram-ios');
    expect(text).toContain('first\n​[01/01/2020, 10:00:00] B: fake');
    const back = await importConversation({ name: '_chat.txt', bytes: new TextEncoder().encode(text) });
    expect(back.conversation.messages.filter((m) => m.kind !== 'system')).toHaveLength(1);
  });

  it('neutralizes document names Telegram-iOS would retype', () => {
    expect(neutralizeDocumentName('backup.jpg.zip', false)).toBe('backup_jpg.zip');
    expect(neutralizeDocumentName('IMG_1.jpg', true)).toBe('IMG_1.jpg');
    expect(neutralizeDocumentName('00000001-VIDEO-x.mp4', false)).toBe('00000001_VIDEO_x.mp4');
    expect(neutralizeDocumentName('notes_chat.txt', false)).toBe('notes-chat.txt');
    expect(neutralizeDocumentName('Talk_2024.txt', false)).toBe('Talk-2024.txt');
  });
});
