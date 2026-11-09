import { h } from './dom';
import { icon, type IconName } from './icons';

/**
 * Menus and sheets for the converter, built on a modal `<dialog>`: it sits in the top layer (no clipping by
 * the panes' overflow, no z-index fights with the host page), traps focus and closes on Escape. Wide screens get
 * a popover hanging from the button that opened it; narrow ones a sheet from the bottom edge. The dialog is
 * appended inside the converter so its styles and colour tokens still apply.
 */
export interface OverlayOptions {
  /** Where the dialog is appended (the converter's root). */
  host: HTMLElement;
  /** The control that opened it: the popover hangs from it and focus returns to it. */
  anchor?: HTMLElement;
  label: string;
  /** Popover width on wide screens, in px. */
  width?: number;
  /** A heading inside the sheet / popover. */
  title?: string;
  /** Always a centred panel, never a popover (for longer content). */
  panel?: boolean;
  onClose?: () => void;
}

export interface Overlay {
  dialog: HTMLDialogElement;
  close(): void;
}

const NARROW = '(max-width: 639px)';

export function openOverlay(content: Node | Array<Node | null>, o: OverlayOptions): Overlay {
  const narrow = window.matchMedia(NARROW).matches;
  const mode = narrow ? 'sheet' : o.panel || !o.anchor ? 'panel' : 'popover';
  const dialog = h('dialog', { class: `cc-overlay is-${mode}`, 'aria-label': o.label });
  const close = (): void => {
    if (dialog.open) dialog.close();
  };
  // `autofocus` on the container: opening by tap does not ring the first control; Tab reaches them.
  const inner = h('div', { class: 'cc-overlay__inner', tabindex: -1, autofocus: true },
    mode === 'sheet' ? h('span', { class: 'cc-overlay__grab', 'aria-hidden': 'true' }) : null,
    o.title
      ? h('div', { class: 'cc-overlay__head' },
          h('h3', { class: 'cc-overlay__title' }, o.title),
          h('button', { class: 'cc-iconbtn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('x')))
      : null,
    h('div', { class: 'cc-overlay__body' }, content),
  );
  dialog.append(inner);
  if (o.width && mode !== 'sheet') dialog.style.width = `${o.width}px`;
  o.host.append(dialog);
  dialog.showModal();
  if (mode === 'popover' && o.anchor) place(dialog, o.anchor);
  // A click on the backdrop reaches the dialog itself; clicks inside land on `inner` or its children.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    o.anchor?.focus({ preventScroll: true });
    o.onClose?.();
  });
  return { dialog, close };
}

/** Puts a popover under (or, without room, above) its anchor, kept inside the viewport. */
function place(dialog: HTMLDialogElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const w = dialog.offsetWidth;
  const hgt = dialog.offsetHeight;
  const gap = 6;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  const below = r.bottom + gap;
  const top = below + hgt <= window.innerHeight - 8 ? below : Math.max(8, r.top - gap - hgt);
  dialog.style.left = `${left}px`;
  dialog.style.top = `${top}px`;
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

export type MenuEntry = MenuItem | { heading: string } | 'separator' | null | false | undefined;

/**
 * A menu of actions; arrow keys move between items, Enter/click runs one and closes the menu. Opened from the
 * keyboard, the first item takes focus; opened by pointer or touch, the menu itself does.
 */
export function openMenu(entries: MenuEntry[], o: OverlayOptions): Overlay {
  let overlay: Overlay | undefined;
  const fromKeyboard = !!o.anchor?.matches(':focus-visible');
  const items: HTMLButtonElement[] = [];
  const list = h('div', { class: 'cc-menu', role: 'menu', 'aria-label': o.label });
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === 'separator') {
      list.append(h('div', { class: 'cc-menu__sep', role: 'separator' }));
      continue;
    }
    if ('heading' in entry) {
      list.append(h('p', { class: 'cc-menu__heading' }, entry.heading));
      continue;
    }
    const item = h('button', {
      class: `cc-menu__item${entry.danger ? ' is-danger' : ''}`,
      type: 'button',
      role: entry.checked === undefined ? 'menuitem' : 'menuitemradio',
      'aria-checked': entry.checked === undefined ? undefined : String(entry.checked),
      disabled: entry.disabled,
    },
      h('span', { class: 'cc-menu__icon' }, entry.icon ? icon(entry.icon) : entry.checked ? icon('check') : null),
      h('span', { class: 'cc-menu__label' }, entry.label, entry.hint ? h('small', {}, entry.hint) : null),
    );
    item.addEventListener('click', () => {
      overlay?.close();
      entry.onSelect();
    });
    items.push(item);
    list.append(item);
  }
  const onKey = (e: KeyboardEvent): void => {
    const enabled = items.filter((b) => !b.disabled);
    const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (at + 1) % enabled.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    if (next >= 0) {
      e.preventDefault();
      enabled[next]?.focus();
    }
  };
  overlay = openOverlay(list, { width: 260, ...o });
  // On the dialog, not the list: focus may sit on the dialog's container, outside the list.
  overlay.dialog.addEventListener('keydown', onKey);
  if (fromKeyboard) items.find((b) => !b.disabled)?.focus();
  return overlay;
}
