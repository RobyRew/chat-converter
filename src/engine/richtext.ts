import type { MessageEntity, RichText } from '../model';

export function toPlainText(rt: RichText | undefined): string {
  return rt?.text ?? '';
}

export interface RichSegment {
  text: string;
  types: MessageEntity['type'][];
  url?: string;
  language?: string;
}

/**
 * Splits rich text into non-overlapping segments, each tagged with the entity types active
 * over it. Correctly handles nested/overlapping entities by cutting at every boundary.
 */
export function segmentRichText(rt: RichText): RichSegment[] {
  const text = rt.text;
  const entities = rt.entities ?? [];
  if (entities.length === 0) return text ? [{ text, types: [] }] : [];

  const bounds = new Set<number>([0, text.length]);
  for (const e of entities) {
    bounds.add(Math.max(0, Math.min(text.length, e.offset)));
    bounds.add(Math.max(0, Math.min(text.length, e.offset + e.length)));
  }
  const points = [...bounds].sort((a, b) => a - b);

  const segments: RichSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (end <= start) continue;
    const active = entities.filter((e) => e.offset <= start && e.offset + e.length >= end);
    const seg: RichSegment = { text: text.slice(start, end), types: active.map((e) => e.type) };
    const link = active.find((e) => e.type === 'link');
    if (link?.url) seg.url = link.url;
    const pre = active.find((e) => e.type === 'pre');
    if (pre?.language) seg.language = pre.language;
    segments.push(seg);
  }
  return segments;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderHtml(rt: RichText | undefined): string {
  if (!rt) return '';
  return segmentRichText(rt)
    .map((seg) => {
      let html = escapeHtml(seg.text).replace(/\n/g, '<br>');
      for (const t of seg.types) {
        switch (t) {
          case 'bold': html = `<strong>${html}</strong>`; break;
          case 'italic': html = `<em>${html}</em>`; break;
          case 'underline': html = `<u>${html}</u>`; break;
          case 'strikethrough': html = `<s>${html}</s>`; break;
          case 'code': html = `<code>${html}</code>`; break;
          case 'pre': html = `<pre>${html}</pre>`; break;
          case 'blockquote': html = `<blockquote>${html}</blockquote>`; break;
          case 'spoiler': html = `<span class="spoiler">${html}</span>`; break;
          case 'link': html = `<a href="${escapeHtml(seg.url ?? '#')}" rel="noopener noreferrer">${html}</a>`; break;
          case 'mention': html = `<span class="mention">${html}</span>`; break;
          default: break;
        }
      }
      return html;
    })
    .join('');
}

export function renderMarkdown(rt: RichText | undefined): string {
  if (!rt) return '';
  return segmentRichText(rt)
    .map((seg) => {
      let md = seg.text;
      for (const t of seg.types) {
        switch (t) {
          case 'bold': md = `**${md}**`; break;
          case 'italic': md = `_${md}_`; break;
          case 'strikethrough': md = `~~${md}~~`; break;
          case 'code': md = '`' + md + '`'; break;
          case 'pre': md = '\n```' + (seg.language ?? '') + '\n' + md + '\n```\n'; break;
          case 'spoiler': md = `||${md}||`; break;
          case 'link': md = `[${md}](${seg.url ?? '#'})`; break;
          default: break;
        }
      }
      return md;
    })
    .join('');
}

/**
 * Parse WhatsApp inline markup into canonical entities: `*bold*`, `_italic_`, `~strike~`,
 * and ` ```monospace``` ` (code, literal inner). Handles nesting (e.g. `*_~text~_*`).
 * Word-boundary rules (marker not flanked by letters/digits, no space just inside) keep
 * real text like `2*3=6` or `snake_case` from being mis-formatted.
 */
export function parseWhatsAppMarkup(input: string): RichText {
  const entities: MessageEntity[] = [];
  let out = '';
  const matchers: Array<{ type: MessageEntity['type']; re: RegExp }> = [
    { type: 'code', re: /```(.+?)```/gs },
    { type: 'bold', re: /(?<![\p{L}\p{N}])\*(?=\S)(.+?)(?<=\S)\*(?![\p{L}\p{N}])/gsu },
    { type: 'italic', re: /(?<![\p{L}\p{N}])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}])/gsu },
    { type: 'strikethrough', re: /(?<![\p{L}\p{N}])~(?=\S)(.+?)(?<=\S)~(?![\p{L}\p{N}])/gsu },
  ];

  const walk = (s: string): void => {
    let i = 0;
    while (i < s.length) {
      let best: { type: MessageEntity['type']; index: number; len: number; inner: string } | null = null;
      for (const { type, re } of matchers) {
        re.lastIndex = i;
        const m = re.exec(s);
        if (m && (best === null || m.index < best.index)) {
          best = { type, index: m.index, len: m[0].length, inner: m[1] ?? '' };
        }
      }
      if (!best) {
        out += s.slice(i);
        return;
      }
      out += s.slice(i, best.index);
      const start = out.length;
      if (best.type === 'code') out += best.inner; // monospace is literal
      else walk(best.inner); // recurse for nesting
      entities.push({ type: best.type, offset: start, length: out.length - start });
      i = best.index + best.len;
    }
  };

  walk(input);
  return { text: out, entities };
}

/** Render canonical entities back to WhatsApp markup. Styles WhatsApp can't express stay plain. */
export function renderWhatsApp(rt: RichText | undefined): string {
  if (!rt) return '';
  return segmentRichText(rt)
    .map((seg) => {
      let t = seg.text;
      for (const type of seg.types) {
        switch (type) {
          case 'bold': t = `*${t}*`; break;
          case 'italic': t = `_${t}_`; break;
          case 'strikethrough': t = `~${t}~`; break;
          case 'code':
          case 'pre': t = '```' + t + '```'; break;
          default: break;
        }
      }
      return t;
    })
    .join('');
}
