import { isTag, isText, type AnyNode, type Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import type { Attachment, CapabilityMatrix, Conversation, Message, Participant } from '../model';
import { ConversionError, type DetectResult, type Importer, type ImportInput, type ParseContext } from '../engine/contracts';
import { attachmentId, conversationId, messageId, participantId } from '../engine/ids';
import { baseName, extensionOf, fullPath, readHeadText, readText, type Source, type SourceFile } from '../sources/source';

/*
 * Snapchat "My Data" export (measured on a 2025-04 export: 60 conversations, 3,639 messages, 303 chat media files).
 *
 * json/chat_history.json: { <conversation key>: [{ From, "Media Type", Created: "YYYY-MM-DD HH:MM:SS UTC", Content,
 * "Conversation Title", IsSender, "Created(microseconds)", IsSaved, "Media IDs": "b~… | b~…" }] }, newest first.
 * "Created(microseconds)" holds epoch milliseconds despite its name (13 digits; Created to the second agrees). In a
 * private chat the key is the other person's username and "Conversation Title" is null; a group has a title.
 * Media types: TEXT, MEDIA, STICKER, NOTE (voice note), SHARE, STATUS (no content).
 * chat_media/YYYY-MM-DD_<media id>.<ext> holds the saved media that a message's Media IDs name; files that no
 * message names cannot be placed in a conversation and are reported, not attached.
 * json/snap_history.json lists snaps (same keys, Media Type IMAGE/VIDEO, no content or media).
 * json/friends.json and json/account.json map usernames to display names.
 * html/chat_history/<key>.html mirrors chat_history.json message for message, without Media IDs; it is read when the
 * export has no JSON.
 */

interface SnapRecord {
  From?: string;
  'Media Type'?: string;
  Created?: string;
  Content?: string | null;
  'Conversation Title'?: string | null;
  IsSender?: boolean;
  'Created(microseconds)'?: number;
  IsSaved?: boolean;
  'Media IDs'?: string;
}
type SnapHistory = Record<string, SnapRecord[]>;

const CHAT_JSON = /(?:^|\/)json\/chat_history\.json$/;
const SNAP_JSON = /(?:^|\/)json\/snap_history\.json$/;
const FRIENDS_JSON = /(?:^|\/)json\/friends\.json$/;
const ACCOUNT_JSON = /(?:^|\/)json\/account\.json$/;
const CHAT_HTML = /(?:^|\/)html\/chat_history\/([^/]+)\.html$/;
const CHAT_MEDIA = /(?:^|\/)chat_media\/(\d{4}-\d{2}-\d{2})_([^/]+?)(?:\.[A-Za-z0-9]+)?$/;

interface Files {
  chat?: SourceFile;
  snaps?: SourceFile;
  friends?: SourceFile;
  account?: SourceFile;
  pages: Array<{ key: string; file: SourceFile }>;
  media: Map<string, SourceFile>;
}

function locate(source: Pick<Source, 'root'>, files: readonly SourceFile[]): Files {
  const out: Files = { pages: [], media: new Map() };
  for (const f of files) {
    const p = fullPath(source, f.path);
    if (CHAT_JSON.test(p)) out.chat = f;
    else if (SNAP_JSON.test(p)) out.snaps = f;
    else if (FRIENDS_JSON.test(p)) out.friends = f;
    else if (ACCOUNT_JSON.test(p)) out.account = f;
    else {
      const page = CHAT_HTML.exec(p);
      if (page?.[1]) out.pages.push({ key: decodeURIComponent(page[1]), file: f });
      const media = CHAT_MEDIA.exec(p);
      if (media?.[2]) out.media.set(media[2], f);
    }
  }
  return out;
}

async function readJson<T>(file: SourceFile | undefined, ctx: ParseContext): Promise<T | undefined> {
  if (!file) return undefined;
  try {
    return JSON.parse(await readText(file)) as T;
  } catch {
    ctx.warn(`${file.path} is not valid JSON; skipped`);
    return undefined;
  }
}

/** Epoch ms of a record: "Created(microseconds)" (milliseconds in practice), else the UTC "Created" text. */
export function snapTime(r: SnapRecord): number {
  const v = r['Created(microseconds)'];
  if (typeof v === 'number' && v > 0) return v >= 1e15 ? Math.floor(v / 1000) : v;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(r.Created ?? '');
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : 0;
}

/** Usernames → display names, from friends.json (every list) and account.json; and the owner's username. */
async function directory(files: Files, ctx: ParseContext): Promise<{ names: Map<string, string>; owner?: string }> {
  const names = new Map<string, string>();
  const friends = await readJson<Record<string, unknown>>(files.friends, ctx);
  for (const list of Object.values(friends ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const f of list as Array<Record<string, unknown>>) {
      const user = typeof f['Username'] === 'string' ? f['Username'] : undefined;
      const name = typeof f['Display Name'] === 'string' ? f['Display Name'].trim() : '';
      if (user && name && !names.has(user)) names.set(user, name);
    }
  }
  const account = await readJson<Record<string, Record<string, unknown>>>(files.account, ctx);
  const basic = account?.['Basic Information'];
  const owner = typeof basic?.['Username'] === 'string' ? basic['Username'] : undefined;
  if (owner && typeof basic?.['Name'] === 'string' && basic['Name'].trim()) names.set(owner, basic['Name'].trim());
  return owner ? { names, owner } : { names };
}

// ---------- HTML (export without JSON) ----------

function all(node: { children: AnyNode[] }, pred: (e: Element) => boolean, out: Element[] = []): Element[] {
  for (const c of node.children) {
    if (!isTag(c)) continue;
    if (pred(c)) out.push(c);
    else all(c, pred, out);
  }
  return out;
}
function textOf(node: AnyNode): string {
  if (isText(node)) return node.data;
  if (!isTag(node)) return '';
  if (node.name === 'br') return '\n';
  return node.children.map(textOf).join('');
}
const MEDIA_TYPES = new Set(['TEXT', 'MEDIA', 'STATUS', 'STICKER', 'NOTE', 'SHARE']);

/** One record per message block: `h4` sender, the type label, `p` content, `h6` UTC time, `button.saved`. */
export function parseSnapchatHtml(html: string): SnapRecord[] {
  const doc = parseDocument(html);
  const out: SnapRecord[] = [];
  // A block holds exactly one h4 (sender) and one h6 (time); find the smallest element containing both.
  for (const h6 of all(doc, (e) => e.name === 'h6')) {
    let block: Element | null = h6.parent as Element | null;
    while (block && !all(block, (e) => e.name === 'h4').length) block = block.parent as Element | null;
    if (!block) continue;
    const h4 = all(block, (e) => e.name === 'h4')[0]!;
    const label = all(block, (e) => e.name === 'span' && MEDIA_TYPES.has(textOf(e).trim()))[0];
    const p = all(block, (e) => e.name === 'p')[0];
    const saved = all(block, (e) => e.name === 'button' && /\bsaved\b/.test(e.attribs['class'] ?? ''))[0];
    const r: SnapRecord = { From: textOf(h4).trim(), Created: textOf(h6).trim(), 'Media Type': label ? textOf(label).trim() : 'TEXT' };
    r.Content = p ? textOf(p).trim() : null;
    r.IsSaved = !!saved;
    out.push(r);
  }
  return out;
}

// ---------- conversations ----------

function kindOfFile(file: SourceFile, type: string): Attachment['kind'] {
  if (type === 'NOTE') return 'voice';
  const ext = extensionOf(file.path);
  if (['mp4', 'mov'].includes(ext)) return 'video';
  if (['m4a', 'aac', 'opus', 'mp3'].includes(ext)) return 'voice';
  return 'image';
}

function toMessage(
  r: SnapRecord,
  index: number,
  convId: string,
  person: (username: string) => string,
  files: Files,
  counts: { missing: number; used: Set<string> },
  snap: boolean,
): Message {
  const ts = snapTime(r);
  const type = (r['Media Type'] ?? 'TEXT').toUpperCase();
  const msg: Message = { id: messageId(convId, snap ? 'snap' : 'chat', index, ts, r.From ?? ''), ts, tzOffsetMinutes: 0, kind: 'text', raw: r };
  if (r.From) msg.senderId = person(r.From);
  const text = (r.Content ?? '').trim();
  if (text) msg.content = { text, entities: [] };
  const ext: Record<string, unknown> = { mediaType: type };
  if (typeof r.IsSaved === 'boolean') ext['saved'] = r.IsSaved;
  const meta: Record<string, unknown> = {};

  if (snap) {
    // A snap: its media is never in the export.
    msg.kind = 'media';
    msg.attachments = [{ id: attachmentId(`${msg.id}:snap`), kind: type === 'VIDEO' ? 'video' : 'image', present: false, omitted: 'unavailable' }];
    meta['snap'] = true;
  } else if (type === 'STATUS') {
    msg.kind = 'service';
    msg.service = { action: 'status' };
  } else if (type === 'STICKER') {
    msg.kind = 'sticker';
    msg.attachments = [{ id: attachmentId(`${msg.id}:sticker`), kind: 'sticker', present: false, omitted: 'not_included' }];
  } else if (type === 'MEDIA' || type === 'NOTE') {
    const ids = (r['Media IDs'] ?? '').split('|').map((s) => s.trim()).filter(Boolean);
    msg.kind = 'media';
    msg.attachments = ids.map((id) => {
      const file = files.media.get(id);
      if (!file) {
        counts.missing++;
        return { id: attachmentId(`${msg.id}:${id}`), kind: type === 'NOTE' ? 'voice' : 'image', present: false, omitted: 'missing', meta: { mediaId: id, kindGuessed: type !== 'NOTE' } } satisfies Attachment;
      }
      counts.used.add(id);
      return { id: attachmentId(`${msg.id}:${id}`), kind: kindOfFile(file, type), ref: file.path, fileName: baseName(file.path), size: file.size, present: true, meta: { mediaId: id } } satisfies Attachment;
    });
    if (!msg.attachments.length) {
      // The export names no file (always so in the HTML-only export).
      msg.attachments = [{ id: attachmentId(`${msg.id}:media`), kind: type === 'NOTE' ? 'voice' : 'image', present: false, omitted: 'missing', meta: { kindGuessed: type !== 'NOTE' } }];
      counts.missing++;
    }
  } else if (!text) {
    meta['contentUnavailable'] = true; // SHARE and unknown types carry no content in the export
  }
  msg.ext = { snapchat: ext };
  if (Object.keys(meta).length) msg.meta = meta;
  return msg;
}

async function readAll(input: ImportInput, ctx: ParseContext): Promise<Conversation[]> {
  const files = locate(input.source, input.files);
  const { names, owner: accountOwner } = await directory(files, ctx);

  let history: SnapHistory | undefined = await readJson<SnapHistory>(files.chat, ctx);
  let variant: 'json' | 'html' = 'json';
  if (!history && files.pages.length) {
    variant = 'html';
    history = {};
    for (const page of files.pages) history[page.key] = parseSnapchatHtml(await readText(page.file));
  }
  if (!history) throw new ConversionError('No Snapchat chat history found (json/chat_history.json or html/chat_history/)', 'NO_CHAT_FILE');
  const snaps = (await readJson<SnapHistory>(files.snaps, ctx)) ?? {};

  // The owner: account.json, else the sender of the messages marked IsSender.
  let owner = accountOwner;
  if (!owner) {
    for (const list of Object.values(history)) {
      const mine = list.find((r) => r.IsSender && r.From);
      if (mine) {
        owner = mine.From;
        break;
      }
    }
  }
  if (!owner && variant === 'html') {
    // HTML has no IsSender: in a private chat page every sender but the page's own user is the owner.
    const counts = new Map<string, number>();
    for (const [key, list] of Object.entries(history)) for (const r of list) if (r.From && r.From !== key) counts.set(r.From, (counts.get(r.From) ?? 0) + 1);
    owner = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  }

  const counts = { missing: 0, used: new Set<string>() };
  const conversations: Conversation[] = [];
  const keys = new Set([...Object.keys(history), ...Object.keys(snaps)]);
  for (const key of keys) {
    const chat = Array.isArray(history[key]) ? history[key] : [];
    const snapList = Array.isArray(snaps[key]) ? snaps[key] : [];
    if (!chat.length && !snapList.length) continue;
    const convId = conversationId('snapchat', key);
    const people = new Map<string, Participant>();
    const person = (username: string): string => {
      const id = participantId('snapchat', username);
      if (!people.has(id)) people.set(id, { id, displayName: names.get(username) ?? username, handles: [username] });
      return id;
    };
    // Written newest first: reverse, then a stable sort by time keeps same-time records in written order.
    const ordered = (list: SnapRecord[]): SnapRecord[] =>
      (list.length > 1 && snapTime(list[0]!) > snapTime(list[list.length - 1]!) ? [...list].reverse() : [...list]).sort((a, b) => snapTime(a) - snapTime(b));
    const messages = [
      ...ordered(chat).map((r, i) => toMessage(r, i, convId, person, files, counts, false)),
      ...ordered(snapList).map((r, i) => toMessage(r, i, convId, person, files, counts, true)),
    ].sort((a, b) => a.ts - b.ts);

    const groupTitle = [...chat, ...snapList].find((r) => r['Conversation Title'])?.['Conversation Title'] ?? undefined;
    // A private chat's key is the other person's username, even if they never wrote; the owner is in every chat.
    if (!groupTitle && /^[\w.-]+$/.test(key)) person(key);
    if (owner) person(owner);
    const members = [...people.values()];
    const conversation: Conversation = {
      schemaVersion: 2,
      id: convId,
      kind: groupTitle || members.length > 2 ? 'group' : 'dm',
      title: groupTitle ?? names.get(key) ?? key,
      originPlatform: 'snapchat',
      participants: members,
      messages,
      meta: { exportFormat: variant === 'json' ? 'snapchat-json' : 'snapchat-html', snaps: snapList.length },
      ext: { snapchat: { key } },
    };
    const self = owner ? members.find((p) => p.handles?.[0] === owner) : undefined;
    if (self) conversation.selfId = self.id;
    conversations.push(conversation);
  }

  const unreferenced = [...files.media.keys()].filter((id) => !counts.used.has(id)).length;
  if (unreferenced) ctx.warn(`${unreferenced} file(s) in chat_media/ are not named by any message, so they could not be placed in a conversation and were left out.`);
  if (counts.missing) ctx.warn(`${counts.missing} media item(s) named by messages are not in the export.`);
  conversations.sort((a, b) => (b.messages.at(-1)?.ts ?? 0) - (a.messages.at(-1)?.ts ?? 0));
  return conversations;
}

const caps: CapabilityMatrix = { timestamps: true, media: true, groups: true, multipleParticipants: true };

export const snapchatImporter: Importer = {
  platform: 'snapchat',
  capabilities: caps,
  async detect(input: ImportInput): Promise<DetectResult> {
    const files = locate(input.source, input.files);
    if (files.chat) {
      const head = await readHeadText(files.chat, 2048);
      if (/"Media Type"|"IsSender"|"Created\(microseconds\)"/.test(head) || /^\s*\{\s*\}\s*$/.test(head)) {
        return { platform: 'snapchat', confidence: 0.96, reason: 'Snapchat json/chat_history.json' };
      }
    }
    if (files.pages.length) {
      // The page opens with a long style block; read it whole (pages are small).
      const page = await readText(files.pages[0]!.file);
      if (/Chat History with/i.test(page)) return { platform: 'snapchat', confidence: 0.9, reason: 'Snapchat html/chat_history/' };
    }
    return { platform: 'snapchat', confidence: 0 };
  },
  async parse(input: ImportInput, ctx: ParseContext): Promise<Conversation> {
    const list = await readAll(input, ctx);
    if (!list[0]) throw new ConversionError('The Snapchat export holds no conversation', 'EMPTY_EXPORT');
    return list[0];
  },
  parseArchive: readAll,
};
