import type { CapabilityMatrix, Conversation, Message, Participant } from '../model';
import { ConversionError, type DetectResult, type Importer, type ImportInput, type ParseContext } from '../engine/contracts';
import { conversationId, messageId, participantId } from '../engine/ids';
import { fullPath, readHeadText, readText, type SourceFile } from '../sources/source';

/*
 * Hinge "Download my data" export (measured on a 2026-05 export: 66 records, 2 matches, 7 messages).
 * export/matches.json is an array with one record per person the account interacted with:
 *   like[{timestamp, like[{timestamp, comment?}]}]  likes the account sent, with the comment typed on them
 *   match[{timestamp}]                              when the two matched
 *   chats[{body, timestamp}]                        the messages the ACCOUNT sent; Hinge exports none of the other
 *                                                   person's messages, nor their name
 * Timestamps are "YYYY-MM-DD HH:MM:SS.ffffff" with no zone; they are read as UTC (server time; Hinge does not
 * state the zone). export/user.json holds profile.first_name / last_name.
 * A record with a match or chats becomes one conversation; likes sent without a match go in one "Likes sent"
 * conversation, one message per like.
 */

interface HingeRecord {
  like?: Array<{ timestamp?: string; like?: Array<{ timestamp?: string; comment?: string }> }>;
  match?: Array<{ timestamp?: string }>;
  chats?: Array<{ body?: string; timestamp?: string }>;
}

const MATCHES = /(?:^|\/)matches\.json$/;
const USER = /(?:^|\/)user\.json$/;

/** "2026-05-12 18:30:12.123456" (UTC) → epoch ms. */
export function hingeTime(s: string | undefined): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(s ?? '');
  if (!m) return 0;
  const ms = Number(((m[7] ?? '') + '000').slice(0, 3));
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms);
}

async function findMatches(input: ImportInput): Promise<SourceFile | undefined> {
  for (const f of input.files) {
    if (!MATCHES.test(fullPath(input.source, f.path))) continue;
    if (/^\s*\[\s*(\{\s*"(like|match|chats)"|\])/.test(await readHeadText(f, 512))) return f;
  }
  return undefined;
}

async function ownerName(input: ImportInput): Promise<string> {
  const file = input.files.find((f) => USER.test(fullPath(input.source, f.path)));
  if (!file) return 'Me';
  try {
    const user = JSON.parse(await readText(file)) as { profile?: { first_name?: string; last_name?: string } };
    const name = [user.profile?.first_name, user.profile?.last_name].filter((x) => x && x.trim()).join(' ').trim();
    return name || 'Me';
  } catch {
    return 'Me';
  }
}

async function readAll(input: ImportInput, ctx: ParseContext): Promise<Conversation[]> {
  const file = await findMatches(input);
  if (!file) throw new ConversionError('No Hinge export/matches.json found', 'NO_CHAT_FILE');
  let records: HingeRecord[];
  try {
    records = JSON.parse(await readText(file)) as HingeRecord[];
  } catch {
    throw new ConversionError(`${file.path} is not valid JSON`, 'BAD_FILE');
  }
  if (!Array.isArray(records)) throw new ConversionError(`${file.path} is not a list`, 'BAD_FILE');

  const me: Participant = { id: participantId('hinge', 'self'), displayName: await ownerName(input) };
  const out: Conversation[] = [];
  const likesOnly: Array<{ ts: number; comment?: string; index: number }> = [];
  let matchNo = 0;

  records.forEach((r, index) => {
    const likes = (r.like ?? []).flatMap((l) => (l.like?.length ? l.like : [{ timestamp: l.timestamp }]));
    if (!r.match?.length && !r.chats?.length) {
      for (const l of likes) likesOnly.push({ ts: hingeTime(l.timestamp), ...('comment' in l && l.comment ? { comment: l.comment } : {}), index });
      return;
    }
    matchNo++;
    const convId = conversationId('hinge', `record-${index}`);
    const them: Participant = { id: participantId('hinge', `match-${index}`), displayName: `Hinge match ${matchNo}`, meta: { nameNotExported: true } };
    const messages: Message[] = [];
    for (const l of likes) {
      const ts = hingeTime(l.timestamp);
      const comment = 'comment' in l ? l.comment : undefined;
      const msg: Message = { id: messageId(convId, 'like', ts), ts, tzOffsetMinutes: 0, senderId: me.id, kind: comment ? 'text' : 'service', ext: { hinge: { like: true } } };
      if (comment) msg.content = { text: comment, entities: [] };
      else msg.service = { action: 'like' };
      messages.push(msg);
    }
    for (const m of r.match ?? []) {
      const ts = hingeTime(m.timestamp);
      messages.push({ id: messageId(convId, 'match', ts), ts, tzOffsetMinutes: 0, kind: 'service', service: { action: 'match' }, content: { text: "It's a match", entities: [] } });
    }
    (r.chats ?? []).forEach((c, i) => {
      const ts = hingeTime(c.timestamp);
      const msg: Message = { id: messageId(convId, 'chat', i, ts), ts, tzOffsetMinutes: 0, senderId: me.id, kind: 'text', raw: c };
      if (c.body) msg.content = { text: c.body, entities: [] };
      else msg.meta = { contentUnavailable: true };
      messages.push(msg);
    });
    messages.sort((a, b) => a.ts - b.ts);
    out.push({
      schemaVersion: 2,
      id: convId,
      kind: 'dm',
      title: them.displayName,
      originPlatform: 'hinge',
      selfId: me.id,
      participants: [me, them],
      messages,
      meta: { exportFormat: 'hinge-json', onlyOwnMessages: true },
      ext: { hinge: { record: index } },
    });
  });

  if (likesOnly.length) {
    const convId = conversationId('hinge', 'likes-sent');
    const messages: Message[] = likesOnly
      .sort((a, b) => a.ts - b.ts)
      .map((l, i) => {
        const msg: Message = { id: messageId(convId, i, l.ts, l.index), ts: l.ts, tzOffsetMinutes: 0, senderId: me.id, kind: l.comment ? 'text' : 'service', ext: { hinge: { like: true, record: l.index } } };
        if (l.comment) msg.content = { text: l.comment, entities: [] };
        else msg.service = { action: 'like' };
        return msg;
      });
    out.push({
      schemaVersion: 2,
      id: convId,
      kind: 'channel',
      title: 'Likes sent',
      originPlatform: 'hinge',
      selfId: me.id,
      participants: [me],
      messages,
      meta: { exportFormat: 'hinge-json', likesOnly: true },
      ext: { hinge: { likesSent: likesOnly.length } },
    });
  }
  if (out.length) ctx.warn("Hinge exports only the messages you sent; the other person's messages and names are not in the export.");
  out.sort((a, b) => (b.messages.at(-1)?.ts ?? 0) - (a.messages.at(-1)?.ts ?? 0));
  return out;
}

const caps: CapabilityMatrix = { timestamps: true };

export const hingeImporter: Importer = {
  platform: 'hinge',
  capabilities: caps,
  async detect(input: ImportInput): Promise<DetectResult> {
    return (await findMatches(input)) ? { platform: 'hinge', confidence: 0.9, reason: 'Hinge export/matches.json' } : { platform: 'hinge', confidence: 0 };
  },
  async parse(input: ImportInput, ctx: ParseContext): Promise<Conversation> {
    const list = await readAll(input, ctx);
    if (!list[0]) throw new ConversionError('The Hinge export holds no conversation', 'EMPTY_EXPORT');
    return list[0];
  },
  parseArchive: readAll,
};
