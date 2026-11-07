import { describe, expect, it } from 'vitest';
import { convert } from '../src/index';
import { load, text } from './util';

describe('pipeline', () => {
  it('auto-detects the source platform', async () => {
    const wa = await convert(load('whatsapp-sample.txt'), { target: 'json' });
    expect(wa.detectedPlatform).toBe('whatsapp');
    const tg = await convert(load('telegram-sample.json'), { target: 'json' });
    expect(tg.detectedPlatform).toBe('telegram');
  });

  it('converts whatsapp -> telegram-json with valid output', async () => {
    const r = await convert(load('whatsapp-sample.txt'), { target: 'telegram-json' });
    const root = JSON.parse(text(r.artifact.files[0]!.bytes)) as { messages: unknown[] };
    expect(Array.isArray(root.messages)).toBe(true);
    expect(root.messages).toHaveLength(6);
    expect(r.report.source).toBe('whatsapp');
    expect(r.report.target).toBe('telegram-json');
    expect(r.report.entries.find((e) => e.capability === 'media')?.status).toBe('preserved');
  });

  it('reports fidelity loss for telegram -> whatsapp-txt', async () => {
    const r = await convert(load('telegram-sample.json'), { target: 'whatsapp-txt' });
    const byCap = Object.fromEntries(r.report.entries.map((e) => [e.capability, e.status]));
    expect(byCap.entities).toBe('approximated');
    expect(byCap.replies).toBe('dropped');
    expect(byCap.reactions).toBe('dropped');
  });

  it('produces html, markdown and canonical json', async () => {
    const html = text((await convert(load('whatsapp-sample.txt'), { target: 'html' })).artifact.files[0]!.bytes);
    expect(html).toContain('<title>');
    expect(html).toContain('Hey, how are you?');

    const md = text((await convert(load('telegram-sample.json'), { target: 'markdown' })).artifact.files[0]!.bytes);
    expect(md).toContain('# ');

    const json = text((await convert(load('telegram-sample.json'), { target: 'json' })).artifact.files[0]!.bytes);
    expect((JSON.parse(json) as { originPlatform: string }).originPlatform).toBe('telegram');
  });
});
