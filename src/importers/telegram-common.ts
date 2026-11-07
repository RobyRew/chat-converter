import type { Attachment, Call, Participant } from '../model';
import type { MediaStore } from '../engine/media';
import { participantId } from '../engine/ids';
import { extensionOf } from '../sources/source';

/** What Telegram shows for an account that no longer exists (JSON writes `from: null`). */
export const DELETED_ACCOUNT = 'Deleted Account';

/**
 * Telegram Desktop writes one of these instead of a path when it did not download a file
 * (tdesktop `export_output_json.cpp`, SkipReason). The HTML export uses shorter sentences.
 */
export function omittedFromPlaceholder(text: string): Attachment['omitted'] | undefined {
  const t = text.trim();
  if (/not included/i.test(t)) return 'not_included';
  if (/exceeds maximum size/i.test(t)) return 'too_large';
  if (/unavailable|expired/i.test(t)) return 'unavailable';
  return undefined;
}

/** JSON placeholders are wrapped in parentheses; real paths never start with one. */
export function isPlaceholder(value: string): boolean {
  return value.startsWith('(');
}

export function stickerFormatOf(path?: string, mime?: string): Attachment['stickerFormat'] {
  const ext = path ? extensionOf(path) : '';
  if (ext === 'tgs' || mime === 'application/x-tgsticker') return 'tgs';
  if (ext === 'webm' || mime === 'video/webm') return 'webm';
  if (ext === 'webp' || mime === 'image/webp') return 'webp';
  return undefined;
}

/**
 * Points an attachment at its file when the export contains it; otherwise records why it is absent.
 * `ref` stays set for a missing file so the user can see which path the export expected.
 */
export function locate(att: Attachment, path: string | undefined, media: MediaStore): Attachment {
  if (!path) return att;
  if (isPlaceholder(path)) {
    att.present = false;
    att.omitted = omittedFromPlaceholder(path) ?? 'unavailable';
    return att;
  }
  att.ref = path;
  if (media.has(path)) {
    att.present = true;
  } else {
    att.present = false;
    att.omitted = 'missing';
  }
  return att;
}

/** Participants keyed by Telegram id when known, else by name. */
export class Participants {
  private readonly map = new Map<string, Participant>();

  constructor(private readonly platform: 'telegram' = 'telegram') {}

  ensure(name: string | null | undefined, handle?: string | number | null): string | undefined {
    if ((name === null || name === undefined || name === '') && (handle === null || handle === undefined)) {
      return undefined;
    }
    const key = String(handle ?? name);
    const id = participantId(this.platform, key);
    const displayName = name || DELETED_ACCOUNT;
    const existing = this.map.get(id);
    if (!existing) {
      const p: Participant = { id, displayName };
      if (handle !== null && handle !== undefined) p.handles = [String(handle)];
      if (!name) p.meta = { deletedAccount: true };
      this.map.set(id, p);
    } else if (name && existing.meta?.deletedAccount) {
      // A later message carries the real name.
      existing.displayName = name;
      delete existing.meta;
    }
    return id;
  }

  list(): Participant[] {
    return [...this.map.values()];
  }
}

/** `51` → `0:51`, `1626` → `27:06`, `3723` → `1:02:03`. */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** Readable text for a call, used when a format has no call type of its own. */
export function callText(call: Call): string {
  const kind = call.video ? 'Video call' : 'Call';
  if (call.durationSec && call.durationSec > 0) return `📞 ${kind} · ${formatDuration(call.durationSec)}`;
  switch (call.reason) {
    case 'missed':
      return `📞 Missed ${kind.toLowerCase()}`;
    case 'busy':
      return `📞 Declined ${kind.toLowerCase()}`;
    default:
      return call.label ? `📞 ${kind} · ${call.label}` : `📞 ${kind}`;
  }
}

/** Parses "51 seconds", "27 minutes", "1 hour 5 minutes" (tdesktop's call duration text) to seconds. */
export function parseDurationText(text: string): number | undefined {
  let total = 0;
  let found = false;
  for (const m of text.matchAll(/(\d+)\s*(second|sec|minute|min|hour|h)\w*/gi)) {
    const n = Number(m[1]);
    const unit = (m[2] ?? '').toLowerCase();
    total += unit.startsWith('h') ? n * 3600 : unit.startsWith('min') ? n * 60 : n;
    found = true;
  }
  return found ? total : undefined;
}
