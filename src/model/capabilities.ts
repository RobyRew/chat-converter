import { z } from 'zod';

/**
 * Feature dimensions a chat format may support. Used by importers (what they can
 * extract) and exporters (what they can represent). The diff between a source's and a
 * target's matrix drives the fidelity report.
 */
export const capabilities = [
  'timestamps',
  'timezone',
  'messageIds',
  'richText',
  'entities',
  'reactions',
  'replies',
  'forwards',
  'edits',
  'deletions',
  'media',
  'mediaCaptions',
  'stickers',
  'polls',
  'location',
  'contacts',
  'calls',
  'threads',
  'groups',
  'multipleParticipants',
] as const;
export const CapabilitySchema = z.enum(capabilities);
export type Capability = z.infer<typeof CapabilitySchema>;

/** Which capabilities a plugin supports (true) or not (false / absent). */
export type CapabilityMatrix = Partial<Record<Capability, boolean>>;
// partialRecord, not record: since zod 4 a record keyed by an enum requires every key,
// while a matrix may leave capabilities out.
export const CapabilityMatrixSchema = z.partialRecord(CapabilitySchema, z.boolean());
