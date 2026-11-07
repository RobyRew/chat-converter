import {
  capabilities,
  type Capability,
  type Conversation,
  type FidelityEntry,
  type FidelityReport,
} from '../model';
import type { Exporter } from './contracts';

/** Counts how many messages/items in the conversation actually exercise each capability. */
export function usageCounts(conv: Conversation): Partial<Record<Capability, number>> {
  const c: Partial<Record<Capability, number>> = {};
  const inc = (k: Capability, n = 1): void => {
    c[k] = (c[k] ?? 0) + n;
  };

  if (conv.messages.length) inc('timestamps', conv.messages.length);
  if (conv.participants.length > 2) inc('multipleParticipants', conv.participants.length);
  if (conv.kind === 'group' || conv.kind === 'channel') inc('groups');

  for (const m of conv.messages) {
    if (m.content?.text) inc('richText');
    if (m.content?.entities?.length) inc('entities', m.content.entities.length);
    if (m.attachments?.length) inc('media', m.attachments.length);
    if (m.attachments?.some((a) => a.caption)) inc('mediaCaptions');
    if (m.attachments?.some((a) => a.kind === 'sticker')) inc('stickers');
    if (m.reactions?.length) inc('reactions', m.reactions.length);
    if (m.replyToId) inc('replies');
    if (m.forwardedFrom) inc('forwards');
    if (m.editedAt) inc('edits');
    if (m.deleted) inc('deletions');
  }
  return c;
}

/**
 * The anti-"silent data loss" feature: for everything the conversation actually contains,
 * mark whether the target format preserves / approximates / drops it.
 */
export function buildFidelityReport(
  exporter: Exporter,
  conv: Conversation,
  warnings: string[],
): FidelityReport {
  const used = usageCounts(conv);
  const tgt = exporter.capabilities;
  const approx = exporter.approximates ?? {};
  const entries: FidelityEntry[] = [];

  for (const cap of capabilities) {
    const count = used[cap] ?? 0;
    if (count === 0) continue; // only report what's present
    let status: FidelityEntry['status'];
    if (tgt[cap]) status = 'preserved';
    else if (approx[cap]) status = 'approximated';
    else status = 'dropped';
    entries.push({ capability: cap, status, count });
  }

  const attachments = conv.messages.reduce((n, m) => n + (m.attachments?.length ?? 0), 0);
  return {
    source: conv.originPlatform,
    target: exporter.format,
    entries,
    warnings: [...warnings],
    stats: {
      messages: conv.messages.length,
      participants: conv.participants.length,
      attachments,
      droppedMessages: 0,
    },
    generatedAt: Date.now(),
  };
}
