import type { Conversation, Message } from '../model';

/** One row of an inbox: what a conversation list shows without loading the conversation itself. */
export interface ConversationSummary {
  /** Position in the archive's `conversations`. */
  index: number;
  id: string;
  title: string;
  kind: Conversation['kind'];
  platform: string;
  messageCount: number;
  participantCount: number;
  /** Display names of everyone but the account owner (up to 8). */
  participants: string[];
  selfId?: string;
  selfName?: string;
  firstTs?: number;
  lastTs?: number;
  /** The newest message with something to show. */
  preview?: { text: string; sender?: string; mine: boolean };
  /** Attachments, those whose file is in the export, and those files' bytes. */
  media: { total: number; present: number; bytes: number };
  /** Folder of the export the conversation came from (inbox, message_requests, archived_threads…). */
  folder?: string;
  /** Notes worth a badge: `requests`, `archived`, `filtered`, `e2ee-cutover`, `snaps`, `likes-only`, `own-messages-only`. */
  flags: string[];
}

export interface ArchiveSummary {
  platform: string;
  variant?: string;
  name?: string;
  conversations: number;
  messages: number;
  firstTs?: number;
  lastTs?: number;
  media: { total: number; present: number; bytes: number };
}

const KIND_LABEL: Record<string, string> = {
  image: 'Photo', video: 'Video', gif: 'GIF', animation: 'GIF', audio: 'Audio', voice: 'Voice message',
  sticker: 'Sticker', file: 'File', contact: 'Contact', location: 'Location',
};

/** One line describing a message, for lists and search results. */
export function previewText(m: Message, max = 140): string {
  const text = m.content?.text?.replace(/\s+/g, ' ').trim();
  if (text) return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  const a = m.attachments?.[0];
  if (a) return `${m.meta?.['snap'] ? 'Snap: ' : ''}${KIND_LABEL[a.kind] ?? 'Attachment'}`;
  if (m.call) return m.call.video ? 'Video call' : 'Call';
  if (m.poll) return `Poll: ${m.poll.question}`;
  if (m.location) return 'Location';
  if (m.contact) return 'Contact';
  if (m.service) return m.service.action.replace(/_/g, ' ');
  if (m.meta?.['contentUnavailable']) return '(not in the export)';
  return '';
}

const FOLDER_FLAGS: Record<string, string> = {
  message_requests: 'requests',
  archived_threads: 'archived',
  filtered_threads: 'filtered',
  e2ee_cutover: 'e2ee-cutover',
};

export function summarizeConversation(c: Conversation, index: number): ConversationSummary {
  const self = c.selfId ? c.participants.find((p) => p.id === c.selfId) : undefined;
  const others = c.participants.filter((p) => p !== self).map((p) => p.displayName ?? p.id);
  let total = 0;
  let present = 0;
  let bytes = 0;
  for (const m of c.messages) for (const a of m.attachments ?? []) {
    total++;
    if (a.present) {
      present++;
      bytes += a.size ?? 0;
    }
  }
  let first: number | undefined;
  let last: number | undefined;
  for (const m of c.messages) {
    if (!m.ts) continue;
    if (first === undefined || m.ts < first) first = m.ts;
    if (last === undefined || m.ts > last) last = m.ts;
  }
  let preview: ConversationSummary['preview'];
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i]!;
    const text = previewText(m, 120);
    if (!text) continue;
    const sender = m.senderId ? c.participants.find((p) => p.id === m.senderId)?.displayName : undefined;
    preview = { text, mine: !!c.selfId && m.senderId === c.selfId, ...(sender ? { sender } : {}) };
    break;
  }
  const folder = typeof c.meta?.['folder'] === 'string' ? c.meta['folder'] : undefined;
  const flags: string[] = [];
  if (folder && FOLDER_FLAGS[folder]) flags.push(FOLDER_FLAGS[folder]!);
  if (typeof c.meta?.['snaps'] === 'number' && c.meta['snaps'] > 0) flags.push('snaps');
  if (c.meta?.['likesOnly']) flags.push('likes-only');
  if (c.meta?.['onlyOwnMessages']) flags.push('own-messages-only');
  const s: ConversationSummary = {
    index,
    id: c.id,
    title: c.title || others.join(', ') || 'Untitled',
    kind: c.kind,
    platform: c.originPlatform ?? 'generic',
    messageCount: c.messages.length,
    participantCount: c.participants.length,
    participants: others.slice(0, 8),
    media: { total, present, bytes },
    flags,
  };
  if (c.selfId) s.selfId = c.selfId;
  if (self?.displayName) s.selfName = self.displayName;
  if (first !== undefined) s.firstTs = first;
  if (last !== undefined) s.lastTs = last;
  if (preview) s.preview = preview;
  if (folder) s.folder = folder;
  return s;
}

export function summarizeArchive(conversations: readonly ConversationSummary[], source?: { platform?: string; variant?: string; name?: string }): ArchiveSummary {
  const out: ArchiveSummary = {
    platform: source?.platform ?? conversations[0]?.platform ?? 'generic',
    conversations: conversations.length,
    messages: conversations.reduce((n, c) => n + c.messageCount, 0),
    media: {
      total: conversations.reduce((n, c) => n + c.media.total, 0),
      present: conversations.reduce((n, c) => n + c.media.present, 0),
      bytes: conversations.reduce((n, c) => n + c.media.bytes, 0),
    },
  };
  if (source?.variant) out.variant = source.variant;
  if (source?.name) out.name = source.name;
  const firsts = conversations.map((c) => c.firstTs).filter((t): t is number => t !== undefined);
  const lasts = conversations.map((c) => c.lastTs).filter((t): t is number => t !== undefined);
  if (firsts.length) out.firstTs = Math.min(...firsts);
  if (lasts.length) out.lastTs = Math.max(...lasts);
  return out;
}

/** Lower-case, accents removed: "Ăla Ñu" and "ala nu" match. */
export function foldForSearch(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export interface SearchHit {
  index: number;
  messageId: string;
  ts: number;
  sender?: string;
  /** The text around the match; `at`/`length` locate the match inside it. */
  snippet: string;
  at: number;
  length: number;
}

/** Finds `query` in the text of every message of every conversation (accent- and case-insensitive). */
export function searchConversations(conversations: readonly Conversation[], query: string, limit = 200): { hits: SearchHit[]; total: number } {
  const q = foldForSearch(query.trim());
  const hits: SearchHit[] = [];
  let total = 0;
  if (q.length < 2) return { hits, total };
  conversations.forEach((c, index) => {
    for (const m of c.messages) {
      const text = m.content?.text;
      if (!text) continue;
      // Folding keeps one output char per input char for Latin text; other scripts fall back to a plain search.
      const folded = foldForSearch(text);
      const at = folded.length === text.length ? folded.indexOf(q) : text.toLowerCase().indexOf(query.trim().toLowerCase());
      if (at < 0) continue;
      total++;
      if (hits.length >= limit) continue;
      const start = Math.max(0, at - 40);
      const end = Math.min(text.length, at + q.length + 60);
      const snippet = `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
      const sender = m.senderId ? c.participants.find((p) => p.id === m.senderId)?.displayName : undefined;
      const lead = (start > 0 ? 1 : 0) + text.slice(start, at).replace(/\s+/g, ' ').length;
      hits.push({ index, messageId: m.id, ts: m.ts, snippet, at: lead, length: q.length, ...(sender ? { sender } : {}) });
    }
  });
  return { hits, total };
}
