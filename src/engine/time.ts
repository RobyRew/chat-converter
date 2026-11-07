/**
 * Time-zone helpers built on `Intl` (full ICU in browsers and Node ≥ 13), so they work the same in a
 * Web Worker and in Node without a time-zone database dependency.
 */

/** The zone of the machine running the conversion (the browser's or Node's). */
export function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Offset of `tz` at the instant `utcMs`, in minutes (local − UTC); e.g. +60 for CET. */
export function zoneOffsetMinutes(utcMs: number, tz: string): number {
  const parts = formatter(tz).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = get('hour') % 24;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * The UTC instant of a wall-clock time in `tz`. In the hour a DST change repeats, the first occurrence
 * is returned; a time inside a skipped hour is moved forward by the gap.
 */
export function zonedTimeToUtc(w: WallClock, tz: string): number {
  const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const HOUR = 3600000;
  // Offsets just before and after any transition near this time give every candidate instant.
  const offsets = new Set([zoneOffsetMinutes(wall - 3 * HOUR, tz), zoneOffsetMinutes(wall, tz), zoneOffsetMinutes(wall + 3 * HOUR, tz)]);
  const valid = [...offsets]
    .map((off) => wall - off * 60000)
    .filter((utc) => zoneOffsetMinutes(utc, tz) === (wall - utc) / 60000)
    .sort((a, b) => a - b);
  // Ambiguous (clocks went back): the earliest instant. Skipped (clocks went forward): none is valid,
  // so the pre-transition offset is used, which lands after the gap.
  return valid[0] ?? wall - zoneOffsetMinutes(wall - 3 * HOUR, tz) * 60000;
}

/** Wall-clock fields of `utcMs` once shifted by `offsetMinutes`. */
export function wallClockAt(utcMs: number, offsetMinutes: number): WallClock {
  const d = new Date(utcMs + offsetMinutes * 60000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/** Parses Telegram's local ISO form `2023-04-28T19:24:27` (no offset) into wall-clock fields. */
export function parseLocalIso(s: string): WallClock | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
}

/** Minutes between a wall-clock reading and the UTC instant it was taken at. */
export function offsetOf(wall: WallClock, utcMs: number): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((asUtc - utcMs) / 60000);
}
