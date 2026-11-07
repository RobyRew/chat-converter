import { z } from 'zod';
import { PlatformIdSchema } from './platforms';

/** Bump when the canonical shape changes in a breaking way. */
export const SCHEMA_VERSION = 1 as const;

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

export const AttachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(attachmentKinds),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  /** Path of the bytes inside the media store / source archive. */
  ref: z.string().optional(),
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
  'location',
  'contact',
] as const;

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
