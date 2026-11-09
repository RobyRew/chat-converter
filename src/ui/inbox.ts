import type { ConversationSummary, SearchHit } from '../engine/summary';
import { h } from './dom';
import { formatBytes, formatCount, formatDay, hue } from './format';

/** Filters, sort and search of the conversation list. */
export interface InboxState {
  query: string;
  scope: 'chats' | 'messages';
  sort: 'recent' | 'oldest' | 'messages' | 'name';
  folder: string;
  kind: 'all' | 'dm' | 'group';
  withMedia: boolean;
}

export const INBOX_DEFAULTS: InboxState = { query: '', scope: 'chats', sort: 'recent', folder: 'all', kind: 'all', withMedia: false };

const FOLDER_LABEL: Record<string, string> = {
  inbox: 'Inbox',
  message_requests: 'Requests',
  archived_threads: 'Archived',
  filtered_threads: 'Filtered',
  e2ee_cutover: 'Before end-to-end encryption',
};

const FLAG_LABEL: Record<string, string> = {
  requests: 'request',
  archived: 'archived',
  filtered: 'filtered',
  'e2ee-cutover': 'pre-E2EE',
  snaps: 'snaps',
  'likes-only': 'likes',
  'own-messages-only': 'your side only',
};

const FLAG_HINT: Record<string, string> = {
  'own-messages-only': 'This app exports only the messages you sent.',
  snaps: 'Includes snaps: their media is never in the export.',
  'e2ee-cutover': 'Messages from before the chat moved to end-to-end encryption.',
};

export function folderLabel(folder: string): string {
  return FOLDER_LABEL[folder] ?? folder.replace(/_/g, ' ');
}

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function filterRows(rows: readonly ConversationSummary[], s: InboxState): ConversationSummary[] {
  const q = s.scope === 'chats' ? fold(s.query.trim()) : '';
  const out = rows.filter((r) => {
    if (s.folder !== 'all' && (r.folder ?? '') !== s.folder) return false;
    if (s.kind === 'dm' && r.kind !== 'dm') return false;
    if (s.kind === 'group' && r.kind === 'dm') return false;
    if (s.withMedia && r.media.total === 0) return false;
    if (q && !fold([r.title, ...r.participants].join(' ')).includes(q)) return false;
    return true;
  });
  const by: Record<InboxState['sort'], (a: ConversationSummary, b: ConversationSummary) => number> = {
    recent: (a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0),
    oldest: (a, b) => (a.firstTs ?? 0) - (b.firstTs ?? 0),
    messages: (a, b) => b.messageCount - a.messageCount,
    name: (a, b) => a.title.localeCompare(b.title),
  };
  return out.sort(by[s.sort]);
}

/** Folder → number of conversations, in a stable order (inbox first). */
export function folderCounts(rows: readonly ConversationSummary[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const r of rows) if (r.folder) m.set(r.folder, (m.get(r.folder) ?? 0) + 1);
  const order = Object.keys(FOLDER_LABEL);
  return [...m].sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99));
}

function initials(title: string): string {
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]![0], words[1]![0]] : [...(words[0] ?? '?')].slice(0, 2);
  return letters.join('').toUpperCase() || '?';
}

/** A round monogram in a colour derived from the name. */
export function avatar(title: string, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  return h('span', { class: `cc-avatar cc-avatar--${size}`, style: `--who-hue:${hue(title)}`, 'aria-hidden': 'true' }, initials(title));
}

export interface RowHandlers {
  selected: boolean;
  edited: boolean;
  current: boolean;
  timeZone: string;
  onToggle: (index: number, on: boolean) => void;
  onOpen: (index: number) => void;
}

/** "3.4k" style counts for the narrow meta column. */
function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function renderRow(r: ConversationSummary, o: RowHandlers): HTMLElement {
  const box = h('input', { type: 'checkbox', class: 'cc-check', checked: o.selected, 'aria-label': `Select ${r.title}` });
  box.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('change', () => o.onToggle(r.index, box.checked));
  const preview = r.preview
    ? h('span', { class: 'cc-chatrow__preview' },
        r.preview.mine ? h('span', { class: 'cc-chatrow__who' }, 'You: ') : r.kind !== 'dm' && r.preview.sender ? h('span', { class: 'cc-chatrow__who' }, `${r.preview.sender}: `) : null,
        r.preview.text)
    : h('span', { class: 'cc-chatrow__preview is-empty' }, 'No messages');
  const mediaTitle = `${formatCount(r.media.present)} of ${formatCount(r.media.total)} media files are in the export${r.media.bytes ? ` (${formatBytes(r.media.bytes)})` : ''}`;
  const row = h('div', { class: `cc-chatrow${o.selected ? ' is-selected' : ''}${o.current ? ' is-current' : ''}`, role: 'button', tabindex: 0, 'aria-label': `Open ${r.title}` },
    h('label', { class: 'cc-chatrow__pick', title: 'Select for converting several at once' }, box),
    avatar(r.title),
    h('div', { class: 'cc-chatrow__main' },
      h('div', { class: 'cc-chatrow__top' },
        h('span', { class: 'cc-chatrow__title' }, r.title),
        r.kind !== 'dm' ? h('span', { class: 'cc-badge' }, r.kind === 'group' ? `group · ${r.participantCount}` : r.kind) : null,
        r.flags.map((f) => h('span', { class: 'cc-badge', title: FLAG_HINT[f] ?? '' }, FLAG_LABEL[f] ?? f)),
        o.edited ? h('span', { class: 'cc-badge is-accent' }, 'edited') : null,
        h('span', { class: 'cc-chatrow__date' }, r.lastTs ? formatDay(r.lastTs, o.timeZone) : ''),
      ),
      h('div', { class: 'cc-chatrow__bottom' },
        preview,
        h('span', { class: 'cc-chatrow__meta' },
          h('span', { title: `${formatCount(r.messageCount)} messages` }, `${compact(r.messageCount)} msg`),
          r.media.total ? h('span', { class: r.media.present === r.media.total ? '' : 'is-warn', title: mediaTitle }, ` · ${compact(r.media.present)}/${compact(r.media.total)} media`) : null),
      ),
    ),
  );
  row.addEventListener('click', () => o.onOpen(r.index));
  row.addEventListener('keydown', (e) => {
    if (e.target !== row) return;
    if (e.key === 'Enter') o.onOpen(r.index);
    else if (e.key === ' ') {
      e.preventDefault();
      o.onToggle(r.index, !o.selected);
    }
  });
  return row;
}

export function renderHit(hit: SearchHit, row: ConversationSummary | undefined, timeZone: string, onOpen: (index: number, messageId: string) => void): HTMLElement {
  const before = hit.snippet.slice(0, hit.at);
  const match = hit.snippet.slice(hit.at, hit.at + hit.length);
  const after = hit.snippet.slice(hit.at + hit.length);
  const title = row?.title ?? `#${hit.index + 1}`;
  const el = h('div', { class: 'cc-hit', role: 'button', tabindex: 0, 'aria-label': `Open ${title} at this message` },
    avatar(title, 'sm'),
    h('div', { class: 'cc-hit__main' },
      h('div', { class: 'cc-chatrow__top' },
        h('span', { class: 'cc-chatrow__title' }, title),
        hit.sender ? h('span', { class: 'cc-hit__sender' }, hit.sender) : null,
        h('span', { class: 'cc-chatrow__date' }, hit.ts ? formatDay(hit.ts, timeZone) : ''),
      ),
      h('p', { class: 'cc-hit__text' }, before, h('mark', {}, match), after),
    ),
  );
  const open = (): void => onOpen(hit.index, hit.messageId);
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') open();
  });
  return el;
}
