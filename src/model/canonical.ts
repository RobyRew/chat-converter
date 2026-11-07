import { z } from 'zod';
import { PlatformIdSchema } from './platforms';

/**
 * Version of the canonical shape. v2 only adds optional fields (structured polls, checklists, locations,
 * contacts, calls and service events; omitted-media markers), so every v1 document is a valid v2 one.
 */
export const SCHEMA_VERSION = 2 as const;

/**
 * Inline rich-text formatting. Offsets/lengths are in **UTF-16 code units** (JS string
 * indices), matching Telegram's `text_entities` and native JS `String` semantics.
 */
export const entityTypes = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'spoiler',
  'code',
  'pre',
  'blockquote',
  'link',
  'mention',
  'hashtag',
  'email',
  'phone',
  'custom',
] as const;

export const MessageEntitySchema = z.object({
  type: z.enum(entityTypes),
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  /** For `link` entities. */
  url: z.string().optional(),
  /** For `pre` (code block) entities. */
  language: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type MessageEntity = z.infer<typeof MessageEntitySchema>;

export const RichTextSchema = z.object({
  text: z.string(),
  entities: z.array(MessageEntitySchema).default([]),
});
export type RichText = z.infer<typeof RichTextSchema>;

export const attachmentKinds = [
  'image',
  'video',
  'audio',
  'voice',
  'file',
  'sticker',
  'gif',
  'animation',
  'contact',
  'location',
  'poll',
  'unknown',
] as const;

/** Why an attachment's bytes are not in the export. */
export const omittedReasons = [
  /** The export settings left this media type out ("File not included"). */
  'not_included',
  /** Larger than the export's size limit ("File exceeds maximum size"). */
  'too_large',
  /** Expired self-destructing media, a skipped download, or a server-side failure. */
  'unavailable',
  /** Referenced by the chat file, but not among the files that were provided. */
  'missing',
] as const;

export const AttachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(attachmentKinds),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  /** Path of the bytes inside the source export (folder or archive). */
  ref: z.string().optional(),
  /** `false` when the export references the media but does not contain its bytes. */
  present: z.boolean().optional(),
  omitted: z.enum(omittedReasons).optional(),
  /** Sticker encoding: static WebP, Lottie (`tgs`) or video (`webm`). */
  stickerFormat: z.enum(['webp', 'tgs', 'webm']).optional(),
  /** Emoji attached to a sticker. */
  emoji: z.string().optional(),
  /** Telegram round video message. */
  round: z.boolean().optional(),
  spoiler: z.boolean().optional(),
  selfDestructSec: z.number().nonnegative().optional(),
  size: z.number().int().nonnegative().optional(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  durationSec: z.number().nonnegative().optional(),
  caption: RichTextSchema.optional(),
  thumbnailRef: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const ReactionSchema = z.object({
  emoji: z.string(),
  senderId: z.string().optional(),
  count: z.number().int().positive().optional(),
  ts: z.number().int().optional(),
});
export type Reaction = z.infer<typeof ReactionSchema>;

export const ParticipantSchema = z.object({
  /** Stable, deterministic id (hash-based). Never random. */
  id: z.string(),
  displayName: z.string().optional(),
  /** Phone numbers / usernames / handles seen for this participant. */
  handles: z.array(z.string()).optional(),
  avatarRef: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const ForwardInfoSchema = z.object({
  name: z.string().optional(),
  senderId: z.string().optional(),
  /** Platform handle of the original sender (e.g. Telegram `user123`). */
  handle: z.string().optional(),
  ts: z.number().int().optional(),
});
export type ForwardInfo = z.infer<typeof ForwardInfoSchema>;

export const messageKinds = [
  'text',
  'media',
  'sticker',
  'system',
  'service',
  'call',
  'poll',
  'checklist',
  'location',
  'contact',
] as const;

export const PollSchema = z.object({
  question: z.string(),
  options: z.array(
    z.object({
      text: z.string(),
      votes: z.number().int().nonnegative().optional(),
      /** The exporting user picked this option. */
      chosen: z.boolean().optional(),
    }),
  ),
  totalVoters: z.number().int().nonnegative().optional(),
  closed: z.boolean().optional(),
  anonymous: z.boolean().optional(),
});
export type Poll = z.infer<typeof PollSchema>;

export const ChecklistSchema = z.object({
  title: z.string(),
  items: z.array(z.object({ id: z.number().int().optional(), text: z.string(), done: z.boolean().optional() })),
});
export type Checklist = z.infer<typeof ChecklistSchema>;

export const LocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  name: z.string().optional(),
  address: z.string().optional(),
  /** Set for live locations: how long the location was shared. */
  livePeriodSec: z.number().nonnegative().optional(),
  live: z.boolean().optional(),
});
export type LocationInfo = z.infer<typeof LocationSchema>;

export const ContactSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phone: z.string().optional(),
  /** Path of the vCard file inside the export, when it was exported. */
  vcardRef: z.string().optional(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const CallSchema = z.object({
  durationSec: z.number().nonnegative().optional(),
  /** Telegram `discard_reason`: `missed`, `busy`, `hangup`, `disconnect`. */
  reason: z.string().optional(),
  /** Status text as the export wrote it (e.g. "Incoming (51 seconds)", "Cancelled"). */
  label: z.string().optional(),
  video: z.boolean().optional(),
});
export type Call = z.infer<typeof CallSchema>;

export const ServiceSchema = z.object({
  /** Platform action name, e.g. Telegram `pin_message`, `take_screenshot`, `todo_completions`. */
  action: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type Service = z.infer<typeof ServiceSchema>;

export const MessageSchema = z.object({
  /** Stable, deterministic id. */
  id: z.string(),
  senderId: z.string().optional(),
  /** Epoch milliseconds, UTC. */
  ts: z.number().int(),
  /** Original timezone offset in minutes, if known (e.g. +120 for CEST). */
  tzOffsetMinutes: z.number().int().optional(),
  kind: z.enum(messageKinds).default('text'),
  content: RichTextSchema.optional(),
  attachments: z.array(AttachmentSchema).optional(),
  replyToId: z.string().optional(),
  forwardedFrom: ForwardInfoSchema.optional(),
  reactions: z.array(ReactionSchema).optional(),
  editedAt: z.number().int().optional(),
  deleted: z.boolean().optional(),
  poll: PollSchema.optional(),
  checklist: ChecklistSchema.optional(),
  location: LocationSchema.optional(),
  contact: ContactSchema.optional(),
  call: CallSchema.optional(),
  service: ServiceSchema.optional(),
  /** Bot through which an inline result was sent (`@gif`). */
  viaBot: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  /** Original platform payload, preserved verbatim for round-trip fidelity. */
  raw: z.unknown().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

/** Manifest entry describing a media file referenced by the conversation. */
export const MediaItemSchema = z.object({
  ref: z.string(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  present: z.boolean().default(true),
});
export type MediaItem = z.infer<typeof MediaItemSchema>;

export const conversationKinds = ['dm', 'group', 'channel'] as const;

export const ConversationSchema = z.object({
  schemaVersion: z.number().int().default(SCHEMA_VERSION),
  id: z.string(),
  kind: z.enum(conversationKinds).default('dm'),
  title: z.string().optional(),
  originPlatform: PlatformIdSchema,
  participants: z.array(ParticipantSchema).default([]),
  messages: z.array(MessageSchema).default([]),
  media: z.array(MediaItemSchema).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

/**
 * Reads a stored conversation of any schema version (ChatForge Vault items are v1) and returns it as the
 * current version. v2 only added optional fields, so this validates and stamps the version.
 */
export function upgradeConversation(value: unknown): Conversation {
  const conv = ConversationSchema.parse(value);
  return { ...conv, schemaVersion: SCHEMA_VERSION };
}
