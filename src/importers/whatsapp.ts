import type { Attachment, CapabilityMatrix, Conversation, Message, Participant } from '../model';
import {
  ConversionError,
  type DetectResult,
  type Importer,
  type ImportInput,
  type ParseContext,
} from '../engine/contracts';
import { attachmentId, conversationId, messageId, participantId } from '../engine/ids';
import { parseWhatsAppMarkup } from '../engine/richtext';
import { offsetOf, zonedTimeToUtc, type WallClock } from '../engine/time';
import { baseName, readHeadText, readText, type SourceFile } from '../sources/source';

/** Bidirectional/format marks WhatsApp sprinkles into exports — stripped before parsing. */
const STRIP_MARKS = /[‎‏‪-‮﻿]/g;

const DATE = String.raw`\d{1,4}[./-]\d{1,2}[./-]\d{1,4}`;
const TIME = String.raw`\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap]\.?\s?[Mm]\.?)?`;
// iOS: [12/03/2025, 10:45:30] Sender: text
const RE_IOS = new RegExp(String.raw`^\[(${DATE}),?\s+(${TIME})\]\s?([\s\S]*)$`);
// Android: 12/03/2025, 10:45 - Sender: text
const RE_ANDROID = new RegExp(String.raw`^(${DATE}),?\s+(${TIME})\s+-\s+([\s\S]*)$`);

// Attachment markers (extracted from anywhere in a message; remaining text is the caption).
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
  /** Offset of the written wall clock from `ts`, in minutes. */
  offset: number;
  index: number;
  lines: string[];
  /** WhatsApp system line (group events, timer notices…). */
  system: boolean;
  /** The message body as written, marks included, for a byte-identical WhatsApp re-export. */
  rawLines: string[];
  /** Sender as written (e.g. `‎You`), when it differs from the plain name. */
  rawSender?: string;
  /** The line opened with U+200E (WhatsApp marks lines that carry media). */
  leadMark: boolean;
  /** The date and time exactly as written (`2/7/25, 16:10:42`), for a byte-identical re-export. */
  stamp: string;
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

function toWall(date: string, time: string, order: DateOrder): WallClock | null {
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
  if (Number.isNaN(Date.UTC(y, mo - 1, d, hh, mm, ss))) return null;
  return { year: y, month: mo, day: d, hour: hh, minute: mm, second: ss };
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

function makeAttachment(rawName: string, ctx: ParseContext): Attachment {
  // Names can carry marks of their own (contact cards: `00000004-‎Abi UK….vcf`); look up the exact
  // entry first, then the name without marks.
  const exact = rawName.replace(/^[\s‎‏]+|[\s‎‏]+$/g, '');
  const plain = exact.replace(STRIP_MARKS, '');
  const fileName = ctx.media.has(exact) ? exact : plain;
  const att: Attachment = { id: attachmentId(plain), kind: refineKind(plain, kindFromName(plain)), fileName };
  if (ctx.media.has(fileName)) {
    att.ref = fileName;
    att.present = true;
  }
  return att;
}

function omittedAttachment(kind: Attachment['kind'], n: number): Attachment {
  return {
    id: attachmentId(`omitted:${n}:${kind}`),
    kind,
    present: false,
    omitted: 'not_included',
  };
}

/*
 * WhatsApp writes these markers in the phone's language. English and Spanish are taken from real exports
 * (`<attached: …>` / `<adjunto: …>`, `<This message was edited>` / `<Se editó este mensaje.>`); the other
 * languages are WhatsApp's published strings as best known and are only used when a file uses them.
 */
const ATTACH_TAGS = ['attached', 'adjunto', 'adjunt', 'anexado', 'anexo', 'allegato', 'Anhang', 'pièce jointe', 'bijgevoegd', 'atașat', 'atasat', 'załącznik', 'eklendi'];
const EDITED_MARKERS = [
  'This message was edited',
  'Se editó este mensaje.',
  "S'ha editat aquest missatge.",
  'Acest mesaj a fost editat.',
  'Mensagem editada',
  'Esta mensagem foi editada',
  'Diese Nachricht wurde bearbeitet.',
  'Ce message a été modifié',
  'Questo messaggio è stato modificato',
];
const OMITTED_WORDS: Array<[RegExp, Attachment['kind']]> = [
  [/^(?:image omitted|imagen omitida|imatge omesa|imagine omisă|imagem ocultada|Bild weggelassen|image absente|immagine omessa)$/i, 'image'],
  [/^(?:video omitted|v[ií]deo omitido|v[ií]deo omès|video omis|v[ií]deo ocultado|Video weggelassen|vidéo absente|video omesso)$/i, 'video'],
  [/^(?:audio omitted|audio omitido|àudio omès|audio omis|áudio ocultado|Audio weggelassen|audio omis|audio omesso)$/i, 'audio'],
  [/^(?:sticker omitted|sticker omitido|adhesiu omès|autocolant omis|figurinha omitida|Sticker weggelassen|sticker omis|sticker omesso)$/i, 'sticker'],
  [/^(?:GIF omitted|GIF omitido|GIF omès|GIF omis|GIF ocultado|GIF weggelassen|GIF absent|GIF omesso)$/i, 'gif'],
  [/^(?:document omitted|documento omitido|document omès|document omis|documento ocultado|Dokument weggelassen|document absent|documento omesso)$/i, 'file'],
  [/^(?:Contact card omitted|Tarjeta de contacto omitida|Targeta de contacte omesa|Card de contact omis|Cartão de contato omitido|Kontaktkarte weggelassen|Fiche contact absente|Scheda contatto omessa)$/i, 'contact'],
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const RE_ATTACH_RAW = new RegExp(String.raw`‎?<(${ATTACH_TAGS.map(escapeRe).join('|')})\s*:\s*([^<>\n]+)>`, 'gi');
const RE_ATTACH_ANY = /‎?<([^<>:\n]{2,40}):\s*(\d{8}-[^<>\n]+)>/g;
const RE_OMITTED_TAIL = /(^|\s)‎([^‎\n]{3,40})\s*$/;
const RE_EDITED_TAIL = new RegExp(String.raw`\s*‎?<(?:${EDITED_MARKERS.map(escapeRe).join('|')})>\s*$`);

function omittedKind(phrase: string): Attachment['kind'] | undefined {
  const plain = phrase.replace(STRIP_MARKS, '').trim();
  for (const [re, kind] of OMITTED_WORDS) if (re.test(plain)) return kind;
  return undefined;
}

/** Splits a raw message body (marks kept) into attachments, the caption, and WhatsApp's edit marker. */
function extractAttachments(
  raw: string,
  ctx: ParseContext,
): { attachments: Attachment[]; remaining: string; edited: boolean } {
  const attachments: Attachment[] = [];
  let edited = false;
  let remaining = raw.replace(RE_EDITED_TAIL, () => {
    edited = true;
    return '';
  });
  // Known tags in any language, then any `<word: NNNNNNNN-…>` reference in a language not listed.
  remaining = remaining.replace(RE_ATTACH_RAW, (_m, _tag: string, fn: string) => {
    attachments.push(makeAttachment(fn, ctx));
    return '';
  });
  remaining = remaining.replace(RE_ATTACH_ANY, (m, _tag: string, fn: string) => {
    const att = makeAttachment(fn, ctx);
    if (!att.ref && !/^\d{8}-/.test(att.fileName ?? '')) return m;
    attachments.push(att);
    return '';
  });
  remaining = remaining.replace(RE_ATTACH_ANDROID, (_m, fn: string) => {
    attachments.push(makeAttachment(fn, ctx));
    return '';
  });
  const tail = RE_OMITTED_TAIL.exec(remaining);
  const tailKind = tail ? omittedKind(tail[2] ?? '') : undefined;
  if (tail && tailKind) {
    attachments.push(omittedAttachment(tailKind, attachments.length));
    remaining = remaining.slice(0, tail.index) + (tail[1] ?? '');
  }
  const plain = remaining.replace(STRIP_MARKS, '').trim();
  const wholeKind = omittedKind(plain);
  if (wholeKind || RE_OMITTED_WHOLE.test(plain)) {
    attachments.push(omittedAttachment(wholeKind ?? 'unknown', attachments.length));
    remaining = '';
  }
  return { attachments, remaining: remaining.replace(STRIP_MARKS, ''), edited };
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

function pickChatFile(files: readonly SourceFile[]): SourceFile | undefined {
  const txts = files.filter((f) => f.path.toLowerCase().endsWith('.txt'));
  return txts.find((f) => /(_chat|whatsapp)/i.test(baseName(f.path))) ?? txts[0];
}

/**
 * Chat title from the file name (`WhatsApp Chat with X.txt`, Android) or, for iOS's `_chat.txt`,
 * from the archive/folder name (`WhatsApp Chat - X.zip`).
 */
function chatTitle(path: string, sourceName: string): string | undefined {
  const base = baseName(path);
  const m = /WhatsApp Chat (?:with|-)\s*(.+)\.txt$/i.exec(base);
  if (m) return m[1]!.trim();
  if (/_chat\.txt$/i.test(base)) {
    const z = /^WhatsApp Chat (?:with|-)\s*(.+)$/i.exec(sourceName);
    return z ? z[1]!.trim() : undefined;
  }
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

  // Marks are kept for one check: WhatsApp opens the text of a system line with U+200E
  // (`[t] Group: ‎Eli added you`), which a user message never does.
  const fileText = await readText(chatFile);
  const eol = fileText.includes('\r\n') ? '\r\n' : '\n';
  const rawLines = fileText.replace(/\r\n?/g, '\n').split('\n');
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = rawLines.map((l) => l.replace(STRIP_MARKS, ''));

  const triples: Array<[number, number, number]> = [];
  for (const line of lines) {
    const h = matchHeader(line);
    if (h) {
      const t = splitDate(h.date);
      if (t) triples.push(t);
    }
  }
  const order = detectDateOrder(triples);

  let title = chatTitle(chatFile.path, input.source.name);
  const convId = conversationId('whatsapp', baseName(chatFile.path) || title || 'whatsapp');

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
    const rawBody = p.rawLines.join('\n');
    const { attachments, remaining, edited } = extractAttachments(rawBody, ctx);
    const caption = remaining.trim();
    const msg: Message = {
      id: messageId(convId, p.index, p.ts, p.sender ?? ''),
      ts: p.ts,
      tzOffsetMinutes: p.offset,
      kind: p.sender && !p.system ? 'text' : 'system',
    };
    if (p.sender) msg.senderId = ensureParticipant(p.sender);
    if (attachments.length) {
      msg.attachments = attachments;
      msg.kind = attachments.some((a) => a.kind === 'sticker') ? 'sticker' : 'media';
    }
    const poll = parsePoll(caption);
    if (poll) {
      msg.kind = 'poll';
      msg.poll = poll;
      msg.content = {
        text: `📊 ${poll.question}\n${poll.options.map((o) => `• ${o.text} (${o.votes ?? 0})`).join('\n')}`,
        entities: [],
      };
    } else if (caption) {
      const rt = p.system ? { text: caption, entities: [] } : parseWhatsAppMarkup(caption);
      if (rt.text) msg.content = rt;
    }
    if (edited) {
      // WhatsApp marks edits but does not export when they happened.
      msg.editedAt = p.ts;
      msg.meta = { ...msg.meta, editedTimeUnknown: true };
    }
    msg.meta = {
      ...msg.meta,
      waRaw: rawBody,
      waLead: p.leadMark,
      waContentText: msg.content?.text ?? '',
      waStamp: p.stamp,
      ...(p.rawSender ? { waSender: p.rawSender } : {}),
    };
    return msg;
  };

  const tz = ctx.timeZone;
  let headerStyle: 'ios' | 'android' | undefined;
  const messages: Message[] = [];
  let current: Pending | null = null;
  let index = 0;

  rawLines.forEach((rawLine, i) => {
    const line = lines[i] ?? '';
    const h = matchHeader(line);
    if (h) {
      if (current) messages.push(finalize(current));
      const { sender, text } = splitSender(h.rest);
      // The same split on the raw line keeps the marks of the sender and the body.
      const rawHeader = matchHeader(rawLine.replace(/^[\u200e\u200f]+/, ''));
      const rawSplit = rawHeader ? splitSender(rawHeader.rest) : undefined;
      const wall = toWall(h.date, h.time, order);
      // Without a zone the wall clock is kept as-is (offset 0), so a WhatsApp → WhatsApp round trip
      // reproduces every time exactly; with one, the instant is computed in that zone.
      const ts = wall ? (tz ? zonedTimeToUtc(wall, tz) : Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)) : 0;
      const pending: Pending = {
        ts,
        offset: wall && tz ? offsetOf(wall, ts) : 0,
        index: index++,
        lines: [text],
        system: sender !== undefined && isSystemText(rawLine, sender),
        rawLines: [rawSplit && rawSplit.sender !== undefined === (sender !== undefined) ? rawSplit.text : text],
        leadMark: /^[\u200e\u200f]/.test(rawLine),
        stamp: `${h.date}, ${h.time}`.replace(/^(.*?),\s*,/, '$1,'),
      };
      if (!headerStyle) headerStyle = /^[\u200e\u200f]*\[/.test(rawLine) ? 'ios' : 'android';
      // Keep the exact separator between date and time ("2/7/25, 16:10" vs "2/7/25 16:10").
      const exact = /^[\u200e\u200f]*\[?([^\]]*?)(?:\]|\s+-\s)/.exec(rawLine);
      if (exact?.[1]) pending.stamp = exact[1];
      if (sender) pending.sender = sender;
      if (rawSplit?.sender !== undefined) pending.rawSender = rawSplit.sender;
      current = pending;
    } else if (current) {
      current.lines.push(line);
      current.rawLines.push(rawLine);
    }
  });
  if (current) messages.push(finalize(current));

  // The first line is the end-to-end notice, attributed to the chat title: the group's name, the other
  // person in a private chat, or "You" in a chat with yourself.
  const first = messages[0];
  let groupSignals = messages.some((m) => m.kind === 'system' && GROUP_EVENT.test(m.content?.text ?? ''));
  if (first && (E2E_NOTICE.test(first.content?.text ?? '') || (first.kind === 'system' && E2E_WORDS.test(first.content?.text ?? '')))) {
    first.kind = 'system';
    first.meta = { ...first.meta, e2eNotice: true };
    const noticeSender = first.senderId;
    const person = noticeSender ? participants.get(noticeSender) : undefined;
    if (noticeSender && person) {
      const own = messages.filter((m) => m.senderId === noticeSender);
      if (own.every((m) => m.kind === 'system')) {
        // A chat name, not a person: it becomes the title and its lines stay as unattributed system lines.
        for (const m of own) {
          delete m.senderId;
          m.meta = { ...m.meta, attributedTo: person.displayName };
        }
        participants.delete(noticeSender);
        if (person.displayName !== 'You') {
          title ??= person.displayName;
          if (own.length > 1) groupSignals = true;
        }
      } else {
        title ??= person.displayName;
      }
    }
  }

  const people = [...participants.values()];
  const conversation: Conversation = {
    schemaVersion: 2,
    id: convId,
    kind: people.length > 2 || groupSignals ? 'group' : 'dm',
    originPlatform: 'whatsapp',
    participants: people,
    messages,
    meta: { waHeaderStyle: headerStyle ?? 'ios', waEol: eol },
  };
  if (title) conversation.title = title;
  return conversation;
}

/** Words of the encryption notice in any wording (a chat with yourself says "Messages to yourself are…"). */
const E2E_WORDS = /end-to-end|extremo a extremo|extrem a extrem|criptate integral|ponta a ponta|Ende-zu-Ende|bout en bout/i;

// The first line of every export, in the languages known so far (English and Spanish seen in real files).
const E2E_NOTICE = new RegExp(
  '^(?:' +
    [
      'Messages and calls are end-to-end encrypted',
      'Los mensajes y las llamadas están cifrados de extremo a extremo',
      'Els missatges i les trucades estan xifrats',
      'Mesajele și apelurile sunt criptate',
      'As mensagens e as chamadas são protegidas com a criptografia de ponta a ponta',
      'Nachrichten und Anrufe sind Ende-zu-Ende-verschlüsselt',
      'Les messages et les appels sont chiffrés de bout en bout',
      'I messaggi e le chiamate sono crittografati end-to-end',
    ].join('|') +
    ')',
);
const GROUP_EVENT = /\b(?:created (?:this )?group|created group|added you|changed the group|changed this group|left|joined using|removed)\b/i;

/** `‎POLL:\n<question>\n‎OPTION: <text> (<n> votes)` (marks already stripped). */
function parsePoll(caption: string): NonNullable<Message['poll']> | undefined {
  if (!caption.startsWith('POLL:\n')) return undefined;
  const [, question = '', ...rest] = caption.split('\n');
  const options: NonNullable<Message['poll']>['options'] = [];
  for (const line of rest) {
    const m = /^OPTION: (.*) \((\d+) votes?\)$/.exec(line);
    if (!m) return undefined;
    options.push({ text: m[1] ?? '', votes: Number(m[2]) });
  }
  return options.length ? { question, options } : undefined;
}

/** A header line whose text (after `Name: `) opens with U+200E and is not a media reference. */
function isSystemText(rawLine: string, sender: string): boolean {
  const unmarked = rawLine.replace(/^[‎‏]+/, '');
  const at = unmarked.indexOf(': ', unmarked.indexOf(']') + 1);
  if (at < 0) return false;
  const text = unmarked.slice(at + 2);
  if (!text.startsWith('‎')) return false;
  const plain = text.replace(STRIP_MARKS, '');
  if (/^<attached:|^POLL:|omitted$/i.test(plain)) return false;
  return sender.length > 0;
}

async function detect(input: ImportInput): Promise<DetectResult> {
  const f = pickChatFile(input.files);
  if (!f) return { platform: 'whatsapp', confidence: 0 };
  const sample = (await readHeadText(f, 8192)).replace(STRIP_MARKS, '');
  const lines = sample.split(/\r?\n/).slice(0, 50).filter(Boolean);
  if (lines.length === 0) return { platform: 'whatsapp', confidence: 0 };
  let hits = 0;
  for (const l of lines) if (matchHeader(l)) hits++;
  const ratio = hits / lines.length;
  let confidence = ratio > 0.5 ? 0.92 : ratio > 0.2 ? 0.6 : ratio * 2;
  if (/(_chat|whatsapp)/i.test(baseName(f.path))) confidence = Math.max(confidence, 0.7);
  return { platform: 'whatsapp', confidence, reason: `${hits}/${lines.length} header lines matched` };
}

export const whatsappImporter: Importer = {
  platform: 'whatsapp',
  capabilities: whatsappCaps,
  detect,
  parse,
};
