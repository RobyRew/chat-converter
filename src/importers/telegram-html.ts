import { isTag, isText, type AnyNode, type Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import type { Attachment, Conversation, Message, MessageEntity, Reaction, RichText } from '../model';
import type { ParseContext } from '../engine/contracts';
import { attachmentId, conversationId, messageId } from '../engine/ids';
import { defaultTimeZone, zonedTimeToUtc, type WallClock } from '../engine/time';
import { baseName, extensionOf, readText, type SourceFile } from '../sources/source';
import {
  callText,
  DELETED_ACCOUNT,
  locate,
  omittedFromPlaceholder,
  parseDurationText,
  Participants,
  stickerFormatOf,
} from './telegram-common';

/*
 * Telegram Desktop's human-readable export: `messages.html`, `messages2.html`, … (1000 messages per page,
 * tdesktop `export_output_html.cpp` kMessagesInFile). Compared with result.json it has no sender ids, no
 * unix times, no edit marks, and its date tooltip carries the export machine's *standard* UTC offset for
 * every message (`28.04.2023 19:24:27 UTC+00:00` for a summer message that was really UTC+1). Times are
 * therefore read as wall-clock and converted with an IANA zone (ParseContext.timeZone, else the
 * converting machine's zone).
 */

// ---------- DOM helpers ----------

function classes(el: Element): string[] {
  return (el.attribs['class'] ?? '').split(/\s+/).filter(Boolean);
}

function hasClass(el: Element, c: string): boolean {
  return classes(el).includes(c);
}

function kids(node: { children: AnyNode[] }): Element[] {
  return node.children.filter(isTag);
}

function child(node: { children: AnyNode[] }, ...cls: string[]): Element | undefined {
  return kids(node).find((e) => cls.every((c) => hasClass(e, c)));
}

function find(node: { children: AnyNode[] }, pred: (e: Element) => boolean): Element | undefined {
  for (const e of kids(node)) {
    if (pred(e)) return e;
    const deep = find(e, pred);
    if (deep) return deep;
  }
  return undefined;
}

/** Text of a node with `<br>` as a line break; nested markup flattened. */
function rawText(node: AnyNode): string {
  if (isText(node)) return node.data;
  if (!isTag(node)) return '';
  if (node.name === 'br') return '\n';
  return node.children.map(rawText).join('');
}

/** Single-line text: whitespace collapsed (titles, statuses, names). */
function lineText(node: AnyNode | undefined): string {
  return node ? rawText(node).replace(/\s+/g, ' ').trim() : '';
}

/** Text of the element's own text nodes only (e.g. a name followed by a nested date span). */
function ownText(el: Element): string {
  return el.children
    .filter(isText)
    .map((t) => t.data)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Block text: the writer puts a newline after the opening tag and newline+indent before the closing one. */
function blockText(el: Element): string {
  return rawText(el).replace(/^\n/, '').replace(/\n[ \t]*$/, '');
}

// ---------- rich text ----------

type EntityShape = { type: MessageEntity['type']; url?: string; meta?: Record<string, unknown> };

function linkEntity(a: Element, inner: string): EntityShape | null {
  const href = a.attribs['href'] ?? '';
  const onclick = a.attribs['onclick'] ?? '';
  if (/ShowMentionName/.test(onclick)) return { type: 'mention' };
  if (/ShowHashtag/.test(onclick)) return { type: 'hashtag' };
  if (/ShowCashtag|ShowBotCommand/.test(onclick)) return { type: 'custom' };
  if (href.startsWith('mailto:')) return { type: 'email' };
  if (href.startsWith('tel:')) return { type: 'phone' };
  if (/^https?:\/\//i.test(href)) {
    const handle = /^https?:\/\/t\.me\/([A-Za-z0-9_]+)$/i.exec(href);
    if (handle && inner === `@${handle[1]}`) return { type: 'mention' };
    return inner === href ? { type: 'link' } : { type: 'link', url: href };
  }
  // A custom emoji links to its sticker file (`stickers/…tgs`); its text is the fallback emoji.
  if (href && !href.startsWith('#')) return { type: 'custom', meta: { telegramType: 'custom_emoji' } };
  return null;
}

function tagEntity(el: Element, inner: string): EntityShape | null {
  switch (el.name) {
    case 'strong':
    case 'b':
      return { type: 'bold' };
    case 'em':
    case 'i':
      return { type: 'italic' };
    case 'u':
      return { type: 'underline' };
    case 's':
    case 'strike':
    case 'del':
      return { type: 'strikethrough' };
    case 'code':
      return { type: 'code' };
    case 'pre':
      return { type: 'pre' };
    case 'blockquote':
      return { type: 'blockquote' };
    case 'a':
      return linkEntity(el, inner);
    case 'span':
      return hasClass(el, 'spoiler') ? { type: 'spoiler' } : null;
    default:
      return null;
  }
}

/** `.text` element → canonical rich text (offsets in UTF-16 units, as everywhere in the model). */
function richText(el: Element): RichText | undefined {
  let text = '';
  const entities: MessageEntity[] = [];
  const walk = (node: AnyNode): void => {
    if (isText(node)) {
      text += node.data;
      return;
    }
    if (!isTag(node)) return;
    if (node.name === 'br') {
      text += '\n';
      return;
    }
    const start = text.length;
    for (const c of node.children) walk(c);
    const ent = tagEntity(node, text.slice(start));
    if (ent && text.length > start) entities.push({ ...ent, offset: start, length: text.length - start });
  };
  for (const c of el.children) walk(c);

  // Drop the writer's formatting newline at the start and newline+indent at the end.
  let lead = 0;
  if (text.startsWith('\n')) lead = 1;
  const trail = /\n[ \t]*$/.exec(text);
  const end = trail ? trail.index : text.length;
  const out = text.slice(lead, Math.max(lead, end));
  if (!out) return undefined;
  const ents = entities
    .map((e) => {
      const s = Math.max(0, e.offset - lead);
      const t = Math.min(out.length, e.offset + e.length - lead);
      return { ...e, offset: s, length: t - s };
    })
    .filter((e) => e.length > 0)
    .sort((a, b) => a.offset - b.offset || b.length - a.length);
  return { text: out, entities: ents };
}

// ---------- dates ----------

const TITLE_DATE = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})(?: UTC([+-]\d{2}):(\d{2}))?/;

function parseTitleDate(title: string | undefined): WallClock | null {
  const m = title ? TITLE_DATE.exec(title.trim()) : null;
  if (!m) return null;
  return {
    day: Number(m[1]),
    month: Number(m[2]),
    year: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
}

/** The offset label of the first dated message (`UTC+00:00` → 0), used to warn about zone mismatches. */
export function htmlOffsetLabelMinutes(title: string): number | undefined {
  const m = TITLE_DATE.exec(title.trim());
  if (!m || !m[7] || !m[8]) return undefined;
  const sign = m[7].startsWith('-') ? -1 : 1;
  return sign * (Math.abs(Number(m[7])) * 60 + Number(m[8]));
}

// ---------- pages ----------

/** `messages.html`, `messages2.html`, … at the export root, in page order. */
export function findHtmlPages(files: readonly SourceFile[]): SourceFile[] {
  const pages = files
    .map((f) => ({ f, m: /^messages(\d*)\.html$/.exec(f.path) }))
    .filter((x): x is { f: SourceFile; m: RegExpExecArray } => x.m !== null);
  pages.sort((a, b) => Number(a.m[1] || 1) - Number(b.m[1] || 1));
  return pages.map((p) => p.f);
}

export function looksLikeTelegramHtml(head: string): boolean {
  return /class="page_wrap"/.test(head) && /class="page_header"|class="history"/.test(head);
}

// ---------- media ----------

function mediaPath(href: string | undefined, ctx: ParseContext): string | undefined {
  if (!href || /^(?:https?:|mailto:|tel:|#)/i.test(href)) return undefined;
  if (ctx.media.has(href)) return href;
  try {
    const decoded = decodeURIComponent(href);
    if (ctx.media.has(decoded)) return decoded;
  } catch {
    // keep the raw href
  }
  return href;
}

/** `03:18, 156.4 MB` / `00:07` → seconds. */
function clockDuration(status: string): number | undefined {
  const m = /(?:^|\s)(?:(\d+):)?(\d{1,2}):(\d{2})(?:,|$)/.exec(status);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function coordinates(href: string | undefined, status: string): { lat: number; lng: number } | null {
  const fromHref = href ? /[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(href) : null;
  const m = fromHref ?? /(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(status);
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}

/** Maps one `.media_wrap` child onto the canonical message. */
function applyMedia(msg: Message, el: Element, tgId: number, ctx: ParseContext): void {
  const href = el.attribs['href'];
  const path = mediaPath(href, ctx);
  const title = lineText(find(el, (e) => hasClass(e, 'title')));
  const status = lineText(find(el, (e) => hasClass(e, 'status')));
  const description = lineText(find(el, (e) => hasClass(e, 'description')));

  const attach = (kind: Attachment['kind']): Attachment => {
    const att: Attachment = { id: attachmentId(`${tgId}:${path ?? title ?? kind}`), kind };
    if (path) {
      locate(att, path, ctx.media);
    } else {
      att.present = false;
      att.omitted = omittedFromPlaceholder(description || status) ?? 'not_included';
    }
    msg.attachments = [...(msg.attachments ?? []), att];
    msg.kind = kind === 'sticker' ? 'sticker' : 'media';
    return att;
  };

  if (hasClass(el, 'photo_wrap')) {
    attach('image');
  } else if (hasClass(el, 'animated_wrap')) {
    attach('gif');
  } else if (hasClass(el, 'sticker_wrap')) {
    const a = attach('sticker');
    const fmt = stickerFormatOf(path);
    if (fmt) a.stickerFormat = fmt;
  } else if (hasClass(el, 'media_photo')) {
    if (/^sticker$/i.test(title)) {
      const a = attach('sticker');
      const fmt = stickerFormatOf(path);
      if (fmt) a.stickerFormat = fmt;
      if (status) a.emoji = status;
    } else {
      const a = attach('image');
      if (/self-destructing/i.test(title)) {
        a.selfDestructSec = 0;
        if (!path) a.omitted = 'unavailable';
      }
    }
  } else if (hasClass(el, 'media_video')) {
    const a = attach(/^animation$/i.test(title) ? 'gif' : 'video');
    if (/video message/i.test(title)) a.round = true;
    const d = clockDuration(status);
    if (d !== undefined) a.durationSec = d;
  } else if (hasClass(el, 'media_voice_message')) {
    const a = attach('voice');
    const d = clockDuration(status);
    if (d !== undefined) a.durationSec = d;
  } else if (hasClass(el, 'media_audio_file')) {
    const a = attach('audio');
    if (title && extensionOf(title)) a.fileName = title;
    const d = clockDuration(status);
    if (d !== undefined) a.durationSec = d;
  } else if (hasClass(el, 'media_file')) {
    const a = attach('file');
    if (title) a.fileName = title;
  } else if (hasClass(el, 'media_call')) {
    msg.kind = 'call';
    const call: NonNullable<Message['call']> = { label: status };
    const d = parseDurationText(status);
    if (d !== undefined) {
      call.durationSec = d;
      call.reason = 'hangup';
    } else if (/missed|cancel/i.test(status)) {
      call.reason = 'missed';
    } else if (/declin|busy/i.test(status)) {
      call.reason = 'busy';
    }
    msg.call = call;
    if (!msg.content) msg.content = { text: callText(call), entities: [] };
  } else if (hasClass(el, 'media_location') || hasClass(el, 'media_live_location') || hasClass(el, 'media_venue')) {
    const c = coordinates(href, status);
    if (c) {
      msg.kind = 'location';
      msg.location = { ...c };
      if (hasClass(el, 'media_live_location')) msg.location.live = true;
      if (title && !/^(?:live )?location$/i.test(title)) msg.location.name = title;
      if (hasClass(el, 'media_venue') && description) msg.location.address = description;
    }
  } else if (hasClass(el, 'media_contact')) {
    msg.kind = 'contact';
    msg.contact = {};
    if (title) msg.contact.firstName = title;
    const phone = status.replace(/\s*-\s*vCard$/i, '').trim();
    if (phone) msg.contact.phone = phone;
    if (path && ctx.media.has(path)) msg.contact.vcardRef = path;
  } else if (hasClass(el, 'media_poll')) {
    const question = (() => {
      const q = find(el, (e) => hasClass(e, 'question'));
      return q ? blockText(q).trim() : '';
    })();
    const details = lineText(kids(el).find((e) => hasClass(e, 'details') && !hasClass(e, 'total')));
    const answers = kids(el).filter((e) => hasClass(e, 'answer'));
    if (/to-?do/i.test(details)) {
      msg.kind = 'checklist';
      msg.checklist = { title: question, items: answers.map((a) => ({ text: ownText(a).replace(/^-\s*/, '') })) };
    } else {
      msg.kind = 'poll';
      const poll: NonNullable<Message['poll']> = {
        question,
        options: answers.map((a) => {
          const info = lineText(child(a, 'details'));
          const o: NonNullable<Message['poll']>['options'][number] = { text: ownText(a).replace(/^-\s*/, '') };
          const votes = /(\d+)\s+vote/i.exec(info);
          if (votes) o.votes = Number(votes[1]);
          else if (/no votes/i.test(info)) o.votes = 0;
          if (/chosen/i.test(info)) o.chosen = true;
          return o;
        }),
      };
      const total = /(\d+)\s+vote/i.exec(lineText(kids(el).find((e) => hasClass(e, 'total'))));
      if (total) poll.totalVoters = Number(total[1]);
      if (/anonymous/i.test(details)) poll.anonymous = true;
      msg.poll = poll;
    }
  } else {
    // Games, invoices, giveaways, stories…: keep what the page shows.
    const summary = [title, description, status].filter(Boolean).join(' — ');
    if (summary && !msg.content) msg.content = { text: summary, entities: [] };
    msg.meta = { ...msg.meta, htmlMediaClass: classes(el).join(' ') };
  }
}

function reactionsOf(el: Element | undefined): Reaction[] | undefined {
  if (!el) return undefined;
  const out: Reaction[] = [];
  for (const r of kids(el).filter((e) => hasClass(e, 'reaction'))) {
    const emoji = lineText(child(r, 'emoji'));
    if (!emoji) continue;
    const countText = lineText(child(r, 'count'));
    const pics = child(r, 'userpics');
    const count = countText ? Number(countText) : pics ? kids(pics).length : 1;
    const reaction: Reaction = { emoji };
    if (count > 0) reaction.count = count;
    out.push(reaction);
  }
  return out.length ? out : undefined;
}

function replyTarget(el: Element | undefined): number | undefined {
  const a = el ? find(el, (e) => e.name === 'a') : undefined;
  const m = /go_to_message(\d+)/.exec(`${a?.attribs['href'] ?? ''} ${a?.attribs['onclick'] ?? ''}`);
  return m ? Number(m[1]) : undefined;
}

/** Service lines name the actor first ("Cosmin Calin pinned …"; a deleted account appears as "Deleted"). */
function serviceAction(text: string): string {
  if (/\bpinned\b/i.test(text)) return 'pin_message';
  if (/took a screenshot/i.test(text)) return 'take_screenshot';
  if (/changed chat theme/i.test(text)) return 'edit_chat_theme';
  if (/\bgift\b/i.test(text)) return 'send_star_gift';
  if (/added tasks?/i.test(text)) return 'todo_append_tasks';
  if (/marked .* as (?:not )?done/i.test(text)) return 'todo_completions';
  return 'html_service';
}

// ---------- parse ----------

export async function parseTelegramHtml(pages: readonly SourceFile[], ctx: ParseContext): Promise<Conversation> {
  const tz = ctx.timeZone ?? defaultTimeZone();
  const people = new Participants();
  const messages: Message[] = [];
  let title: string | undefined;
  let convId = '';
  let prevSender: string | undefined;
  let prevForward: Message['forwardedFrom'] | undefined;
  let offsetLabel: number | undefined;

  const senderFor = (name: string): string | undefined =>
    name === DELETED_ACCOUNT ? people.ensure(null, 'deleted') : people.ensure(name);

  for (const page of pages) {
    const doc = parseDocument(await readText(page));
    if (!convId) {
      const header = find(doc, (e) => hasClass(e, 'page_header'));
      const name = header ? lineText(find(header, (e) => hasClass(e, 'text') && hasClass(e, 'bold'))) : '';
      if (name) title = name;
      convId = conversationId('telegram', `html:${title ?? baseName(page.path)}`);
    }
    const history = find(doc, (e) => hasClass(e, 'history'));
    if (!history) continue;

    for (const el of kids(history)) {
      if (!hasClass(el, 'message')) continue;
      const idm = /^message(-?\d+)$/.exec(el.attribs['id'] ?? '');
      if (!idm) continue;
      const tgId = Number(idm[1]);
      if (tgId <= 0) continue; // date separators

      if (hasClass(el, 'service')) {
        const body = child(el, 'body');
        const text = body ? lineText(body) : '';
        const msg: Message = {
          id: messageId(convId, tgId),
          ts: messages.at(-1)?.ts ?? 0,
          kind: 'service',
          service: { action: serviceAction(text) },
          content: { text, entities: [] },
          meta: { htmlTimeInferred: true },
        };
        // A service line has no timestamp of its own in HTML; it takes the previous message's time.
        const actor = people.list().find((p) => p.displayName && text.startsWith(`${p.displayName} `));
        if (actor) msg.senderId = actor.id;
        else if (/^Deleted\b/.test(text)) msg.senderId = people.ensure(null, 'deleted');
        const target = replyTarget(body);
        if (target !== undefined && msg.service) msg.service.data = { messageId: target };
        messages.push(msg);
        prevSender = undefined;
        continue;
      }

      const body = child(el, 'body');
      if (!body) continue;
      const dateEl = child(body, 'date', 'details');
      const dateTitle = dateEl?.attribs['title'] ?? '';
      const wall = parseTitleDate(dateTitle);
      if (offsetLabel === undefined && dateTitle) offsetLabel = htmlOffsetLabelMinutes(dateTitle);
      const ts = wall ? zonedTimeToUtc(wall, tz) : (messages.at(-1)?.ts ?? 0);
      const msg: Message = { id: messageId(convId, tgId), ts, kind: 'text' };
      if (wall) msg.tzOffsetMinutes = Math.round((Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - ts) / 60000);

      const fromEl = child(body, 'from_name');
      if (fromEl) {
        let name = ownText(fromEl);
        const via = / via (@\S+)$/.exec(name);
        if (via) {
          msg.viaBot = via[1];
          name = name.slice(0, via.index).trim();
        }
        prevSender = senderFor(name);
      } else if (!hasClass(el, 'joined')) {
        prevSender = undefined;
      }
      if (prevSender) msg.senderId = prevSender;

      const reply = replyTarget(child(body, 'reply_to'));
      if (reply !== undefined) msg.replyToId = messageId(convId, reply);

      const fwd = kids(body).find((e) => hasClass(e, 'forwarded') && hasClass(e, 'body'));
      if (fwd) {
        const fname = child(fwd, 'from_name');
        if (fname) {
          prevForward = { name: ownText(fname) };
          const fdate = parseTitleDate(find(fname, (e) => hasClass(e, 'date'))?.attribs['title']);
          if (fdate) prevForward.ts = zonedTimeToUtc(fdate, tz);
        }
        if (prevForward) msg.forwardedFrom = { ...prevForward };
      }
      const root = fwd ?? body;

      const textEl = child(root, 'text');
      const content = textEl ? richText(textEl) : undefined;
      if (content) msg.content = content;

      const wrap = child(root, 'media_wrap');
      const media = wrap ? kids(wrap)[0] : undefined;
      if (media) applyMedia(msg, media, tgId, ctx);

      const reactions = reactionsOf(kids(body).find((e) => hasClass(e, 'reactions')));
      if (reactions) msg.reactions = reactions;
      const signature = child(body, 'signature');
      if (signature) msg.meta = { ...msg.meta, author: lineText(signature) };

      messages.push(msg);
    }
  }

  const participants = people.list();
  const conversation: Conversation = {
    schemaVersion: 2,
    id: convId || conversationId('telegram', 'html'),
    kind: participants.length > 2 ? 'group' : 'dm',
    originPlatform: 'telegram',
    participants,
    messages,
    meta: { exportFormat: 'html', timeZone: tz, ...(offsetLabel !== undefined ? { htmlOffsetLabelMinutes: offsetLabel } : {}) },
  };
  if (title) conversation.title = title;
  return conversation;
}
