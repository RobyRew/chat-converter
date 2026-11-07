import type {
  Attachment,
  CapabilityMatrix,
  Conversation,
  Message,
  MessageEntity,
  Participant,
  Reaction,
  RichText,
} from '../model';
import {
  ConversionError,
  type DetectResult,
  type Importer,
  type ImportInput,
  type ParseContext,
} from '../engine/contracts';
import { attachmentId, conversationId, messageId, participantId } from '../engine/ids';
import { readHeadText, readText, type SourceFile } from '../sources/source';

type TgText = string | Array<string | TgPart>;
interface TgPart {
  type: string;
  text: string;
  href?: string;
  language?: string;
}
interface TgEntity {
  type: string;
  text: string;
  href?: string;
}
interface TgReaction {
  type?: string;
  count?: number;
  emoji?: string;
}
interface TgMessage {
  id?: number;
  type?: string;
  date?: string;
  date_unixtime?: string;
  from?: string;
  from_id?: string | number;
  actor?: string;
  actor_id?: string | number;
  text?: TgText;
  text_entities?: TgEntity[];
  reply_to_message_id?: number;
  forwarded_from?: string;
  edited?: string;
  edited_unixtime?: string;
  photo?: string;
  file?: string;
  file_name?: string;
  media_type?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  duration_seconds?: number;
  sticker_emoji?: string;
  poll?: { question?: string; answers?: Array<{ text?: string; voters?: number }>; total_voters?: number; closed?: boolean };
  location_information?: { latitude?: number; longitude?: number };
  place_name?: string;
  address?: string;
  contact_information?: { first_name?: string; last_name?: string; phone_number?: string };
  contact_vcard?: string;
  title?: string;
  members?: string[];
  action?: string;
  reactions?: TgReaction[];
}
interface TgRoot {
  name?: string | null;
  type?: string;
  id?: number;
  messages?: TgMessage[];
}

function mapEntityType(t: string): MessageEntity['type'] | null {
  switch (t) {
    case 'bold': return 'bold';
    case 'italic': return 'italic';
    case 'underline': return 'underline';
    case 'strikethrough': return 'strikethrough';
    case 'spoiler': return 'spoiler';
    case 'code': return 'code';
    case 'pre': return 'pre';
    case 'blockquote': return 'blockquote';
    case 'text_link':
    case 'link': return 'link';
    case 'mention':
    case 'mention_name': return 'mention';
    case 'hashtag': return 'hashtag';
    case 'email': return 'email';
    case 'phone': return 'phone';
    case 'plain': return null;
    default: return 'custom';
  }
}

function buildRichText(text: TgText | undefined, entities?: TgEntity[]): RichText | undefined {
  if (typeof text === 'string') return text ? { text, entities: [] } : undefined;
  if (Array.isArray(text)) {
    let s = '';
    const ents: MessageEntity[] = [];
    for (const part of text) {
      if (typeof part === 'string') {
        s += part;
        continue;
      }
      const off = s.length;
      const ptext = part.text ?? '';
      s += ptext;
      const mapped = mapEntityType(part.type);
      if (mapped) {
        const ent: MessageEntity = { type: mapped, offset: off, length: ptext.length };
        if (part.href) ent.url = part.href;
        if (part.language) ent.language = part.language;
        ents.push(ent);
      }
    }
    return s || ents.length ? { text: s, entities: ents } : undefined;
  }
  if (entities && entities.length) {
    let s = '';
    const ents: MessageEntity[] = [];
    for (const e of entities) {
      const off = s.length;
      const etext = e.text ?? '';
      s += etext;
      const mapped = mapEntityType(e.type);
      if (mapped) {
        const ent: MessageEntity = { type: mapped, offset: off, length: etext.length };
        if (e.href) ent.url = e.href;
        ents.push(ent);
      }
    }
    return s ? { text: s, entities: ents } : undefined;
  }
  return undefined;
}

function tsFromMessage(m: TgMessage): number {
  if (m.date_unixtime) {
    const n = parseInt(m.date_unixtime, 10);
    if (!Number.isNaN(n)) return n * 1000;
  }
  if (m.date) {
    const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(m.date) ? m.date : m.date + 'Z';
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function tgMediaKind(m: TgMessage): Attachment['kind'] {
  if (m.photo) return 'image';
  if (m.media_type === 'sticker' || m.sticker_emoji) return 'sticker';
  switch (m.media_type) {
    case 'video_file':
    case 'video_message': return 'video';
    case 'voice_message': return 'voice';
    case 'audio_file': return 'audio';
    case 'animation': return 'gif';
    default: break;
  }
  if (m.mime_type?.startsWith('image/')) return 'image';
  if (m.mime_type?.startsWith('video/')) return 'video';
  if (m.mime_type?.startsWith('audio/')) return 'audio';
  return 'file';
}

function buildAttachment(m: TgMessage, key: string): Attachment | undefined {
  const ref = m.photo ?? m.file;
  const isSticker = m.media_type === 'sticker' || !!m.sticker_emoji;
  if (!ref && !isSticker) return undefined;
  const att: Attachment = { id: attachmentId(key), kind: tgMediaKind(m) };
  if (ref) {
    att.ref = ref;
    att.fileName = m.file_name ?? ref.split('/').pop();
  }
  if (m.mime_type) att.mimeType = m.mime_type;
  if (typeof m.width === 'number') att.width = m.width;
  if (typeof m.height === 'number') att.height = m.height;
  if (typeof m.duration_seconds === 'number') att.durationSec = m.duration_seconds;
  return att;
}

async function pickJson(files: readonly SourceFile[]): Promise<{ root: TgRoot; name: string } | null> {
  const jsons = files.filter((f) => /\.json$/i.test(f.path));
  // Telegram Desktop names it result.json; try that first, then any other JSON.
  jsons.sort((a, b) => Number(b.path === 'result.json') - Number(a.path === 'result.json'));
  for (const f of jsons) {
    try {
      const data: unknown = JSON.parse(await readText(f));
      if (data && typeof data === 'object' && Array.isArray((data as TgRoot).messages)) {
        return { root: data as TgRoot, name: f.path };
      }
    } catch {
      // not valid JSON — skip
    }
  }
  return null;
}

/** Service messages → readable text, enriched with title/members when present. */
function serviceText(m: TgMessage): RichText {
  let a = (m.action ?? 'service').replace(/_/g, ' ');
  if (m.title) a += `: ${m.title}`;
  else if (Array.isArray(m.members) && m.members.length) a += `: ${m.members.join(', ')}`;
  return { text: a, entities: [] };
}

/** Polls/locations/contacts have no `text`; textualize them so nothing is silently lost. */
function pollText(poll: NonNullable<TgMessage['poll']>): RichText {
  const opts = (poll.answers ?? []).map(
    (a) => `• ${a.text ?? ''}${typeof a.voters === 'number' ? ` (${a.voters})` : ''}`,
  );
  return { text: `📊 ${poll.question ?? 'Poll'}\n${opts.join('\n')}`.trim(), entities: [] };
}

function locationText(m: TgMessage): RichText {
  const parts: string[] = [];
  if (m.place_name) parts.push(m.place_name);
  if (m.address) parts.push(m.address);
  const li = m.location_information;
  if (li && typeof li.latitude === 'number') parts.push(`(${li.latitude}, ${li.longitude})`);
  return { text: `📍 ${parts.join(' — ') || 'Location'}`, entities: [] };
}

function contactText(m: TgMessage): RichText {
  const ci = m.contact_information;
  const name = ci ? [ci.first_name, ci.last_name].filter(Boolean).join(' ') : '';
  const phone = ci?.phone_number;
  return { text: `👤 ${[name, phone].filter(Boolean).join(' · ') || 'Contact'}`, entities: [] };
}

const telegramCaps: CapabilityMatrix = {
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

async function parse(input: ImportInput, _ctx: ParseContext): Promise<Conversation> {
  const found = await pickJson(input.files);
  if (!found) {
    throw new ConversionError('No Telegram export JSON (with a "messages" array) found', 'NO_CHAT_FILE');
  }
  const { root, name } = found;
  const title = root.name ?? undefined;
  const convId = conversationId('telegram', String(root.id ?? name));

  const participants = new Map<string, Participant>();
  const ensure = (displayName?: string, fromId?: string | number): string | undefined => {
    if (displayName == null && fromId == null) return undefined;
    const key = String(fromId ?? displayName);
    const id = participantId('telegram', key);
    if (!participants.has(id)) {
      const p: Participant = { id, displayName: displayName ?? String(fromId) };
      if (fromId != null) p.handles = [String(fromId)];
      participants.set(id, p);
    }
    return id;
  };

  const messages: Message[] = [];
  const list = root.messages ?? [];
  let idx = 0;
  for (const m of list) {
    idx++;
    const tgId = m.id ?? idx;
    const isService = m.type === 'service';
    const msg: Message = {
      id: messageId(convId, tgId),
      ts: tsFromMessage(m),
      kind: isService ? 'service' : 'text',
      raw: m,
    };
    const senderId = isService ? ensure(m.actor, m.actor_id) : ensure(m.from, m.from_id);
    if (senderId) msg.senderId = senderId;

    let content = buildRichText(m.text, m.text_entities);
    if (!content && isService) content = serviceText(m);
    if (content) msg.content = content;

    const att = buildAttachment(m, `${tgId}:${m.photo ?? m.file ?? m.sticker_emoji ?? ''}`);
    if (att) {
      msg.attachments = [att];
      if (msg.kind === 'text') msg.kind = att.kind === 'sticker' ? 'sticker' : 'media';
    }

    if (!msg.content) {
      if (m.poll) {
        msg.kind = 'poll';
        msg.content = pollText(m.poll);
      } else if (m.location_information || m.place_name) {
        msg.kind = 'location';
        msg.content = locationText(m);
      } else if (m.contact_information || m.contact_vcard) {
        msg.kind = 'contact';
        msg.content = contactText(m);
      }
    }

    if (typeof m.reply_to_message_id === 'number') {
      msg.replyToId = messageId(convId, m.reply_to_message_id);
    }
    if (m.forwarded_from) msg.forwardedFrom = { name: m.forwarded_from };
    if (m.edited_unixtime) {
      const e = parseInt(m.edited_unixtime, 10);
      if (!Number.isNaN(e)) msg.editedAt = e * 1000;
    } else if (m.edited) {
      const e = Date.parse(m.edited.endsWith('Z') ? m.edited : m.edited + 'Z');
      if (!Number.isNaN(e)) msg.editedAt = e;
    }
    if (m.reactions?.length) {
      const rs: Reaction[] = m.reactions.map((r) => {
        const reaction: Reaction = { emoji: r.emoji ?? '❤' };
        if (typeof r.count === 'number' && r.count > 0) reaction.count = r.count;
        return reaction;
      });
      msg.reactions = rs;
    }
    messages.push(msg);
  }

  const people = [...participants.values()];
  let kind: Conversation['kind'] = people.length > 2 ? 'group' : 'dm';
  if (root.type && /channel/i.test(root.type)) kind = 'channel';
  else if (root.type && /group/i.test(root.type)) kind = 'group';

  const conversation: Conversation = {
    schemaVersion: 1,
    id: convId,
    kind,
    originPlatform: 'telegram',
    participants: people,
    messages,
  };
  if (title) conversation.title = title;
  return conversation;
}

async function detect(input: ImportInput): Promise<DetectResult> {
  for (const f of input.files) {
    if (!/\.json$/i.test(f.path)) continue;
    const head = await readHeadText(f, 4096);
    if (/"messages"\s*:/.test(head)) {
      if (/("date_unixtime"|"text_entities"|"from_id"|"personal_chat"|"saved_messages")/.test(head)) {
        return { platform: 'telegram', confidence: 0.95, reason: `telegram json: ${f.path}` };
      }
      return { platform: 'telegram', confidence: 0.5, reason: `json with messages: ${f.path}` };
    }
  }
  return { platform: 'telegram', confidence: 0 };
}

export const telegramImporter: Importer = {
  platform: 'telegram',
  capabilities: telegramCaps,
  detect,
  parse,
};
