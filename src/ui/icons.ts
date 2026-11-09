/**
 * Stroke icons for the converter UI: 24×24, drawn with `currentColor`, so they follow the text colour of
 * whatever they sit in. Plain SVG strings keep the package free of an icon dependency.
 */
export const ICON_PATHS = {
  upload: '<path d="M12 15V4"/><path d="M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  download: '<path d="M12 4v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M4 17v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/>',
  fileText:
    '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/><path d="M9 13h6M9 16.5h4"/>',
  package: '<path d="M12 3 4 7v10l8 4 8-4V7z"/><path d="m4 7 8 4 8-4"/><path d="M12 11v10"/><path d="m8 5 8 4"/>',
  braces:
    '<path d="M8 4.5H7a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h1"/><path d="M16 4.5h1a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-1"/>',
  globe:
    '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.6 3.5 5.5 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.5-3.5-8.5s1.1-5.9 3.5-8.5z"/>',
  send: '<path d="M20.5 3.5 3.5 10.6l6.3 2.6 2.6 6.3z"/><path d="m9.8 13.2 4.4-4.4"/>',
  chevronLeft: '<path d="m14.5 6-6 6 6 6"/>',
  chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>',
  sliders:
    '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  message: '<path d="M20 11.5a8 8 0 0 1-11.7 7.1L4 19.5l1-4A8 8 0 1 1 20 11.5z"/>',
  users:
    '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.5a3 3 0 0 1 0 6"/><path d="M17.5 14.2a5 5 0 0 1 3 4.8"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 16-4.5-4.5L7 19.5"/>',
  video: '<rect x="3" y="6.5" width="13" height="11" rx="2.5"/><path d="m16 10.5 5-3v9l-5-3z"/>',
  film: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 4v16M16 4v16M4 9h4M16 9h4M4 15h4M16 15h4"/>',
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v2.5"/>',
  music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M9 10h.01M15 10h.01"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/>',
  paperclip:
    '<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7-7l8.1-8.1a3.3 3.3 0 0 1 4.7 4.7l-8.1 8.1a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  contact: '<circle cx="12" cy="9" r="3.5"/><path d="M5.5 19.5a6.5 6.5 0 0 1 13 0"/>',
  poll: '<path d="M6 20v-9M12 20V5M18 20v-6"/>',
  checklist: '<path d="m4 7 1.5 1.5L8.5 5.5M4 15l1.5 1.5 3-3"/><path d="M12 7h8M12 15h8"/>',
  phone:
    '<path d="M5 4.5h3.2l1.6 4-2 1.3a10.5 10.5 0 0 0 6.4 6.4l1.3-2 4 1.6V19a1.5 1.5 0 0 1-1.6 1.5A15.5 15.5 0 0 1 3.5 6.1 1.5 1.5 0 0 1 5 4.5z"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
  alert: '<path d="M10.3 4.9 3.4 17a2 2 0 0 0 1.7 3h13.8a2 2 0 0 0 1.7-3L13.7 4.9a2 2 0 0 0-3.4 0z"/><path d="M12 10v4M12 17h.01"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  shield: '<path d="M12 3.5 19 6v5.6c0 4.4-3 7.6-7 8.9-4-1.3-7-4.5-7-8.9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  undo: '<path d="M4 9.5h10a5.5 5.5 0 0 1 0 11H9"/><path d="M8 5.5 4 9.5l4 4"/>',
  trash:
    '<path d="M4.5 7h15M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2"/><path d="m6.5 7 .8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/>',
  minusCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12h7"/>',
  plusCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/>',
  swap: '<path d="M4 8.5h14"/><path d="M14.5 5 18 8.5 14.5 12"/><path d="M20 15.5H6"/><path d="M9.5 12 6 15.5 9.5 19"/>',
  forward: '<path d="m14 6 6 6-6 6"/><path d="M20 12H9a5 5 0 0 0-5 5v1"/>',
  reply: '<path d="m10 6-6 6 6 6"/><path d="M4 12h11a5 5 0 0 1 5 5v1"/>',
  pencil: '<path d="m15.5 4.5 4 4L9 19H5v-4z"/>',
  zap: '<path d="M13 3 5 13.5h6L10.5 21 19 10.5h-6z"/>',
  book: '<path d="M5 4.5h10.5a3 3 0 0 1 3 3v12h-11A2.5 2.5 0 0 1 5 17z"/><path d="M5 17a2.5 2.5 0 0 1 2.5-2.5h11"/>',
  code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4"/><path d="m13.5 5.5-3 13"/>',
  filter: '<path d="M4 5.5h16l-6.2 7.3v5.4l-3.6 1.8v-7.2z"/>',
  sort: '<path d="M8 4v16"/><path d="M4.5 7.5 8 4l3.5 3.5"/><path d="M16 20V4"/><path d="M12.5 16.5 16 20l3.5-3.5"/>',
  layers: '<path d="m12 3.5 8.5 4.5L12 12.5 3.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

/** An inline SVG icon; decorative (aria-hidden) — label the control that holds it. */
export function icon(name: IconName, size = 18): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="cc-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;
  return tpl.content.firstElementChild as SVGSVGElement;
}

/** Monogram colours of the source apps on the start screen and in the inbox (plain colours, not logos). */
export const APP_COLOR: Record<string, string> = {
  telegram: '#2aabee', whatsapp: '#25d366', instagram: '#e1306c', messenger: '#0a7cff', snapchat: '#f7d917',
  vsco: '#8e8e93', hinge: '#7c5cff', universalchat: 'var(--cc-accent, var(--accent))',
};

/** Inline style for an app monogram: `--app`, plus a dark letter on Snapchat's light yellow. */
export function appStyle(platform: string): string {
  return `--app:${APP_COLOR[platform] ?? 'var(--cc-accent, var(--accent))'};${platform === 'snapchat' ? '--app-ink:#1b1b1b' : ''}`;
}
