import type { CapabilityMatrix, Conversation, Message, Participant } from '../model';
import type { Exporter } from '../engine/contracts';
import { formatHuman, slug } from '../engine/format';
import { cyrb53 } from '../engine/ids';
import { escapeHtml, renderHtml, toPlainText } from '../engine/richtext';
import { strToU8 } from '../engine/zip';

const caps: CapabilityMatrix = {
  timestamps: true,
  richText: true,
  entities: true,
  reactions: true,
  replies: true,
  forwards: true,
  edits: true,
  media: true,
  mediaCaptions: true,
  stickers: true,
  groups: true,
  multipleParticipants: true,
};

const STYLE = `
:root { color-scheme: light dark; --bg:#0b141a; --panel:#111b21; --in:#202c33; --out:#005c4b; --text:#e9edef; --muted:#8696a0; }
@media (prefers-color-scheme: light) { :root { --bg:#efeae2; --panel:#fff; --in:#fff; --out:#d9fdd3; --text:#111; --muted:#667781; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
header { position:sticky; top:0; background:var(--panel); padding:14px 18px; border-bottom:1px solid rgba(128,128,128,.2); }
header h1 { margin:0; font-size:18px; }
header .meta { color:var(--muted); font-size:13px; margin-top:2px; }
main { max-width:820px; margin:0 auto; padding:18px; display:flex; flex-direction:column; gap:6px; }
.msg { max-width:75%; padding:6px 10px; border-radius:10px; background:var(--in); align-self:flex-start; box-shadow:0 1px 1px rgba(0,0,0,.15); }
.msg.right { align-self:flex-end; background:var(--out); }
.msg .who { font-weight:600; font-size:13px; color:var(--accent,#53bdeb); }
.msg .body { white-space:pre-wrap; word-wrap:break-word; margin-top:1px; }
.msg .time { float:right; font-size:11px; color:var(--muted); margin:4px 0 0 8px; }
.msg.system { align-self:center; background:transparent; color:var(--muted); font-size:13px; text-align:center; }
.reply, .fwd { border-left:3px solid var(--accent,#53bdeb); padding:2px 8px; margin-bottom:4px; font-size:13px; color:var(--muted); background:rgba(128,128,128,.08); border-radius:4px; }
.att { font-size:13px; color:var(--muted); margin-top:4px; }
.reactions { margin-top:4px; font-size:13px; }
.spoiler { background:var(--muted); border-radius:3px; }
.spoiler:not(:hover) { color:transparent; }
code,pre { background:rgba(128,128,128,.2); border-radius:4px; padding:0 4px; }
a { color:#53bdeb; }
`;

function side(m: Message, rightId: string | null): string {
  if (m.kind === 'system' || m.kind === 'service') return 'system';
  return m.senderId && m.senderId === rightId ? 'right' : 'left';
}

function name(m: Message, pMap: Map<string, Participant>): string {
  return m.senderId ? pMap.get(m.senderId)?.displayName ?? 'Unknown' : '';
}

function bubble(
  m: Message,
  pMap: Map<string, Participant>,
  byId: Map<string, Message>,
  rightId: string | null,
): string {
  const cls = side(m, rightId);
  if (cls === 'system') {
    return `<div class="msg system">${renderHtml(m.content) || escapeHtml(toPlainText(m.content))} <span class="time">${formatHuman(m.ts)}</span></div>`;
  }
  const who = escapeHtml(name(m, pMap));
  const hue = cyrb53(who) % 360;
  const parts: string[] = [];
  if (m.replyToId && byId.has(m.replyToId)) {
    const r = byId.get(m.replyToId)!;
    parts.push(`<div class="reply">↩ ${escapeHtml(name(r, pMap))}: ${escapeHtml(toPlainText(r.content).slice(0, 80))}</div>`);
  }
  if (m.forwardedFrom?.name) parts.push(`<div class="fwd">⤷ forwarded from ${escapeHtml(m.forwardedFrom.name)}</div>`);
  parts.push(`<div class="who">${who}</div>`);
  const body = renderHtml(m.content);
  if (body) parts.push(`<div class="body">${body}</div>`);
  for (const a of m.attachments ?? []) {
    parts.push(`<div class="att">📎 ${escapeHtml(a.kind)}: <em>${escapeHtml(a.fileName ?? a.ref ?? 'media')}</em></div>`);
  }
  if (m.reactions?.length) {
    parts.push(`<div class="reactions">${m.reactions.map((r) => `${escapeHtml(r.emoji)}${r.count ? ' ' + r.count : ''}`).join(' ')}</div>`);
  }
  parts.push(`<span class="time">${formatHuman(m.ts)}${m.editedAt ? ' · edited' : ''}</span>`);
  return `<div class="msg ${cls}" style="--accent:hsl(${hue} 65% 55%)">${parts.join('')}</div>`;
}

export const htmlExporter: Exporter = {
  format: 'html',
  capabilities: caps,
  async serialize(conv: Conversation, _ctx, opts) {
    const pMap = new Map(conv.participants.map((p) => [p.id, p]));
    const byId = new Map(conv.messages.map((m) => [m.id, m]));
    const rightId = conv.kind === 'dm' && conv.participants[1] ? conv.participants[1].id : null;
    const title = opts?.title ?? conv.title ?? 'Conversation';
    const rows = conv.messages.map((m) => bubble(m, pMap, byId, rightId)).join('\n');
    const html =
      `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
      `<title>${escapeHtml(title)}</title>\n<style>${STYLE}</style>\n</head>\n<body>\n` +
      `<header><h1>${escapeHtml(title)}</h1>` +
      `<div class="meta">${conv.messages.length} messages · ${conv.participants.length} participants · exported by ChatForge</div></header>\n` +
      `<main>\n${rows}\n</main>\n</body>\n</html>\n`;
    return {
      files: [{ name: 'conversation.html', bytes: strToU8(html) }],
      suggestedName: `${slug(title)}.html`,
      mime: 'text/html',
    };
  },
};
