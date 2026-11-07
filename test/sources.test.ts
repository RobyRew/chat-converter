import { BlobReader, ZipReader } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';
import {
  arrayBufferView,
  fileFromBytes,
  importConversation,
  listExports,
  makeSource,
  memoryWritable,
  sourceFromBlobs,
  sourceFromZip,
  splitExports,
  ZipSink,
} from '../src/index';
import { load } from './util';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('makeSource', () => {
  it('strips the dropped folder and junk entries', () => {
    const src = makeSource('drop', [
      fileFromBytes('ChatExport_2026-11-07/result.json', enc('{}')),
      fileFromBytes('ChatExport_2026-11-07/photos/photo_1@01-01-2024_10-00-00.jpg', enc('x')),
      fileFromBytes('ChatExport_2026-11-07/.DS_Store', enc('')),
      fileFromBytes('__MACOSX/ChatExport_2026-11-07/._result.json', enc('')),
    ]);
    expect(src.name).toBe('ChatExport_2026-11-07');
    expect(src.files.map((f) => f.path).sort()).toEqual(['photos/photo_1@01-01-2024_10-00-00.jpg', 'result.json']);
  });

  it('splits several dropped exports into one source each', () => {
    const src = makeSource('drop', [
      fileFromBytes('ChatExport_2026-11-07/messages.html', enc('<html></html>')),
      fileFromBytes('ChatExport_2026-11-07 (1)/result.json', enc('{}')),
      fileFromBytes('ChatExport_2026-11-07 (2)/result.json', enc('{}')),
      fileFromBytes('ChatExport_2026-11-07 (2)/photos/a.jpg', enc('x')),
    ]);
    const parts = splitExports(src);
    expect(parts.map((s) => s.name)).toEqual(['ChatExport_2026-11-07', 'ChatExport_2026-11-07 (1)', 'ChatExport_2026-11-07 (2)']);
    expect(parts[2]!.files.map((f) => f.path).sort()).toEqual(['photos/a.jpg', 'result.json']);
  });
});

describe('ZipSink + sourceFromZip', () => {
  it('round-trips bytes and streamed files with UTF-8 names', async () => {
    const out = memoryWritable();
    const sink = new ZipSink(out.writable);
    await sink.addBytes('_chat.txt', enc('[01/06/2026, 09:30:25] A: hi\r\n'));
    await sink.addFile('00000004-‎Șalgau Samuel.vcf', fileFromBytes('contacts/contact_1.vcard', enc('BEGIN:VCARD')));
    const size = await sink.close();
    const zip = out.result();
    expect(size).toBe(zip.byteLength);

    const reader = new ZipReader(new BlobReader(new Blob([arrayBufferView(zip)])));
    const entries = await reader.getEntries();
    expect(entries.map((e) => e.filename)).toEqual(['_chat.txt', '00000004-‎Șalgau Samuel.vcf']);
    // General purpose bit 11: names are flagged UTF-8 so SSZipArchive (Telegram-iOS) won't decode them as CP437.
    expect(entries.every((e) => e.filenameUTF8)).toBe(true);
    await reader.close();

    const src = await sourceFromZip('WhatsApp Chat - A.zip', new Blob([arrayBufferView(zip)]));
    expect(src.name).toBe('WhatsApp Chat - A');
    const vcf = src.files.find((f) => f.path.endsWith('.vcf'))!;
    expect(new TextDecoder().decode(await vcf.bytes())).toBe('BEGIN:VCARD');
  });

  it('refuses duplicate entry names', async () => {
    const sink = new ZipSink(memoryWritable().writable);
    await sink.addBytes('a.txt', enc('1'));
    await expect(sink.addBytes('a.txt', enc('2'))).rejects.toThrow(/Duplicate/);
  });
});

describe('importConversation inputs', () => {
  it('imports a dropped folder (blob entries) the same as the raw file', async () => {
    const file = load('telegram-sample.json');
    const fromFile = await importConversation(file);
    const fromFolder = await importConversation(
      sourceFromBlobs('drop', [{ path: 'ChatExport_2025-03-12/result.json', blob: new Blob([arrayBufferView(file.bytes)]) }]),
    );
    expect(fromFolder.detectedPlatform).toBe('telegram');
    expect(fromFolder.conversation.messages.map((m) => m.id)).toEqual(fromFile.conversation.messages.map((m) => m.id));
  });

  it('imports a zipped WhatsApp export and takes the title from the archive name', async () => {
    const out = memoryWritable();
    const sink = new ZipSink(out.writable);
    await sink.addBytes('_chat.txt', load('whatsapp-sample.txt').bytes);
    await sink.close();
    const { conversation, detectedPlatform } = await importConversation({
      name: 'WhatsApp Chat - Alice.zip',
      bytes: out.result(),
    });
    expect(detectedPlatform).toBe('whatsapp');
    expect(conversation.title).toBe('Alice');
    expect(conversation.messages).toHaveLength(6);
  });

  it('lists every export when several folders are dropped', async () => {
    const tg = load('telegram-sample.json').bytes;
    const src = sourceFromBlobs('drop', [
      { path: 'A/result.json', blob: new Blob([arrayBufferView(tg)]) },
      { path: 'B/result.json', blob: new Blob([arrayBufferView(tg)]) },
    ]);
    expect((await listExports(src)).map((s) => s.name)).toEqual(['A', 'B']);
    const second = await importConversation(src, { exportIndex: 1 });
    expect(second.conversation.messages).toHaveLength(3);
  });
});
