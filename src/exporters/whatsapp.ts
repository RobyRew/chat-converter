import type { CapabilityMatrix } from '../model';
import type { Exporter } from '../engine/contracts';
import { formatWhatsAppTimestamp, slug } from '../engine/format';
import { renderWhatsApp } from '../engine/richtext';
import { strToU8 } from '../engine/zip';

const caps: CapabilityMatrix = {
  timestamps: true,
  richText: true,
  media: true,
  mediaCaptions: true,
  multipleParticipants: true,
  groups: true,
};

// We render *bold* / _italic_ / ~strike~ / ```mono``` markup so common formatting survives,
// but WhatsApp can't express underline/spoiler/links/mentions — so entities are "approximated".
const approximates: CapabilityMatrix = { entities: true };

const MARK = '‎';

export const whatsappExporter: Exporter = {
  format: 'whatsapp-txt',
  capabilities: caps,
  approximates,
  async serialize(conv, _ctx, opts) {
    const pMap = new Map(conv.participants.map((p) => [p.id, p]));
    const lines: string[] = [];
    for (const m of conv.messages) {
      const stamp = formatWhatsAppTimestamp(m.ts);
      const sender = m.senderId ? pMap.get(m.senderId)?.displayName ?? 'Unknown' : undefined;
      const head = sender ? `${stamp} ${sender}: ` : `${stamp} `;
      const text = renderWhatsApp(m.content);
      const named = (m.attachments ?? []).filter((a) => a.fileName || a.ref);
      const omitted = (m.attachments ?? []).length > 0 && named.length === 0;
      if (text) {
        lines.push(head + text);
        for (const a of named) lines.push(`${MARK}<attached: ${a.fileName ?? a.ref}>`);
      } else if (named.length) {
        lines.push(`${head}${MARK}<attached: ${named[0]!.fileName ?? named[0]!.ref}>`);
        for (let i = 1; i < named.length; i++) {
          lines.push(`${MARK}<attached: ${named[i]!.fileName ?? named[i]!.ref}>`);
        }
      } else if (omitted) {
        lines.push(head + '<Media omitted>');
      } else {
        lines.push(head.trimEnd());
      }
    }
    const title = opts?.title ?? conv.title;
    return {
      files: [{ name: '_chat.txt', bytes: strToU8(lines.join('\n') + '\n') }],
      suggestedName: `${slug(title)}.whatsapp.txt`,
      mime: 'text/plain',
    };
  },
};
