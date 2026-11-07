import { z } from 'zod';

/**
 * Importable source platforms. Also stored as a conversation's `originPlatform`.
 * `importable: false` entries are scaffolded (contracts ready) but not yet functional.
 */
export const platformIds = [
  'whatsapp',
  'telegram',
  'instagram',
  'messenger',
  'discord',
  'signal',
  'imessage',
  'slack',
  'snapchat',
  'vsco',
  'hinge',
  'universalchat',
  'generic',
] as const;
export const PlatformIdSchema = z.enum(platformIds);
export type PlatformId = z.infer<typeof PlatformIdSchema>;

/** Export / output formats. */
export const exportFormatIds = [
  'telegram-json',
  'whatsapp-txt',
  'html',
  'markdown',
  'json',
  /** WhatsApp's own export zip (`_chat.txt` + media). */
  'whatsapp-zip',
  /** The WhatsApp-format zip tuned to Telegram for iPhone/iPad's importer (media included). */
  'telegram-ios',
  /** The same zip for Telegram for Android, which imports the text only. */
  'telegram-android',
  /** The complete archive as one versioned JSON document (no media bytes). */
  'universalchat',
  /** The complete archive plus every media file: the lossless package. */
  'universalchat-zip',
] as const;
export const ExportFormatIdSchema = z.enum(exportFormatIds);
export type ExportFormatId = z.infer<typeof ExportFormatIdSchema>;

export interface PlatformMeta {
  id: PlatformId;
  label: string;
  /** Whether a working importer ships in v1. */
  importable: boolean;
}

export const PLATFORM_META: Record<PlatformId, PlatformMeta> = {
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', importable: true },
  telegram: { id: 'telegram', label: 'Telegram', importable: true },
  instagram: { id: 'instagram', label: 'Instagram', importable: true },
  messenger: { id: 'messenger', label: 'Facebook Messenger', importable: true },
  discord: { id: 'discord', label: 'Discord', importable: false },
  signal: { id: 'signal', label: 'Signal', importable: false },
  imessage: { id: 'imessage', label: 'iMessage', importable: false },
  slack: { id: 'slack', label: 'Slack', importable: false },
  snapchat: { id: 'snapchat', label: 'Snapchat', importable: true },
  vsco: { id: 'vsco', label: 'VSCO', importable: true },
  hinge: { id: 'hinge', label: 'Hinge', importable: true },
  universalchat: { id: 'universalchat', label: 'UniversalChat', importable: true },
  generic: { id: 'generic', label: 'Generic', importable: false },
};

export interface FormatMeta {
  id: ExportFormatId;
  label: string;
  extension: string;
  mime: string;
}

export const FORMAT_META: Record<ExportFormatId, FormatMeta> = {
  'telegram-json': { id: 'telegram-json', label: 'Telegram (JSON)', extension: 'json', mime: 'application/json' },
  'whatsapp-txt': { id: 'whatsapp-txt', label: 'WhatsApp (.txt)', extension: 'txt', mime: 'text/plain' },
  html: { id: 'html', label: 'HTML viewer', extension: 'html', mime: 'text/html' },
  markdown: { id: 'markdown', label: 'Markdown', extension: 'md', mime: 'text/markdown' },
  json: { id: 'json', label: 'Canonical JSON', extension: 'json', mime: 'application/json' },
  'whatsapp-zip': { id: 'whatsapp-zip', label: 'WhatsApp export (.zip)', extension: 'zip', mime: 'application/zip' },
  'telegram-ios': { id: 'telegram-ios', label: 'Telegram import — iPhone/iPad (.zip)', extension: 'zip', mime: 'application/zip' },
  'telegram-android': { id: 'telegram-android', label: 'Telegram import — Android (.zip, text only)', extension: 'zip', mime: 'application/zip' },
  universalchat: { id: 'universalchat', label: 'UniversalChat (.json)', extension: 'universalchat.json', mime: 'application/json' },
  'universalchat-zip': { id: 'universalchat-zip', label: 'UniversalChat package (.zip, with media)', extension: 'universalchat.zip', mime: 'application/zip' },
};

/** Formats written as a streamed archive with media (`writePackage`), not as one in-memory file. */
export const packageFormatIds: readonly ExportFormatId[] = ['whatsapp-zip', 'telegram-ios', 'telegram-android', 'universalchat-zip'];
