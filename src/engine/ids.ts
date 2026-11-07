/**
 * Deterministic id helpers. We never use `Math.random()` for ids (the old tool's bug) —
 * everything is hash-derived so conversions are reproducible and round-trippable.
 */

/** cyrb53 — fast, deterministic 53-bit string hash (no deps, isomorphic). */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function hash(parts: Array<string | number>): string {
  return cyrb53(parts.join('')).toString(36);
}

export function conversationId(platform: string, key: string): string {
  return 'c_' + hash([platform, key]);
}

export function participantId(platform: string, key: string): string {
  return 'p_' + hash([platform, key]);
}

export function messageId(convId: string, ...parts: Array<string | number>): string {
  return 'm_' + hash([convId, ...parts]);
}

export function attachmentId(key: string): string {
  return 'a_' + cyrb53(key).toString(36);
}

/** Stable positive integer id for formats that require numeric ids. */
export function numericId(key: string): number {
  return cyrb53(key) % 1_000_000_000;
}
