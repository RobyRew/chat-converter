import { z } from 'zod';
import { CapabilitySchema } from './capabilities';
import { ExportFormatIdSchema, PlatformIdSchema } from './platforms';

export const fidelityStatuses = [
  'preserved',
  'approximated',
  'dropped',
  'not-present',
] as const;
export const FidelityStatusSchema = z.enum(fidelityStatuses);
export type FidelityStatus = z.infer<typeof FidelityStatusSchema>;

export const FidelityEntrySchema = z.object({
  capability: CapabilitySchema,
  status: FidelityStatusSchema,
  detail: z.string().optional(),
  /** How many items were affected (e.g. number of reactions dropped). */
  count: z.number().int().nonnegative().optional(),
});
export type FidelityEntry = z.infer<typeof FidelityEntrySchema>;

export const FidelityStatsSchema = z.object({
  messages: z.number().int().nonnegative().default(0),
  participants: z.number().int().nonnegative().default(0),
  attachments: z.number().int().nonnegative().default(0),
  droppedMessages: z.number().int().nonnegative().default(0),
});
export type FidelityStats = z.infer<typeof FidelityStatsSchema>;

/**
 * Emitted by every conversion. Tells the user exactly what was preserved, approximated,
 * or dropped when going from `source` to `target` — the core anti-"silent data loss" feature.
 */
export const FidelityReportSchema = z.object({
  source: PlatformIdSchema,
  target: ExportFormatIdSchema,
  entries: z.array(FidelityEntrySchema).default([]),
  warnings: z.array(z.string()).default([]),
  stats: FidelityStatsSchema,
  generatedAt: z.number().int(),
});
export type FidelityReport = z.infer<typeof FidelityReportSchema>;
