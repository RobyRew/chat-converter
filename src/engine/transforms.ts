import type { Conversation } from '../model';

/**
 * User edits applied to a conversation before export. A patch (not a mutated copy) so the UI
 * keeps the pristine import and every edit is reversible. Pure + isomorphic — reusable by
 * web, the server sandbox, and future native apps.
 */
export interface Edits {
  title?: string;
  kind?: Conversation['kind'];
  /** participantId → new display name (blank/whitespace is ignored). */
  renames?: Record<string, string>;
  /** Keep only messages with `ts >= dateFrom` (epoch ms, inclusive). */
  dateFrom?: number;
  /** Keep only messages with `ts <= dateTo` (epoch ms, inclusive). */
  dateTo?: number;
  /** Message ids to drop. */
  removedIds?: string[];
}

export function applyEdits(conv: Conversation, edits: Edits): Conversation {
  const removed = new Set(edits.removedIds ?? []);
  const renames = edits.renames ?? {};
  const { dateFrom, dateTo } = edits;

  const participants = conv.participants.map((p) => {
    const name = renames[p.id];
    return name && name.trim() ? { ...p, displayName: name } : p;
  });

  const messages = conv.messages.filter((m) => {
    if (removed.has(m.id)) return false;
    if (dateFrom !== undefined && m.ts < dateFrom) return false;
    if (dateTo !== undefined && m.ts > dateTo) return false;
    return true;
  });

  const next: Conversation = { ...conv, participants, messages };
  if (edits.title !== undefined) next.title = edits.title;
  if (edits.kind !== undefined) next.kind = edits.kind;
  return next;
}

/** Per-participant message counts — for showing "(123 messages)" next to each rename row. */
export function participantMessageCounts(conv: Conversation): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of conv.messages) {
    if (m.senderId) counts[m.senderId] = (counts[m.senderId] ?? 0) + 1;
  }
  return counts;
}

/** Min/max message timestamps — for the date-range inputs. */
export function dateBounds(conv: Conversation): { min: number; max: number } | null {
  if (conv.messages.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const m of conv.messages) {
    if (m.ts < min) min = m.ts;
    if (m.ts > max) max = m.ts;
  }
  return { min, max };
}
