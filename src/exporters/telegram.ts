import type { CapabilityMatrix, Message, Participant, RichText } from '../model';
import type { Exporter } from '../engine/contracts';
import { formatTelegramDate, slug } from '../engine/format';
import { numericId } from '../engine/ids';
import { segmentRichText } from '../engine/richtext';
import { strToU8 } from '../engine/zip';

const caps: CapabilityMatrix = {
  timestamps: true,
  messageIds: true,
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

function ourToTg(type: string): string {
  switch (type) {
    case 'bold': return 'bold';
    case 'italic': return 'italic';
    case 'underline': return 'underline';
    case 'strikethrough': return 'strikethrough';
    case 'spoiler': return 'spoiler';
    case 'code': return 'code';
    case 'pre': return 'pre';
    case 'blockquote': return 'blockquote';
    case 'link': return 'text_link';
    case 'mention': return 'mention';
    case 'hashtag': return 'hashtag';
    case 'email': return 'email';
    case 'phone': return 'phone';
    default: return 'plain';
  }
}

type TgPart = string | { type: string; text: string; href?: string };

function buildText(content: RichText | undefined): {
  text: string | TgPart[];
  entities: Array<{ type: string; text: string; href?: string }>;
} {
  if (!content) return { text: '', entities: [] };
  const segs = segmentRichText(content);
  const arr: TgPart[] = [];
  const ents: Array<{ type: string; text: string; href?: string }> = [];
  let hasEntity = false;
  for (const seg of segs) {
    if (seg.types.length === 0) {
      arr.push(seg.text);
      ents.push({ type: 'plain', text: seg.text });
    } else {
      hasEntity = true;
      const part: { type: string; text: string; href?: string } = {
        type: ourToTg(seg.types[0]!),
        text: seg.text,
      };
      if (seg.url) part.href = seg.url;
      arr.push(part);
      ents.push(part);
    }
  }
  return { text: hasEntity ? arr : content.text, entities: ents };
}

function tgMediaType(kind: string): string {
  switch (kind) {
    case 'video': return 'video_file';
    case 'voice': return 'voice_message';
    case 'audio': return 'audio_file';
    case 'gif':
    case 'animation': return 'animation';
    case 'sticker': return 'sticker';
    default: return 'file';
  }
}

function buildMessage(
  m: Message,
  seq: number,
  idMap: Map<string, number>,
  pMap: Map<string, Participant>,
): Record<string, unknown> {
  const isService = m.kind === 'service' || m.kind === 'system';
  const { text, entities } = buildText(m.content);
  const out: Record<string, unknown> = {
    id: seq,
    type: isService ? 'service' : 'message',
    date: formatTelegramDate(m.ts),
    date_unixtime: String(Math.floor(m.ts / 1000)),
  };
  const p = m.senderId ? pMap.get(m.senderId) : undefined;
  if (p) {
    out.from = p.displayName ?? null;
    out.from_id = p.handles?.[0] ?? 'user' + numericId(p.id);
  }
  out.text = text;
  out.text_entities = entities;
  if (m.replyToId && idMap.has(m.replyToId)) out.reply_to_message_id = idMap.get(m.replyToId);
  if (m.forwardedFrom?.name) out.forwarded_from = m.forwardedFrom.name;
  if (m.editedAt) {
    out.edited = formatTelegramDate(m.editedAt);
    out.edited_unixtime = String(Math.floor(m.editedAt / 1000));
  }
  const att = m.attachments?.[0];
  if (att) {
    const fileRef = att.ref ?? att.fileName ?? '(File not included, change data exporting settings to download.)';
    if (att.kind === 'image') {
      out.photo = fileRef;
    } else {
      out.file = fileRef;
      out.media_type = tgMediaType(att.kind);
    }
    if (att.fileName) out.file_name = att.fileName;
    if (att.mimeType) out.mime_type = att.mimeType;
    if (att.width) out.width = att.width;
    if (att.height) out.height = att.height;
    if (att.durationSec) out.duration_seconds = att.durationSec;
  }
  if (m.reactions?.length) {
    out.reactions = m.reactions.map((r) => ({ type: 'emoji', count: r.count ?? 1, emoji: r.emoji }));
  }
  return out;
}

export const telegramExporter: Exporter = {
  format: 'telegram-json',
  capabilities: caps,
  async serialize(conv, _ctx, opts) {
    const idMap = new Map<string, number>();
    conv.messages.forEach((m, i) => idMap.set(m.id, i + 1));
    const pMap = new Map(conv.participants.map((p) => [p.id, p]));
    const messages = conv.messages.map((m, i) => buildMessage(m, i + 1, idMap, pMap));
    const type =
      conv.kind === 'dm' ? 'personal_chat' : conv.kind === 'channel' ? 'public_channel' : 'private_group';
    const root = {
      name: opts?.title ?? conv.title ?? null,
      type,
      id: numericId(conv.id),
      messages,
    };
    const title = opts?.title ?? conv.title;
    return {
      files: [{ name: 'result.json', bytes: strToU8(JSON.stringify(root, null, 2)) }],
      suggestedName: `${slug(title)}.telegram.json`,
      mime: 'application/json',
    };
  },
};
