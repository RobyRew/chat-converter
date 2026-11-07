import { wallClockAt, zoneOffsetMinutes } from '../engine/time';
import type { Message } from '../model';

const pad = (n: number): string => String(n).padStart(2, '0');

/** Wall-clock time of a message in `tz` (or its original offset when the export recorded one). */
export function localParts(m: Pick<Message, 'ts' | 'tzOffsetMinutes'>, tz: string, useOriginal = true) {
  const offset = useOriginal && m.tzOffsetMinutes !== undefined ? m.tzOffsetMinutes : zoneOffsetMinutes(m.ts, tz);
  return wallClockAt(m.ts, offset);
}

export function formatDateTime(m: Pick<Message, 'ts' | 'tzOffsetMinutes'>, tz: string): string {
  const w = localParts(m, tz);
  return `${pad(w.day)}/${pad(w.month)}/${w.year} ${pad(w.hour)}:${pad(w.minute)}`;
}

export function formatDay(ts: number, tz: string): string {
  const w = wallClockAt(ts, zoneOffsetMinutes(ts, tz));
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** `yyyy-mm-dd` of an instant in `tz`, for `<input type="date">`. */
export function dateInput(ts: number, tz: string): string {
  const w = wallClockAt(ts, zoneOffsetMinutes(ts, tz));
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Stable hue per name, for sender colours. */
export function hue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
