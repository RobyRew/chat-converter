import type { CapabilityMatrix, Message, Participant } from '../model';
import type { Exporter } from '../engine/contracts';
import { formatHuman, slug, truncate } from '../engine/format';
import { renderMarkdown, toPlainText } from '../engine/richtext';
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
  groups: true,
  multipleParticipants: true,
};

function senderName(m: Message, pMap: Map<string, Participant>): string {
  return m.senderId ? pMap.get(m.senderId)?.displayName ?? 'Unknown' : '—';
}

export const markdownExporter: Exporter = {
  format: 'markdown',
  capabilities: caps,
  async serialize(conv, _ctx, opts) {
    const pMap = new Map(conv.participants.map((p) => [p.id, p]));
    const byId = new Map(conv.messages.map((m) => [m.id, m]));
    const out: string[] = [];
    out.push(`# ${opts?.title ?? conv.title ?? 'Conversation'}`, '');
    if (conv.participants.length) {
      out.push(`*Participants: ${conv.participants.map((p) => p.displayName ?? p.id).join(', ')}*`, '');
    }
    for (const m of conv.messages) {
      out.push(`**${senderName(m, pMap)}** · ${formatHuman(m.ts)}${m.editedAt ? ' *(edited)*' : ''}`);
      if (m.replyToId && byId.has(m.replyToId)) {
        const r = byId.get(m.replyToId)!;
        out.push(`> ↩ replying to ${senderName(r, pMap)}: ${truncate(toPlainText(r.content), 60)}`);
      }
      if (m.forwardedFrom?.name) out.push(`> ⤷ forwarded from ${m.forwardedFrom.name}`);
      const body = renderMarkdown(m.content);
      if (body) out.push('', body);
      for (const a of m.attachments ?? []) {
        out.push('', `📎 *${a.kind}*: \`${a.fileName ?? a.ref ?? 'media'}\``);
      }
      if (m.reactions?.length) {
        out.push('', m.reactions.map((r) => `${r.emoji}${r.count ? ` ${r.count}` : ''}`).join('  '));
      }
      out.push('', '---', '');
    }
    const title = opts?.title ?? conv.title;
    return {
      files: [{ name: 'conversation.md', bytes: strToU8(out.join('\n')) }],
      suggestedName: `${slug(title)}.md`,
      mime: 'text/markdown',
    };
  },
};
