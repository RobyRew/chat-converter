/**
 * Checks against real exports on the developer's machine. Nothing here reads data unless the paths are
 * given, and no personal data is committed:
 *
 *   CHAT_CONVERTER_REAL_EXPORTS=~/Downloads/"Telegram Desktop"  (folders named ChatExport_*)
 *   CHAT_CONVERTER_REAL_WHATSAPP=~/exports/whatsapp      (files named "WhatsApp Chat - *.zip")
 *   CHAT_CONVERTER_TZ=Europe/London                             (zone of the machine that exported HTML)
 *
 * Archives written by these tests go to `.real-exports/` (git-ignored).
 */
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';
import {
  findHtmlPages,
  importConversation,
  makeSource,
  MediaStore,
  parseTelegramHtml,
  writePackage,
  type Conversation,
} from '../../src/index';
import { fileWritable, sourceFromPath } from '../../src/node/index';
import { openAsBlob } from 'node:fs';

const TG = process.env['CHAT_CONVERTER_REAL_EXPORTS'];
const WA = process.env['CHAT_CONVERTER_REAL_WHATSAPP'];
const TZ = process.env['CHAT_CONVERTER_TZ'] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const OUT = join(process.cwd(), '.real-exports');

const IOS = {
  photo: /.*?\.jpg/,
  video: /[\d]+-VIDEO-.*?\.mp4/,
  sticker: /[\d]+-STICKER-.*?\.webp/,
  voice: /[\d]+-AUDIO-.*?\.opus/,
  main: /_chat\.txt|KakaoTalkChats\.txt|Talk_.*?\.txt/,
};

async function readZip(path: string) {
  const reader = new ZipReader(new BlobReader(await openAsBlob(path)));
  const entries = await reader.getEntries();
  const chat = entries.find((e) => e.filename === '_chat.txt');
  const text = chat && !chat.directory ? await chat.getData(new TextWriter()) : '';
  await reader.close();
  return { entries, text };
}

describe.skipIf(!TG)('real Telegram Desktop exports', () => {
  const dirs = TG ? readdirSync(TG).filter((d) => d.startsWith('ChatExport_')).map((d) => join(TG, d)) : [];

  it('imports every export with the same message count', async () => {
    const counts: number[] = [];
    for (const dir of dirs) {
      const { conversation } = await importConversation(await sourceFromPath(dir), { timeZone: TZ });
      counts.push(conversation.messages.length);
    }
    expect(counts.length).toBeGreaterThan(0);
    expect(new Set(counts).size).toBe(1);
  }, 600_000);

  it('agrees between HTML and JSON wherever an export has both', async () => {
    for (const dir of dirs) {
      const src = await sourceFromPath(dir);
      const pages = findHtmlPages(src.files);
      if (!pages.length || !src.files.some((f) => f.path === 'result.json')) continue;
      const json = (await importConversation(makeSource(src.name, src.files.filter((f) => !f.path.endsWith('.html'))))).conversation;
      const html = await parseTelegramHtml(pages, { media: new MediaStore(src.files), warn: () => undefined, timeZone: TZ });
      expect(html.messages.length).toBe(json.messages.length);
      const name = (c: Conversation, id?: string) => c.participants.find((p) => p.id === id)?.displayName;
      let mismatches = 0;
      json.messages.forEach((a, i) => {
        const b = html.messages[i]!;
        if (a.kind !== b.kind) mismatches++;
        else if (a.kind !== 'service' && (a.ts !== b.ts || name(json, a.senderId) !== name(html, b.senderId))) mismatches++;
        else if (['text', 'media', 'sticker'].includes(a.kind) && (a.content?.text ?? '') !== (b.content?.text ?? '')) mismatches++;
      });
      expect(mismatches).toBe(0);
    }
  }, 600_000);

  it('writes a telegram-ios package that keeps every message and references every entry once', async () => {
    mkdirSync(OUT, { recursive: true });
    for (const dir of dirs) {
      const source = await sourceFromPath(dir);
      const { conversation } = await importConversation(source, { timeZone: TZ });
      const path = join(OUT, `${source.name}.telegram-ios.zip`);
      const result = await writePackage(conversation, { target: 'telegram-ios', source, destination: fileWritable(path) });
      expect(result.summary.messagesOut).toBe(conversation.messages.length);

      const { entries, text } = await readZip(path);
      const names = entries.map((e) => e.filename);
      expect(names[0]).toBe('_chat.txt');
      expect(names.filter((n) => IOS.main.test(n))).toEqual(['_chat.txt']);
      expect(entries.every((e) => e.filenameUTF8 && e.uncompressedSize > 0)).toBe(true);
      const refs = [...text.matchAll(/<attached: ([^>]+)>/g)].map((m) => m[1]!);
      expect(new Set(refs).size).toBe(refs.length);
      expect([...refs].sort()).toEqual(names.slice(1).sort());

      // Each entry's iOS media type matches what the attachment is.
      const kinds = new Map<string, string>();
      for (const n of names.slice(1)) {
        kinds.set(n, IOS.photo.test(n) ? 'photo' : IOS.video.test(n) ? 'video' : IOS.sticker.test(n) ? 'sticker' : IOS.voice.test(n) ? 'voice' : 'file');
      }
      const typed = [...kinds.values()];
      const att = conversation.messages.flatMap((m) => m.attachments ?? []).filter((a) => a.present);
      const expected = {
        photo: att.filter((a) => a.kind === 'image' && /\.jpe?g$/i.test(a.ref ?? '')).length,
        voice: att.filter((a) => a.kind === 'voice').length,
        sticker: att.filter((a) => a.kind === 'sticker' && a.stickerFormat === 'webp').length,
        video: att.filter((a) => a.kind === 'video' || a.kind === 'gif').length,
      };
      expect(typed.filter((t) => t === 'photo').length).toBe(expected.photo);
      expect(typed.filter((t) => t === 'voice').length).toBe(expected.voice);
      expect(typed.filter((t) => t === 'sticker').length).toBe(expected.sticker);
      expect(typed.filter((t) => t === 'video').length).toBe(expected.video);

      // The package reads back with every message (plus the notice line).
      const back = (await importConversation(await sourceFromPath(path))).conversation;
      expect(back.messages.length).toBe(conversation.messages.length + 1);
    }
  }, 1_800_000);
});

describe.skipIf(!WA)('real WhatsApp exports', () => {
  const zips = WA ? readdirSync(WA).filter((f) => /^WhatsApp Chat - .*\.zip$/.test(f)).map((f) => join(WA, f)) : [];

  it('round-trips byte-identical through the whatsapp-zip target', async () => {
    mkdirSync(OUT, { recursive: true });
    for (const zip of zips) {
      const source = await sourceFromPath(zip);
      const original = await readZip(zip);
      const { conversation } = await importConversation(source);
      const path = join(OUT, `roundtrip-${source.name}.zip`);
      await writePackage(conversation, { target: 'whatsapp-zip', source, destination: fileWritable(path) });
      const mine = await readZip(path);
      expect(mine.text).toBe(original.text);
      expect(mine.entries.map((e) => e.filename).sort()).toEqual(original.entries.map((e) => e.filename).sort());
    }
  }, 600_000);
});
