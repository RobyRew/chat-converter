import { z } from 'zod';
import {
  attachmentKinds,
  conversationKinds,
  ConversationSchema,
  entityTypes,
  messageKinds,
  omittedReasons,
  ParticipantSchema,
  type Conversation,
} from './canonical';
import { platformIds, PlatformIdSchema } from './platforms';

/**
 * UniversalChat — one document for any number of conversations from any app.
 *
 * Versioning (`version`, semver):
 * - MAJOR: a reader of an older major must refuse the document (a field changed meaning or was removed).
 * - MINOR: additions only — new optional fields, new values of an existing list, new `ext` namespaces.
 *   Readers keep every field they do not know (all objects are "loose"), and map an unknown list value to
 *   its fallback while keeping the original under `ext.universalchat`.
 * - PATCH: wording and documentation only.
 *
 * Platform data that has no common field lives under `ext.<platform>` on the archive, a conversation, a
 * participant, a message or an attachment (`ext.whatsapp.raw`, `ext.telegram.action`…); the original
 * platform record is kept in `message.raw`.
 */
export const UNIVERSAL_CHAT = 'UniversalChat' as const;
export const UNIVERSAL_CHAT_VERSION = '1.0.0';

export const ArchiveSourceSchema = z
  .object({
    platform: PlatformIdSchema,
    /** Which export variant: `json`, `html`, `both`, `ios`, `android`, `dyi-html`, `dyi-json`, `my-data`… */
    variant: z.string().optional(),
    /** The dropped folder or archive name. */
    name: z.string().optional(),
    /** When the export was made (epoch ms), if known. */
    exportedAt: z.number().int().optional(),
    /** The account that made the export, if the export says so. */
    account: ParticipantSchema.optional(),
  })
  .loose();
export type ArchiveSource = z.infer<typeof ArchiveSourceSchema>;

export const UniversalChatSchema = z
  .object({
    format: z.literal(UNIVERSAL_CHAT),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    generator: z.object({ name: z.string(), version: z.string().optional() }).loose().optional(),
    /** When this document was written (epoch ms). */
    createdAt: z.number().int(),
    source: ArchiveSourceSchema.optional(),
    conversations: z.array(ConversationSchema),
    ext: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  })
  .loose();
export type UniversalChat = z.infer<typeof UniversalChatSchema>;

export const GENERATOR = { name: 'chat-converter', version: '0.1.0' } as const;

export function createUniversalChat(conversations: Conversation[], source?: ArchiveSource, createdAt = Date.now()): UniversalChat {
  const doc: UniversalChat = {
    format: UNIVERSAL_CHAT,
    version: UNIVERSAL_CHAT_VERSION,
    generator: { ...GENERATOR },
    createdAt,
    conversations,
  };
  if (source) doc.source = source;
  return doc;
}

export function isUniversalChat(value: unknown): value is UniversalChat {
  return typeof value === 'object' && value !== null && (value as { format?: unknown }).format === UNIVERSAL_CHAT;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Replaces a value a newer version may have added with its fallback, keeping the original. */
function normalize(o: Obj, key: string, known: readonly string[], fallback: string | undefined): void {
  const v = o[key];
  if (typeof v !== 'string' || known.includes(v)) return;
  const ext = isObj(o['ext']) ? (o['ext'] as Obj) : {};
  const mine = isObj(ext['universalchat']) ? (ext['universalchat'] as Obj) : {};
  mine[`original_${key}`] = v;
  ext['universalchat'] = mine;
  o['ext'] = ext;
  if (fallback === undefined) delete o[key];
  else o[key] = fallback;
}

function normalizeConversation(c: Obj): void {
  normalize(c, 'kind', conversationKinds, 'group');
  normalize(c, 'originPlatform', platformIds, 'generic');
  for (const m of Array.isArray(c['messages']) ? c['messages'] : []) {
    if (!isObj(m)) continue;
    normalize(m, 'kind', messageKinds, 'text');
    const content = m['content'];
    if (isObj(content) && Array.isArray(content['entities'])) {
      for (const e of content['entities']) if (isObj(e)) normalize(e, 'type', entityTypes, 'custom');
    }
    for (const a of Array.isArray(m['attachments']) ? m['attachments'] : []) {
      if (!isObj(a)) continue;
      normalize(a, 'kind', attachmentKinds, 'unknown');
      normalize(a, 'omitted', omittedReasons, 'unavailable');
      normalize(a, 'stickerFormat', ['webp', 'tgs', 'webm'], undefined);
    }
  }
}

/**
 * Reads a UniversalChat document of this major version, or a single conversation in the older ChatForge
 * shape (schemaVersion 1 or 2), and returns a UniversalChat document.
 */
export function readUniversalChat(value: unknown): UniversalChat {
  const copy: unknown = structuredClone(value);
  if (isUniversalChat(copy)) {
    const major = Number(String((copy as Obj)['version'] ?? '0').split('.')[0]);
    const ours = Number(UNIVERSAL_CHAT_VERSION.split('.')[0]);
    if (major > ours) {
      throw new Error(`UniversalChat ${String((copy as Obj)['version'])} is newer than this reader (${UNIVERSAL_CHAT_VERSION}); update Chat Converter.`);
    }
    for (const c of Array.isArray((copy as Obj)['conversations']) ? ((copy as Obj)['conversations'] as unknown[]) : []) {
      if (isObj(c)) normalizeConversation(c);
    }
    return UniversalChatSchema.parse(copy);
  }
  if (isObj(copy) && Array.isArray(copy['messages'])) {
    normalizeConversation(copy);
    const conversation = ConversationSchema.parse(copy);
    return createUniversalChat([conversation], { platform: conversation.originPlatform });
  }
  throw new Error('Not a UniversalChat document or a conversation');
}
