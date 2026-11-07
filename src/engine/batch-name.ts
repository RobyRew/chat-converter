import type { ExportFormatId } from '../model';
import { sanitizeFileName } from '../exporters/whatsapp-format';

/** The download name of a batch, known before it is written (a save dialog needs it first). */
export function batchFileName(target: ExportFormatId, name: string | undefined, count: number): string {
  const base = sanitizeFileName(name ?? 'Chats', 80);
  if (target === 'universalchat') return `${base}.universalchat.json`;
  if (target === 'universalchat-zip') return `${base}.universalchat.zip`;
  return `${base} - ${count} chats.zip`;
}
