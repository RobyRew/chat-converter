import type { Attachment, CapabilityMatrix, Conversation, Message, Participant } from '../model';
import {
  ConversionError,
  type DetectResult,
  type Importer,
  type ImportInput,
  type InputFile,
  type ParseContext,
} from '../engine/contracts';
import { attachmentId, conversationId, messageId, participantId } from '../engine/ids';
import { parseWhatsAppMarkup } from '../engine/richtext';
import { strFromU8 } from '../engine/zip';

/** Bidirectional/format marks WhatsApp sprinkles into exports — stripped before parsing. */
const STRIP_MARKS = /[‎‏‪-‮﻿]/g;

const DATE = String.raw`\d{1,4}[./-]\d{1,2}[./-]\d{1,4}`;
const TIME = String.raw`\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap]\.?\s?[Mm]\.?)?`;
// iOS: [12/03/2025, 10:45:30] Sender: text
const RE_IOS = new RegExp(String.raw`^\[(${DATE}),?\s+(${TIME})\]\s?([\s\S]*)$`);
// Android: 12/03/2025, 10:45 - Sender: text
const RE_ANDROID = new RegExp(String.raw`^(${DATE}),?\s+(${TIME})\s+-\s+([\s\S]*)$`);

// Attachment markers (extracted from anywhere in a message; remaining text is the caption).
const RE_ATTACH_IOS = /<attached:\s*([^>]+)>/gi;
const RE_ATTACH_ANDROID =
  /(\S[^\n]*?\.\w{2,5})\s*\((?:file attached|archivo adjunto|fitxer adjunt|fișier atașat|datei angehängt)\)/gi;
const RE_OMITTED_WHOLE =
  /^(?:<Media omitted>|<Multimedia omitido>|<Multimèdia omès>|<Media omessa>|image omitted|video omitted|audio omitted|GIF omitted|sticker omitted|document omitted|Contact card omitted|imagen omitida|vídeo omitido)$/i;

interface Header {
  date: string;
  time: string;
  rest: string;
}

interface Pending {
  sender?: string;
  ts: number;
  index: number;
  lines: string[];
}

function matchHeader(line: string): Header | null {
  const mi = RE_IOS.exec(line);
  if (mi) return { date: mi[1]!, time: mi[2]!, rest: mi[3] ?? '' };
  const ma = RE_ANDROID.exec(line);
  if (ma) return { date: ma[1]!, time: ma[2]!, rest: ma[3] ?? '' };
  return null;
}

function splitDate(date: string): [number, number, number] | null {
  const parts = date.split(/[./-]/).map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

type DateOrder = 'dmy' | 'mdy' | 'ymd';

/** Decide ambiguous D/M vs M/D order by scanning the whole file for disambiguating values. */
function detectDateOrder(triples: Array<[number, number, number]>): DateOrder {
  let ymd = 0;
  let dmy = 0;
  let mdy = 0;
  for (const [a, b] of triples) {
    if (a > 31) {
      ymd++;
      continue;
    }
    if (a > 12) dmy++;
    else if (b > 12) mdy++;
  }
  if (ymd > triples.length / 2) return 'ymd';
  if (mdy > dmy) return 'mdy';
  return 'dmy'; // most common worldwide; also the safe default
}

function toEpoch(date: string, time: string, order: DateOrder): number | null {
  const t = splitDate(date);
  if (!t) return null;
  let y: number;
  let mo: number;
  let d: number;
  if (order === 'ymd') [y, mo, d] = t;
  else if (order === 'mdy') [mo, d, y] = t;
  else [d, mo, y] = t;
  if (y < 100) y += 2000;

  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap])?\.?\s*[Mm]?\.?/.exec(time.trim());
  if (!tm) return null;
  let hh = parseInt(tm[1]!, 10);
  const mm = parseInt(tm[2]!, 10);
  const ss = tm[3] ? parseInt(tm[3], 10) : 0;
  const ap = tm[4]?.toLowerCase();
  if (ap === 'p' && hh < 12) hh += 12;
  if (ap === 'a' && hh === 12) hh = 0;

  const ms = Date.UTC(y, mo - 1, d, hh, mm, ss);
  return Number.isNaN(ms) ? null : ms;
}

function kindFromName(name: string): Attachment['kind'] {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'webp', 'heic', 'bmp'].includes(ext)) return 'image';
  if (ext === 'gif') return 'gif';
  if (['mp4', 'mov', '3gp', 'mkv', 'avi', 'webm'].includes(ext)) return 'video';
  if (['opus', 'm4a', 'aac'].includes(ext)) return 'voice';
  if (['mp3', 'ogg', 'wav', 'flac'].includes(ext)) return 'audio';
  if (['vcf'].includes(ext)) return 'contact';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'zip', 'rtf'].includes(ext)) return 'file';
  return 'unknown';
}

// WhatsApp uses STICKER in the filename for webp stickers (e.g. 0000-STICKER-...webp).
function refineKind(fileName: string, kind: Attachment['kind']): Attachment['kind'] {
  if (/-STICKER-/i.test(fileName)) return 'sticker';
  if (/-GIF-/i.test(fileName)) return 'gif';
  return kind;
}

function makeAttachment(fileName: string, ctx: ParseContext): Attachment {
  const att: Attachment = { id: attachmentId(fileName), kind: refineKind(fileName, kindFromName(fileName)), fileName };
  if (ctx.media.has(fileName)) att.ref = fileName;
  return att;
}

function extractAttachments(text: string, ctx: ParseContext): { attachments: Attachment[]; remaining: string } {
  const attachments: Attachment[] = [];
  let remaining = text.replace(RE_ATTACH_IOS, (_m, fn: string) => {
    attachments.push(makeAttachment(fn.trim(), ctx));
    return '';
  });
  remaining = remaining.replace(RE_ATTACH_ANDROID, (_m, fn: string) => {
    attachments.push(makeAttachment(fn.trim(), ctx));
    return '';
  });
  if (RE_OMITTED_WHOLE.test(remaining.trim())) {
    attachments.push({ id: attachmentId('omitted' + attachments.length), kind: 'unknown', meta: { omitted: true } });
    remaining = '';
  }
  return { attachments, remaining };
}

function splitSender(rest: string): { sender?: string; text: string } {
  // "Name: text", "Name:" (empty), or a colon-less system line.
  const m = /^([^:\n]{1,80}): ?([\s\S]*)$/.exec(rest);
  if (m) return { sender: m[1], text: m[2] ?? '' };
  return { text: rest };
}

function looksLikePhone(s: string): boolean {
  return /^\+?[\d\s().-]{6,}$/.test(s);
}

function pickChatFile(files: InputFile[]): InputFile | undefined {
  const txts = files.filter((f) => f.name.toLowerCase().endsWith('.txt'));
  return txts.find((f) => /(_chat|whatsapp)/i.test(f.name)) ?? txts[0];
}

function chatTitleFromName(name: string): string | undefined {
  const base = name.split('/').pop() ?? name;
  const m = /WhatsApp Chat (?:with|-)\s*(.+)\.txt$/i.exec(base);
  if (m) return m[1]!.trim();
  if (/_chat\.txt$/i.test(base)) return undefined;
  return base.replace(/\.txt$/i, '') || undefined;
}

const whatsappCaps: CapabilityMatrix = {
  timestamps: true,
  richText: true,
  entities: true,
  media: true,
  mediaCaptions: true,
  stickers: true,
  multipleParticipants: true,
  groups: true,
};

async function parse(input: ImportInput, ctx: ParseContext): Promise<Conversation> {
  const chatFile = pickChatFile(input.files);
  if (!chatFile) throw new ConversionError('No WhatsApp .txt chat file found', 'NO_CHAT_FILE');

  const raw = strFromU8(chatFile.bytes).replace(/\r\n?/g, '\n').replace(STRIP_MARKS, '');
  const lines = raw.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  const triples: Array<[number, number, number]> = [];
  for (const line of lines) {
    const h = matchHeader(line);
    if (h) {
      const t = splitDate(h.date);
      if (t) triples.push(t);
    }
  }
  const order = detectDateOrder(triples);

  const title = chatTitleFromName(chatFile.name);
  const convId = conversationId('whatsapp', chatFile.name || title || 'whatsapp');

  const participants = new Map<string, Participant>();
  const ensureParticipant = (name: string): string => {
    const id = participantId('whatsapp', name);
    if (!participants.has(id)) {
      const p: Participant = { id, displayName: name };
      if (looksLikePhone(name)) p.handles = [name];
      participants.set(id, p);
    }
    return id;
  };

  const finalize = (p: Pending): Message => {
    const { attachments, remaining } = extractAttachments(p.lines.join('\n'), ctx);
    const caption = remaining.trim();
    const msg: Message = {
      id: messageId(convId, p.index, p.ts, p.sender ?? ''),
      ts: p.ts,
      kind: p.sender ? 'text' : 'system',
    };
    if (p.sender) msg.senderId = ensureParticipant(p.sender);
    if (attachments.length) {
      msg.attachments = attachments;
      msg.kind = attachments.some((a) => a.kind === 'sticker') ? 'sticker' : 'media';
    }
    if (caption) {
      const rt = parseWhatsAppMarkup(caption);
      if (rt.text) msg.content = rt;
    }
    return msg;
  };

  const messages: Message[] = [];
  let current: Pending | null = null;
  let index = 0;

  for (const line of lines) {
    const h = matchHeader(line);
    if (h) {
      if (current) messages.push(finalize(current));
      const { sender, text } = splitSender(h.rest);
      const pending: Pending = { ts: toEpoch(h.date, h.time, order) ?? 0, index: index++, lines: [text] };
      if (sender) pending.sender = sender;
      current = pending;
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) messages.push(finalize(current));

  const people = [...participants.values()];
  const conversation: Conversation = {
    schemaVersion: 1,
    id: convId,
    kind: people.length > 2 ? 'group' : 'dm',
    originPlatform: 'whatsapp',
    participants: people,
    messages,
  };
  if (title) conversation.title = title;
  return conversation;
}

function detect(input: ImportInput): DetectResult {
  const f = pickChatFile(input.files);
  if (!f) return { platform: 'whatsapp', confidence: 0 };
  const sample = strFromU8(f.bytes.slice(0, 8192)).replace(STRIP_MARKS, '');
  const lines = sample.split(/\r?\n/).slice(0, 50).filter(Boolean);
  if (lines.length === 0) return { platform: 'whatsapp', confidence: 0 };
  let hits = 0;
  for (const l of lines) if (matchHeader(l)) hits++;
  const ratio = hits / lines.length;
  let confidence = ratio > 0.5 ? 0.92 : ratio > 0.2 ? 0.6 : ratio * 2;
  if (/(_chat|whatsapp)/i.test(f.name)) confidence = Math.max(confidence, 0.7);
  return { platform: 'whatsapp', confidence, reason: `${hits}/${lines.length} header lines matched` };
}

export const whatsappImporter: Importer = {
  platform: 'whatsapp',
  capabilities: whatsappCaps,
  detect,
  parse,
};
