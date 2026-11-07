/** All timestamp formatting uses UTC components so conversions are host-timezone independent. */

export function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

export function pad4(n: number): string {
  return n.toString().padStart(4, '0');
}

/** WhatsApp-style: `[DD/MM/YYYY, HH:MM:SS]`. */
export function formatWhatsAppTimestamp(ts: number): string {
  const d = new Date(ts);
  const date = `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${pad4(d.getUTCFullYear())}`;
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  return `[${date}, ${time}]`;
}

/** Telegram-style local ISO (no timezone suffix): `YYYY-MM-DDTHH:MM:SS`. */
export function formatTelegramDate(ts: number): string {
  const d = new Date(ts);
  return (
    `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

/** Human readable: `YYYY-MM-DD HH:MM`. */
export function formatHuman(ts: number): string {
  const d = new Date(ts);
  return (
    `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  );
}

export function slug(s: string | undefined, fallback = 'conversation'): string {
  if (!s) return fallback;
  const out = s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .toLowerCase();
  return out || fallback;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
