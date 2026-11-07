import type { CapabilityMatrix, Conversation, Message, Participant } from '../model';
import { ConversionError, type DetectResult, type Importer, type ImportInput, type ParseContext } from '../engine/contracts';
import { conversationId, messageId, participantId } from '../engine/ids';
import { fullPath, readHeadText, readText, type SourceFile } from '../sources/source';

/*
 * VSCO data export (measured on a 2025-11 export: 3 conversations, 27 messages). messages.json is an array of
 * conversations {id, userID (the account owner), creatorUserID, createdAt, participantUserIds,
 * participants[{user_id, name, domain (username), …}], messages[{id, conversationId, fromUserId, createdAt (epoch
 * ms), text, order, localizations[{message}], reference}]}, messages newest first (`order` counts down). A message
 * from VSCO itself repeats its text under localizations; a shared journal has no text and a
 * reference {journal {title, subtitle, permalink}, site {domain}}. The images/ and videos/ folders are the
 * account's own posts, not chat media.
 */

interface VscoParticipant {
  user_id?: number;
  name?: string;
  domain?: string;
}
interface VscoMessage {
  id?: string;
  fromUserId?: number;
  createdAt?: number;
  text?: string;
  order?: number;
  localizations?: Array<{ message?: string }>;
  reference?: { journal?: { title?: string; subtitle?: string; permalink?: string }; site?: { domain?: string } };
}
interface VscoConversation {
  id?: string;
  userID?: number;
  createdAt?: number;
  participants?: VscoParticipant[];
  messages?: VscoMessage[];
}

const MESSAGES = /(?:^|\/)messages\.json$/;
const SHAPE = /"(participantUserIds|conversationId|fromUserId)"\s*:/;

async function findFile(input: ImportInput): Promise<SourceFile | undefined> {
  for (const f of input.files) {
    if (!MESSAGES.test(fullPath(input.source, f.path))) continue;
    if (SHAPE.test(await readHeadText(f, 4096))) return f;
  }
  return undefined;
}

async function readAll(input: ImportInput, ctx: ParseContext): Promise<Conversation[]> {
  const file = await findFile(input);
  if (!file) throw new ConversionError('No VSCO messages.json found', 'NO_CHAT_FILE');
  let data: unknown;
  try {
    data = JSON.parse(await readText(file));
  } catch {
    throw new ConversionError(`${file.path} is not valid JSON`, 'BAD_FILE');
  }
  if (!Array.isArray(data)) throw new ConversionError(`${file.path} is not a list of conversations`, 'BAD_FILE');

  const out: Conversation[] = [];
  for (const c of data as VscoConversation[]) {
    const convId = conversationId('vsco', String(c.id ?? out.length));
    const people = new Map<number, Participant>();
    for (const p of c.participants ?? []) {
      if (typeof p.user_id !== 'number') continue;
      const handle = p.domain?.trim();
      const name = p.name?.trim() || handle || `VSCO user ${p.user_id}`;
      people.set(p.user_id, { id: participantId('vsco', String(p.user_id)), displayName: name, ...(handle ? { handles: [handle] } : {}) });
    }
    const person = (userId: number | undefined): string | undefined => {
      if (typeof userId !== 'number') return undefined;
      if (!people.has(userId)) people.set(userId, { id: participantId('vsco', String(userId)), displayName: `VSCO user ${userId}` });
      return people.get(userId)!.id;
    };
    const list = [...(c.messages ?? [])].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.order ?? 0) - (b.order ?? 0));
    const messages: Message[] = list.map((m, index) => {
      const ts = m.createdAt ?? 0;
      const msg: Message = { id: messageId(convId, m.id ?? index, ts), ts, tzOffsetMinutes: 0, kind: 'text', raw: m };
      const sender = person(m.fromUserId);
      if (sender) msg.senderId = sender;
      const body = m.text ?? m.localizations?.[0]?.message ?? '';
      const journal = m.reference?.journal;
      if (journal) {
        const domain = m.reference?.site?.domain;
        const url = domain && journal.permalink ? `https://vsco.co/${domain}/journal/${journal.permalink}` : undefined;
        const lines = [body, journal.title, journal.subtitle].filter((x): x is string => !!x && !!x.trim());
        let text = lines.join('\n');
        const entities = [];
        if (url) {
          if (text) text += '\n';
          entities.push({ type: 'link' as const, offset: text.length, length: url.length });
          text += url;
        }
        if (text) msg.content = { text, entities };
        msg.ext = { vsco: { journal: { title: journal.title, permalink: journal.permalink, domain, ...(url ? { url } : {}) } } };
      } else if (body) {
        msg.content = { text: body, entities: [] };
      }
      if (!msg.content) msg.meta = { contentUnavailable: true };
      if (m.localizations?.length && !m.text) msg.meta = { ...msg.meta, localizedOnly: true };
      return msg;
    });
    const participants = [...people.values()];
    const self = typeof c.userID === 'number' ? people.get(c.userID) : undefined;
    const others = participants.filter((p) => p !== self);
    const conversation: Conversation = {
      schemaVersion: 2,
      id: convId,
      kind: participants.length > 2 ? 'group' : 'dm',
      title: others.map((p) => p.displayName).join(', ') || 'VSCO conversation',
      originPlatform: 'vsco',
      participants,
      messages,
      meta: { exportFormat: 'vsco-json' },
      ext: { vsco: { conversationId: c.id } },
    };
    if (self) conversation.selfId = self.id;
    out.push(conversation);
  }
  if (!out.length) ctx.warn('The VSCO export holds no conversation.');
  out.sort((a, b) => (b.messages.at(-1)?.ts ?? 0) - (a.messages.at(-1)?.ts ?? 0));
  return out;
}

const caps: CapabilityMatrix = { timestamps: true, groups: true, multipleParticipants: true };

export const vscoImporter: Importer = {
  platform: 'vsco',
  capabilities: caps,
  async detect(input: ImportInput): Promise<DetectResult> {
    const file = await findFile(input);
    return file ? { platform: 'vsco', confidence: 0.9, reason: 'VSCO messages.json' } : { platform: 'vsco', confidence: 0 };
  },
  async parse(input: ImportInput, ctx: ParseContext): Promise<Conversation> {
    const list = await readAll(input, ctx);
    if (!list[0]) throw new ConversionError('The VSCO export holds no conversation', 'EMPTY_EXPORT');
    return list[0];
  },
  parseArchive: readAll,
};
