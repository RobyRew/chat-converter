import type {
  Attachment,
  CapabilityMatrix,
  Conversation,
  Message,
  MessageEntity,
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
import { attachmentId, conversationId, messageId } from '../engine/ids';
import { offsetOf, parseLocalIso } from '../engine/time';
import { readHeadText, readText, type SourceFile } from '../sources/source';
import {
  callText,
  DELETED_ACCOUNT,
  formatDuration,
  isPlaceholder,
  locate,
  Participants,
  stickerFormatOf,
} from './telegram-common';
import { findHtmlPages, looksLikeTelegramHtml, parseTelegramHtml } from './telegram-html';

/*
 * Telegram Desktop "Export chat history". Reads the machine-readable `result.json` when present (it has
 * unix times, sender ids, edits) and falls back to the HTML pages (`messages.html`, `messages2.html`…).
 * Key list: tdesktop Telegram/SourceFiles/export/output/export_output_json.cpp.
 */

type TgText = string | Array<string | TgPart>;
interface TgPart {
  type: string;
  text: string;
  href?: string;
  language?: string;
  user_id?: number;
  document_id?: string;
}
interface TgEntity {
  type: string;
  text: string;
  href?: string;
  language?: string;
}
interface TgReaction {
  type?: string;
  count?: number;
  emoji?: string;
  document_id?: string;
}
interface TgMessage {
  id?: number;
  type?: string;
  date?: string;
  date_unixtime?: string;
  from?: string | null;
  from_id?: string | number;
  actor?: string | null;
  actor_id?: string | number;
  text?: TgText;
  text_entities?: TgEntity[];
  reply_to_message_id?: number;
  reply_to_peer_id?: string;
  forwarded_from?: string | null;
  forwarded_from_id?: string;
  saved_from?: string;
  via_bot?: string;
  author?: string;
  edited?: string;
  edited_unixtime?: string;
  photo?: string;
  photo_file_size?: number;
  file?: string;
  file_name?: string;
  file_size?: number;
  thumbnail?: string;
  media_type?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  duration_seconds?: number;
  sticker_emoji?: string;
  performer?: string;
  title?: string;
  media_spoiler?: boolean;
  self_destruct_period_seconds?: number;
  poll?: {
    question?: string;
    answers?: Array<{ text?: string; voters?: number; chosen?: boolean }>;
    total_voters?: number;
    closed?: boolean;
  };
  todo_list?: { title?: string; answers?: Array<{ text?: string; id?: number }> };
  location_information?: { latitude?: number; longitude?: number } | null;
  live_location_period_seconds?: number | null;
  place_name?: string;
  address?: string;
  contact_information?: { first_name?: string; last_name?: string; phone_number?: string };
  contact_vcard?: string;
  members?: string[];
  action?: string;
  message_id?: number;
  discard_reason?: string;
  is_video?: boolean;
  emoticon?: string;
  stars?: number;
  gift_text?: string;
  completed?: number[];
  incompleted?: number[];
  items?: Array<{ text?: string; id?: number }>;
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
        if (mapped === 'custom') ent.meta = { telegramType: part.type };
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

/** `date` is the exporting machine's wall clock (with its DST at the time), `date_unixtime` the instant. */
function tzOffsetFromMessage(m: TgMessage, ts: number): number | undefined {
  if (!m.date || !m.date_unixtime) return undefined;
  const wall = parseLocalIso(m.date);
  return wall ? offsetOf(wall, ts) : undefined;
}

function mediaKind(m: TgMessage): Attachment['kind'] {
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
  // No media_type: Telegram sent it as a document ("send as file"), whatever its MIME type.
  return 'file';
}

function buildAttachment(m: TgMessage, key: string, ctx: ParseContext): Attachment | undefined {
  const path = m.photo ?? m.file;
  const isSticker = m.media_type === 'sticker' || !!m.sticker_emoji;
  if (!path && !isSticker) return undefined;
  const att: Attachment = { id: attachmentId(key), kind: mediaKind(m) };
  locate(att, path, ctx.media);
  if (m.file_name) att.fileName = m.file_name;
  else if (path && !isPlaceholder(path)) att.fileName = path.split('/').pop() ?? path;
  if (m.mime_type) att.mimeType = m.mime_type;
  const size = m.photo ? m.photo_file_size : m.file_size;
  if (typeof size === 'number') att.size = size;
  if (typeof m.width === 'number') att.width = m.width;
  if (typeof m.height === 'number') att.height = m.height;
  if (typeof m.duration_seconds === 'number') att.durationSec = m.duration_seconds;
  if (m.thumbnail && !isPlaceholder(m.thumbnail) && ctx.media.has(m.thumbnail)) att.thumbnailRef = m.thumbnail;
  if (isSticker) {
    const fmt = stickerFormatOf(path && !isPlaceholder(path) ? path : undefined, m.mime_type);
    if (fmt) att.stickerFormat = fmt;
    if (m.sticker_emoji) att.emoji = m.sticker_emoji;
  }
  if (m.media_type === 'video_message') att.round = true;
  if (m.media_spoiler) att.spoiler = true;
  if (typeof m.self_destruct_period_seconds === 'number') att.selfDestructSec = m.self_destruct_period_seconds;
  if (m.performer || m.title) att.meta = { ...(m.performer ? { performer: m.performer } : {}), ...(m.title ? { title: m.title } : {}) };
  return att;
}

async function pickJson(
  files: readonly SourceFile[],
): Promise<{ found: { root: TgRoot; name: string } | null; unreadable: string[] }> {
  const jsons = files.filter((f) => /\.json$/i.test(f.path));
  // Telegram Desktop names it result.json; try that first, then any other JSON.
  jsons.sort((a, b) => Number(b.path === 'result.json') - Number(a.path === 'result.json'));
  const unreadable: string[] = [];
  for (const f of jsons) {
    try {
      const data: unknown = JSON.parse(await readText(f));
      if (data && typeof data === 'object' && Array.isArray((data as TgRoot).messages)) {
        return { found: { root: data as TgRoot, name: f.path }, unreadable };
      }
    } catch {
      // A result.json that does not parse is usually an export Telegram Desktop is still writing.
      if (f.path === 'result.json') unreadable.push(f.path);
    }
  }
  return { found: null, unreadable };
}

const quote = (s: string): string => `“${s}”`;

/** Readable text + structured data for a service message (`type: "service"`). */
function serviceMessage(m: TgMessage, todoItems: Map<number, string>): Pick<Message, 'kind' | 'content' | 'call' | 'service'> {
  const action = m.action ?? 'service';
  const text = (s: string): RichText => ({ text: s, entities: [] });
  switch (action) {
    case 'phone_call':
    case 'conference_call': {
      const call: NonNullable<Message['call']> = {};
      if (typeof m.duration_seconds === 'number') call.durationSec = m.duration_seconds;
      if (m.discard_reason) call.reason = m.discard_reason;
      if (m.is_video) call.video = true;
      return { kind: 'call', call, content: text(callText(call)) };
    }
    case 'pin_message':
      return {
        kind: 'service',
        service: { action, data: { messageId: m.message_id } },
        content: text('📌 Pinned a message'),
      };
    case 'take_screenshot':
      return { kind: 'service', service: { action }, content: text('📸 Took a screenshot') };
    case 'edit_chat_theme':
      return {
        kind: 'service',
        service: { action, data: { emoticon: m.emoticon } },
        content: text(m.emoticon ? `🎨 Changed the chat theme to ${m.emoticon}` : '🎨 Changed the chat theme'),
      };
    case 'send_star_gift':
    case 'send_stars_gift':
    case 'send_premium_gift': {
      const stars = typeof m.stars === 'number' ? ` (${m.stars} ⭐)` : '';
      const note = m.gift_text ? `: ${m.gift_text}` : '';
      return { kind: 'service', service: { action, data: { stars: m.stars } }, content: text(`🎁 Sent a gift${stars}${note}`) };
    }
    case 'todo_append_tasks': {
      const items = (m.items ?? []).map((i) => i.text ?? '').filter(Boolean);
      for (const i of m.items ?? []) if (typeof i.id === 'number' && i.text) todoItems.set(i.id, i.text);
      return {
        kind: 'service',
        service: { action, data: { items } },
        content: text(`☑️ Added ${items.length === 1 ? 'a task' : 'tasks'}: ${items.map(quote).join(', ')}`),
      };
    }
    case 'todo_completions': {
      const name = (id: number): string => todoItems.get(id) ?? `#${id}`;
      const done = (m.completed ?? []).map(name);
      const undone = (m.incompleted ?? []).map(name);
      const parts: string[] = [];
      if (done.length) parts.push(`marked done: ${done.map(quote).join(', ')}`);
      if (undone.length) parts.push(`marked not done: ${undone.map(quote).join(', ')}`);
      return {
        kind: 'service',
        service: { action, data: { completed: m.completed ?? [], incompleted: m.incompleted ?? [] } },
        content: text(`☑️ ${parts.join('; ') || 'Updated the checklist'}`),
      };
    }
    default: {
      let a = action.replace(/_/g, ' ');
      if (m.title) a += `: ${m.title}`;
      else if (Array.isArray(m.members) && m.members.length) a += `: ${m.members.join(', ')}`;
      return { kind: 'service', service: { action }, content: text(a) };
    }
  }
}

function pollText(poll: NonNullable<Message['poll']>): RichText {
  const opts = poll.options.map((a) => `• ${a.text}${typeof a.votes === 'number' ? ` (${a.votes})` : ''}`);
  return { text: `📊 ${poll.question}\n${opts.join('\n')}`.trim(), entities: [] };
}

export function locationText(l: NonNullable<Message['location']>): RichText {
  const parts = [l.name, l.address, `(${l.lat}, ${l.lng})`].filter(Boolean);
  return { text: `📍 ${l.live ? 'Live location ' : ''}${parts.join(' — ')}`, entities: [] };
}

export function contactText(c: NonNullable<Message['contact']>): RichText {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
  return { text: `👤 ${[name, c.phone].filter(Boolean).join(' · ') || 'Contact'}`, entities: [] };
}

const telegramCaps: CapabilityMatrix = {
  timestamps: true,
  timezone: true,
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
  polls: true,
  location: true,
  contacts: true,
  calls: true,
  groups: true,
  multipleParticipants: true,
};

/** Parses Telegram Desktop's `result.json`. Exported for HTML↔JSON parity checks. */
export function parseTelegramJson(root: TgRoot, rootName: string, ctx: ParseContext): Conversation {
  const title = root.name ?? undefined;
  const convId = conversationId('telegram', String(root.id ?? rootName));
  const people = new Participants();
  const todoItems = new Map<number, string>();

  const messages: Message[] = [];
  let idx = 0;
  for (const m of root.messages ?? []) {
    idx++;
    const tgId = m.id ?? idx;
    const isService = m.type === 'service';
    const ts = tsFromMessage(m);
    const msg: Message = { id: messageId(convId, tgId), ts, kind: isService ? 'service' : 'text', raw: m };
    const tz = tzOffsetFromMessage(m, ts);
    if (tz !== undefined) msg.tzOffsetMinutes = tz;

    const senderId = isService ? people.ensure(m.actor, m.actor_id) : people.ensure(m.from, m.from_id);
    if (senderId) msg.senderId = senderId;

    const content = buildRichText(m.text, m.text_entities);
    if (content) msg.content = content;

    if (isService) {
      const s = serviceMessage(m, todoItems);
      msg.kind = s.kind;
      if (s.call) msg.call = s.call;
      if (s.service) msg.service = s.service;
      if (!msg.content && s.content) msg.content = s.content;
    } else if (m.type === 'unsupported') {
      msg.kind = 'system';
      msg.content = { text: '(unsupported message)', entities: [] };
    }

    const att = buildAttachment(m, `${tgId}:${m.photo ?? m.file ?? m.sticker_emoji ?? ''}`, ctx);
    if (att) {
      msg.attachments = [att];
      if (msg.kind === 'text') msg.kind = att.kind === 'sticker' ? 'sticker' : 'media';
    }

    if (m.poll) {
      msg.kind = 'poll';
      msg.poll = {
        question: m.poll.question ?? '',
        options: (m.poll.answers ?? []).map((a) => {
          const o: NonNullable<Message['poll']>['options'][number] = { text: a.text ?? '' };
          if (typeof a.voters === 'number') o.votes = a.voters;
          if (a.chosen) o.chosen = true;
          return o;
        }),
      };
      if (typeof m.poll.total_voters === 'number') msg.poll.totalVoters = m.poll.total_voters;
      if (m.poll.closed) msg.poll.closed = true;
      if (!msg.content) msg.content = pollText(msg.poll);
    }
    if (m.todo_list) {
      msg.kind = 'checklist';
      const items = (m.todo_list.answers ?? []).map((a) => {
        if (typeof a.id === 'number' && a.text) todoItems.set(a.id, a.text);
        const item: NonNullable<Message['checklist']>['items'][number] = { text: a.text ?? '' };
        if (typeof a.id === 'number') item.id = a.id;
        return item;
      });
      msg.checklist = { title: m.todo_list.title ?? '', items };
      if (!msg.content) {
        msg.content = { text: `☑️ ${msg.checklist.title}\n${items.map((i) => `• ${i.text}`).join('\n')}`, entities: [] };
      }
    }
    const li = m.location_information;
    if (li && typeof li.latitude === 'number' && typeof li.longitude === 'number') {
      msg.kind = msg.kind === 'text' ? 'location' : msg.kind;
      msg.location = { lat: li.latitude, lng: li.longitude };
      if (m.place_name) msg.location.name = m.place_name;
      if (m.address) msg.location.address = m.address;
      if ('live_location_period_seconds' in m) {
        msg.location.live = true;
        if (typeof m.live_location_period_seconds === 'number') msg.location.livePeriodSec = m.live_location_period_seconds;
      }
      if (!msg.content) msg.content = locationText(msg.location);
    }
    if (m.contact_information) {
      msg.kind = msg.kind === 'text' ? 'contact' : msg.kind;
      const ci = m.contact_information;
      msg.contact = {};
      if (ci.first_name) msg.contact.firstName = ci.first_name;
      if (ci.last_name) msg.contact.lastName = ci.last_name;
      if (ci.phone_number) msg.contact.phone = ci.phone_number;
      if (m.contact_vcard && !isPlaceholder(m.contact_vcard) && ctx.media.has(m.contact_vcard)) {
        msg.contact.vcardRef = m.contact_vcard;
      }
      if (!msg.content) msg.content = contactText(msg.contact);
    }

    if (typeof m.reply_to_message_id === 'number') {
      if (m.reply_to_peer_id) msg.meta = { ...msg.meta, replyToPeer: m.reply_to_peer_id };
      else msg.replyToId = messageId(convId, m.reply_to_message_id);
    }
    if (m.forwarded_from !== undefined || m.forwarded_from_id) {
      msg.forwardedFrom = { name: m.forwarded_from ?? DELETED_ACCOUNT };
      if (m.forwarded_from_id) msg.forwardedFrom.handle = m.forwarded_from_id;
    }
    if (m.via_bot) msg.viaBot = m.via_bot;
    if (m.saved_from || m.author) {
      msg.meta = { ...msg.meta, ...(m.saved_from ? { savedFrom: m.saved_from } : {}), ...(m.author ? { author: m.author } : {}) };
    }
    if (m.edited_unixtime) {
      const e = parseInt(m.edited_unixtime, 10);
      if (!Number.isNaN(e)) msg.editedAt = e * 1000;
    } else if (m.edited) {
      const e = Date.parse(m.edited.endsWith('Z') ? m.edited : m.edited + 'Z');
      if (!Number.isNaN(e)) msg.editedAt = e;
    }
    if (m.reactions?.length) {
      msg.reactions = m.reactions.map((r) => {
        const emoji = r.emoji ?? (r.type === 'paid' ? '⭐' : r.type === 'custom_emoji' ? '🔹' : '❤');
        const reaction: Reaction = { emoji };
        if (typeof r.count === 'number' && r.count > 0) reaction.count = r.count;
        return reaction;
      });
    }
    messages.push(msg);
  }

  const participants = people.list();
  let kind: Conversation['kind'] = participants.length > 2 ? 'group' : 'dm';
  if (root.type && /channel/i.test(root.type)) kind = 'channel';
  else if (root.type && /group/i.test(root.type)) kind = 'group';

  const conversation: Conversation = {
    schemaVersion: 2,
    id: convId,
    kind,
    originPlatform: 'telegram',
    participants,
    messages,
    meta: { telegramType: root.type, exportFormat: 'json' },
  };
  if (title) conversation.title = title;
  else if (kind === 'dm') {
    // A DM with a deleted account has `name: null`; Telegram shows "Deleted Account".
    const deleted = participants.find((p) => p.meta?.deletedAccount);
    if (deleted?.displayName) conversation.title = deleted.displayName;
  }
  return conversation;
}

async function parse(input: ImportInput, ctx: ParseContext): Promise<Conversation> {
  const { found, unreadable } = await pickJson(input.files);
  if (found) return parseTelegramJson(found.root, found.name, ctx);
  const pages = findHtmlPages(input.files);
  if (unreadable.length) {
    const note = 'result.json could not be read (is Telegram Desktop still exporting?)';
    if (!pages.length) throw new ConversionError(note, 'INCOMPLETE_EXPORT');
    ctx.warn(`${note}; the HTML pages were used instead.`);
  }
  if (pages.length) return parseTelegramHtml(pages, ctx);
  throw new ConversionError('No Telegram export found (result.json or messages.html)', 'NO_CHAT_FILE');
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
  const pages = findHtmlPages(input.files);
  const first = pages[0];
  if (first && looksLikeTelegramHtml(await readHeadText(first, 4096))) {
    return { platform: 'telegram', confidence: 0.9, reason: `telegram html: ${pages.length} page(s)` };
  }
  return { platform: 'telegram', confidence: 0 };
}

export const telegramImporter: Importer = {
  platform: 'telegram',
  capabilities: telegramCaps,
  detect,
  parse,
};

export { formatDuration };
