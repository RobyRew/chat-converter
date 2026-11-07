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
  instagram: { id: 'instagram', label: 'Instagram', importable: false },
  messenger: { id: 'messenger', label: 'Messenger', importable: false },
  discord: { id: 'discord', label: 'Discord', importable: false },
  signal: { id: 'signal', label: 'Signal', importable: false },
  imessage: { id: 'imessage', label: 'iMessage', importable: false },
  slack: { id: 'slack', label: 'Slack', importable: false },
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
};

/** Formats written as a streamed archive with media (`writePackage`), not as one in-memory file. */
export const packageFormatIds: readonly ExportFormatId[] = ['whatsapp-zip', 'telegram-ios', 'telegram-android'];
