import type { BlobEntry } from '../sources/blob';
import type { Conversation, ExportFormatId, FidelityReport, Message, Participant } from '../model';
import { FORMAT_META, packageFormatIds } from '../model';
import type { PackageSummary, WhatsAppPackageOptions } from '../engine/contracts';
import { applyEdits, dateBounds, orderMessages, participantMessageCounts, type Edits, type MessageOrder } from '../engine/transforms';
import { segmentRichText } from '../engine/richtext';
import { defaultTimeZone, zonedTimeToUtc } from '../engine/time';
import { archiveName, guessSelf } from '../exporters/whatsapp-format';
import { importTarget } from '../targets/index';
import { canPickSaveFile, downloadFromOpfs, dropName, entriesFromDataTransfer, entriesFromFileList, pickSaveFile } from '../browser/index';
import { ConverterClient, defaultWorker } from './client';
import { debounce, h, replace } from './dom';
import { dateInput, formatBytes, formatCount, formatDateTime, formatDay, hue } from './format';
import { VirtualList } from './virtual-list';

type Phase = 'empty' | 'reading' | 'ready' | 'converting' | 'done' | 'error';

interface Result {
  fileName: string;
  report: FidelityReport;
  warnings: string[];
  summary?: PackageSummary;
  archiveBytes?: number;
  opfsName?: string;
}

/** Target groups, in the order they are offered. Formats the engine does not have are skipped. */
const GROUPS: Array<{ label: string; formats: string[] }> = [
  { label: 'Import into another app', formats: ['telegram-ios', 'telegram-android'] },
  { label: 'Keep a complete copy', formats: ['universalchat-zip', 'universalchat', 'html', 'markdown'] },
  { label: 'Other formats', formats: ['whatsapp-zip', 'whatsapp-txt', 'telegram-json', 'json'] },
];

const TARGET_NOTES: Record<string, string> = {
  'telegram-ios': 'Text + every photo, video, voice note, sticker and file. Share the .zip to Telegram on iPhone/iPad.',
  'telegram-android': 'Text only — Telegram for Android does not upload media from a zip.',
  'whatsapp-zip': 'WhatsApp’s own export layout, media included.',
  'whatsapp-txt': 'The chat text in WhatsApp’s format; media shown as “omitted”.',
  'telegram-json': 'Telegram Desktop’s result.json layout.',
  html: 'A readable page to keep or print.',
  markdown: 'Plain text with light formatting.',
  json: 'The full model as JSON.',
  universalchat: 'The complete chat as one versioned JSON document.',
  'universalchat-zip': 'The complete chat plus all media: the lossless archive.',
};

const KIND_ICON: Record<string, string> = {
  image: '🖼', video: '🎬', gif: '🎞', animation: '🎞', audio: '🎵', voice: '🎤', sticker: '🏷', file: '📄', contact: '👤', location: '📍', poll: '📊', unknown: '📎',
};

function isPackage(format: ExportFormatId): boolean {
  return packageFormatIds.includes(format);
}

function supportedZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return [defaultTimeZone()];
  }
}

/**
 * `<chat-converter-app>`: drop an export, edit the details, preview it, convert it.
 *
 * Host hooks (ChatForge uses them for "Save to Vault"):
 * - children with `slot="actions"` are moved into the convert panel;
 * - `getConversation()` returns the edited conversation;
 * - events: `cc-imported`, `cc-change`, `cc-converted` (bubbling, composed).
 * - `workerFactory` can replace the bundled worker.
 */
export class ChatConverterElement extends HTMLElement {
  workerFactory: () => Worker = defaultWorker;

  private client?: ConverterClient;
  private phase: Phase = 'empty';
  private error = '';
  private entries: BlobEntry[] = [];
  private dropLabel = '';
  private exportsFound: string[] = [];
  private exportIndex = 0;
  private importId = '';
  private sourceName = '';
  private detected = '';
  private warnings: string[] = [];
  private imported?: Conversation;
  private edits: Edits = {};
  private selfId: string | undefined;
  private mode: 'dm' | 'group' = 'dm';
  private timeZone = defaultTimeZone();
  private order: MessageOrder = 'source';
  private target: ExportFormatId = 'telegram-ios';
  private options: WhatsAppPackageOptions = {};
  private progress = { entries: 0, bytes: 0, total: 0 };
  private runningId = '';
  private result?: Result;
  private tab: 'chat' | 'output' | 'report' = 'chat';
  private list?: VirtualList;
  private shown: Message[] = [];
  private names = new Map<string, Participant>();
  private root!: HTMLDivElement;
  private actions: Node[] = [];

  connectedCallback(): void {
    if (this.root) return;
    this.actions = [...this.children].filter((c) => c.getAttribute('slot') === 'actions');
    for (const a of this.actions) (a as Element).remove();
    this.root = h('div', { class: 'cc' });
    this.append(this.root);
    this.render();
  }

  disconnectedCallback(): void {
    this.client?.terminate();
    this.client = undefined;
  }

  /** The conversation as it will be converted: edits applied, removed messages left out. */
  getConversation(): Conversation | undefined {
    if (!this.imported) return undefined;
    return orderMessages(applyEdits(this.imported, this.edits), this.order);
  }

  // ---------------------------------------------------------------- flow

  private worker(): ConverterClient {
    this.client ??= new ConverterClient(this.workerFactory());
    return this.client;
  }

  private emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private async load(entries: BlobEntry[], label: string): Promise<void> {
    if (!entries.length) return;
    this.entries = entries;
    this.dropLabel = label;
    this.exportIndex = 0;
    await this.runImport();
  }

  private async runImport(): Promise<void> {
    this.phase = 'reading';
    this.error = '';
    this.result = undefined;
    this.render();
    const client = this.worker();
    if (this.importId) void client.call({ action: 'release', importId: this.importId }).catch(() => undefined);
    const id = client.nextId();
    try {
      const res = await client.call(
        {
          action: 'import',
          input: { kind: 'files', name: this.dropLabel, entries: this.entries.map((e) => ({ path: e.path, file: e.blob })) },
          timeZone: this.timeZone,
          exportIndex: this.exportIndex,
        },
        undefined,
        id,
      );
      if (!res.ok || res.action !== 'import') return;
      this.importId = id;
      this.imported = res.conversation;
      this.detected = res.detectedPlatform;
      this.warnings = [...res.warnings, ...this.exportWarnings(res.conversation)];
      this.exportsFound = res.exports;
      this.sourceName = res.sourceName;
      this.edits = {};
      this.selfId = guessSelf(res.conversation);
      this.mode = res.conversation.kind === 'dm' ? 'dm' : 'group';
      const tz = res.conversation.meta?.['timeZone'];
      if (typeof tz === 'string') this.timeZone = tz;
      this.phase = 'ready';
      this.render();
      this.emit('cc-imported', { title: res.conversation.title, messages: res.conversation.messages.length, platform: res.detectedPlatform });
    } catch (e) {
      this.phase = 'error';
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    }
  }

  /** What the export left out, in words the user can act on. */
  private exportWarnings(c: Conversation): string[] {
    const out: string[] = [];
    const att = c.messages.flatMap((m) => m.attachments ?? []);
    const notIncluded = att.filter((a) => a.omitted === 'not_included');
    if (notIncluded.length) {
      const kinds: Record<string, number> = {};
      for (const a of notIncluded) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
      const list = Object.entries(kinds).map(([k, n]) => `${formatCount(n)} ${k}`).join(', ');
      out.push(
        `${formatCount(notIncluded.length)} media files are not in this export (${list}). In Telegram Desktop, export again with every media type ticked and the size limit at 4000 MB — the limit is per file, not for the whole export.`,
      );
    }
    const missing = att.filter((a) => a.omitted === 'missing').length;
    if (missing) out.push(`${formatCount(missing)} media files are referenced but were not dropped — drop the whole export folder.`);
    const unavailable = att.filter((a) => a.omitted === 'unavailable').length;
    if (unavailable) out.push(`${formatCount(unavailable)} media files were unavailable to Telegram (expired self-destructing media, or a failed download).`);
    if (c.meta?.['exportFormat'] === 'html') {
      out.push(`Read from the HTML pages: times are converted with the ${this.timeZone} zone, and edit marks are not in HTML exports. A JSON export carries both.`);
    }
    return out;
  }

  private effectiveEdits(): Edits {
    return this.edits;
  }

  private whatsappOptions(): WhatsAppPackageOptions {
    const o: WhatsAppPackageOptions = { ...this.options, mode: this.mode, timeZone: this.timeZone };
    if (this.selfId) o.selfId = this.selfId;
    return o;
  }

  private suggestedName(): string {
    const conv = this.getConversation();
    if (!conv) return 'chat';
    if (isPackage(this.target)) {
      const self = this.selfId ?? guessSelf(conv);
      const peer = conv.participants.find((p) => p.id !== self);
      const title = this.mode === 'dm' ? (peer?.displayName ?? conv.title ?? 'Chat') : (this.edits.title ?? conv.title ?? 'Group');
      return archiveName(title);
    }
    const meta = FORMAT_META[this.target];
    return `${(conv.title ?? 'chat').replace(/[\\/:*?"<>|]/g, '_')}.${meta.extension}`;
  }

  private async convert(): Promise<void> {
    if (!this.imported || this.phase === 'converting') return;
    const client = this.worker();
    const fileName = this.suggestedName();
    const exportOptions = { order: this.order, whatsapp: this.whatsappOptions(), ...(this.edits.title ? { title: this.edits.title } : {}) };
    this.result = undefined;

    if (!isPackage(this.target)) {
      this.phase = 'converting';
      this.render();
      try {
        const res = await client.call({ action: 'export', importId: this.importId, edits: this.effectiveEdits(), target: this.target, exportOptions });
        if (res.ok && res.action === 'export') {
          const file = res.artifact.files[0];
          if (file) {
            const blob = new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: res.artifact.mime });
            const url = URL.createObjectURL(blob);
            const a = h('a', { href: url, download: res.artifact.suggestedName || fileName });
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
          }
          this.result = { fileName: res.artifact.suggestedName || fileName, report: res.report, warnings: res.warnings };
          this.phase = 'done';
          this.emit('cc-converted', { target: this.target, fileName: this.result.fileName });
        }
      } catch (e) {
        this.phase = 'error';
        this.error = e instanceof Error ? e.message : String(e);
      }
      this.render();
      return;
    }

    // Packages stream into a file: a picked file in Chromium (asked for inside this click), OPFS elsewhere.
    let destination: { kind: 'handle'; handle: FileSystemFileHandle } | { kind: 'opfs'; name: string };
    if (canPickSaveFile()) {
      const handle = await pickSaveFile(fileName);
      if (!handle) return;
      destination = { kind: 'handle', handle };
    } else {
      destination = { kind: 'opfs', name: `chat-converter-${Date.now()}.zip` };
    }
    this.phase = 'converting';
    this.progress = { entries: 0, bytes: 0, total: this.estimateTotal() };
    const id = client.nextId();
    this.runningId = id;
    this.render();
    try {
      const res = await client.call(
        {
          action: 'package',
          importId: this.importId,
          edits: this.effectiveEdits(),
          target: this.target,
          exportOptions,
          destination: destination as never,
        },
        (entries, bytes) => {
          this.progress.entries = entries;
          this.progress.bytes = bytes;
          this.renderProgress();
        },
        id,
      );
      if (res.ok && res.action === 'package') {
        this.result = {
          fileName: res.summary.suggestedName,
          report: res.report,
          warnings: res.warnings,
          summary: res.summary,
          archiveBytes: res.archiveBytes,
          ...(res.opfsName ? { opfsName: res.opfsName } : {}),
        };
        if (res.opfsName) await downloadFromOpfs(res.opfsName, res.summary.suggestedName);
        this.phase = 'done';
        this.emit('cc-converted', { target: this.target, fileName: res.summary.suggestedName, summary: res.summary });
      }
    } catch (e) {
      this.phase = 'error';
      this.error = e instanceof Error && e.name === 'AbortError' ? 'Conversion cancelled.' : e instanceof Error ? e.message : String(e);
    }
    this.runningId = '';
    this.render();
  }

  private cancel(): void {
    if (!this.runningId || !this.client) return;
    void this.client.call({ action: 'cancel', requestId: this.runningId }).catch(() => undefined);
  }

  private estimateTotal(): number {
    const conv = this.getConversation();
    if (!conv) return 0;
    return conv.messages.reduce((n, m) => n + (m.attachments ?? []).reduce((s, a) => s + (a.present ? (a.size ?? 0) : 0), 0), 0);
  }

  private startOver(): void {
    if (this.importId && this.client) void this.client.call({ action: 'release', importId: this.importId }).catch(() => undefined);
    this.phase = 'empty';
    this.imported = undefined;
    this.importId = '';
    this.entries = [];
    this.result = undefined;
    this.edits = {};
    this.list = undefined;
    this.render();
  }

  private changed = debounce(() => {
    this.refreshPreview();
    this.renderHeader();
    if (this.tab === 'output') void this.renderOutput();
    this.emit('cc-change', { messages: this.getConversation()?.messages.length ?? 0 });
  }, 120);

  // ---------------------------------------------------------------- render

  private render(): void {
    if (this.phase === 'empty' || this.phase === 'reading' || (this.phase === 'error' && !this.imported)) {
      this.list = undefined;
      replace(this.root, this.renderDrop());
      return;
    }
    replace(
      this.root,
      h('section', { class: 'cc-work' },
        h('div', { class: 'cc-head', 'data-part': 'head' }),
        h('div', { class: 'cc-grid' },
          h('aside', { class: 'cc-side' }, this.renderDetails(), this.renderConvert(), this.renderResult()),
          h('main', { class: 'cc-card cc-preview' }, this.renderTabs(), h('div', { class: 'cc-preview__body', 'data-part': 'body' })),
        ),
      ),
    );
    this.renderHeader();
    this.renderTabBody();
  }

  private renderDrop(): HTMLElement {
    const folder = h('input', { type: 'file', hidden: true, webkitdirectory: true, multiple: true });
    const files = h('input', { type: 'file', hidden: true, multiple: true, accept: '.zip,.json,.html,.txt' });
    folder.addEventListener('change', () => void this.load(entriesFromFileList(folder.files ?? []), dropName(entriesFromFileList(folder.files ?? []))));
    files.addEventListener('change', () => void this.load(entriesFromFileList(files.files ?? []), dropName(entriesFromFileList(files.files ?? []))));
    const zone = h('div', { class: 'cc-dropzone', tabindex: 0, role: 'button', 'aria-label': 'Drop a chat export here or choose files' },
      h('div', { class: 'cc-dropzone__icon', 'aria-hidden': 'true' }, '⇣'),
      h('h2', { class: 'cc-dropzone__title' }, this.phase === 'reading' ? 'Reading the export…' : 'Drop a chat export'),
      h('p', { class: 'cc-dropzone__text' },
        'A Telegram Desktop export folder (HTML, JSON or both, with its media folders), a WhatsApp export (.zip or _chat.txt), or a UniversalChat package. Several exports at once are fine.'),
      h('div', { class: 'cc-row cc-row--center' },
        h('button', { class: 'cc-btn cc-btn--primary', type: 'button', onclick: () => folder.click(), disabled: this.phase === 'reading' }, 'Choose a folder'),
        h('button', { class: 'cc-btn', type: 'button', onclick: () => files.click(), disabled: this.phase === 'reading' }, 'Choose files'),
      ),
      h('p', { class: 'cc-hint' }, 'Everything is read and converted on this device. Nothing is uploaded.'),
      folder,
      files,
      this.phase === 'reading' ? h('div', { class: 'cc-bar cc-bar--busy', 'aria-label': 'Reading' }, h('i')) : null,
      this.phase === 'error' ? h('div', { class: 'cc-alert cc-alert--error', role: 'alert' }, this.error) : null,
    );
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('is-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('is-over');
      if (!e.dataTransfer) return;
      // entriesFromDataTransfer takes the entries synchronously, as the drop event requires.
      void entriesFromDataTransfer(e.dataTransfer).then((entries) => this.load(entries, dropName(entries)));
    });
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        folder.click();
      }
    });
    return h('section', { class: 'cc-drop' }, zone);
  }

  private renderHeader(): void {
    const head = this.root.querySelector<HTMLElement>('[data-part="head"]');
    if (!head || !this.imported) return;
    const conv = this.imported;
    const att = conv.messages.flatMap((m) => m.attachments ?? []);
    const present = att.filter((a) => a.present).length;
    const bounds = dateBounds(conv);
    const format = String(conv.meta?.['exportFormat'] ?? '');
    const included = this.getConversation()?.messages.length ?? 0;
    const chip = (text: string, tone = ''): HTMLElement => h('span', { class: `cc-chip ${tone}` }, text);
    replace(
      head,
      h('div', { class: 'cc-head__line' },
        h('p', { class: 'cc-head__title' },
          'Imported from ', h('strong', {}, this.detected === 'telegram' ? 'Telegram Desktop' : this.detected === 'whatsapp' ? 'WhatsApp' : this.detected),
          format ? ` (${format.toUpperCase()})` : '',
          ' · ', h('strong', {}, formatCount(conv.messages.length)), ' messages · ', formatCount(conv.participants.length), ' participants'),
        h('button', { class: 'cc-link', type: 'button', onclick: () => this.startOver() }, '← Start over'),
      ),
      h('div', { class: 'cc-chips' },
        this.exportsFound.length > 1 ? this.renderExportPicker() : chip(this.sourceName || this.dropLabel),
        bounds ? chip(`${formatDay(bounds.min, this.timeZone)} → ${formatDay(bounds.max, this.timeZone)}`) : null,
        chip(`${formatCount(present)} of ${formatCount(att.length)} media files in the export`, present === att.length ? 'is-ok' : 'is-warn'),
        included !== conv.messages.length ? chip(`${formatCount(included)} included`, 'is-accent') : null,
        chip(`Times: ${this.timeZone}`),
      ),
      this.warnings.length
        ? h('details', { class: 'cc-warnings', open: true },
            h('summary', {}, `${this.warnings.length} note${this.warnings.length > 1 ? 's' : ''} about this export`),
            h('ul', {}, this.warnings.map((w) => h('li', {}, w))))
        : null,
    );
  }

  private renderExportPicker(): HTMLElement {
    const select = h('select', { class: 'cc-field cc-field--inline', 'aria-label': 'Export to use' },
      this.exportsFound.map((name, i) => h('option', { value: i, selected: i === this.exportIndex }, name)));
    select.addEventListener('change', () => {
      this.exportIndex = Number(select.value);
      void this.runImport();
    });
    return h('label', { class: 'cc-chip is-accent' }, `${this.exportsFound.length} exports: `, select);
  }

  private renderDetails(): HTMLElement {
    const conv = this.imported!;
    const counts = participantMessageCounts(conv);
    const bounds = dateBounds(conv);
    const title = h('input', { class: 'cc-field', value: this.edits.title ?? conv.title ?? '', placeholder: 'Conversation title' });
    title.addEventListener('input', () => {
      this.edits = { ...this.edits, title: title.value };
      this.changed();
    });

    const modeSeg = this.segmented(
      [['dm', 'Private chat'], ['group', 'Group']],
      this.mode,
      (v) => {
        this.mode = v as 'dm' | 'group';
        this.changed();
      },
      'Chat type',
    );

    const people = h('div', { class: 'cc-people' },
      conv.participants.map((p) => {
        const input = h('input', { class: 'cc-field', value: this.edits.renames?.[p.id] ?? '', placeholder: p.displayName ?? p.id, 'aria-label': `Name for ${p.displayName ?? p.id}` });
        input.addEventListener('input', () => {
          const renames = { ...this.edits.renames };
          if (input.value.trim()) renames[p.id] = input.value;
          else delete renames[p.id];
          this.edits = { ...this.edits, renames };
          this.changed();
        });
        const me = h('input', { type: 'radio', name: `cc-self-${this.importId}`, checked: this.selfId === p.id, 'aria-label': `${p.displayName ?? p.id} is you` });
        me.addEventListener('change', () => {
          this.selfId = p.id;
          this.changed();
        });
        return h('div', { class: 'cc-person' },
          input,
          h('label', { class: 'cc-person__me', title: 'This is me' }, me, 'Me'),
          h('span', { class: 'cc-person__count' }, `${formatCount(counts[p.id] ?? 0)} msg`),
          p.meta?.['deletedAccount'] ? h('span', { class: 'cc-badge', title: 'Telegram exports a deleted account without a name' }, 'deleted') : null,
        );
      }),
    );

    const from = h('input', { type: 'date', class: 'cc-field', 'aria-label': 'From' });
    const to = h('input', { type: 'date', class: 'cc-field', 'aria-label': 'To' });
    if (bounds) {
      const min = dateInput(bounds.min, this.timeZone);
      const max = dateInput(bounds.max, this.timeZone);
      for (const el of [from, to]) {
        el.min = min;
        el.max = max;
      }
      from.value = this.edits.dateFrom !== undefined ? dateInput(this.edits.dateFrom, this.timeZone) : min;
      to.value = this.edits.dateTo !== undefined ? dateInput(this.edits.dateTo, this.timeZone) : max;
    }
    const onRange = (): void => {
      const parse = (v: string, end: boolean): number | undefined => {
        const [y, m, d] = v.split('-').map(Number);
        if (!y || !m || !d) return undefined;
        return zonedTimeToUtc({ year: y, month: m, day: d, hour: end ? 23 : 0, minute: end ? 59 : 0, second: end ? 59 : 0 }, this.timeZone) + (end ? 999 : 0);
      };
      const next: Edits = { ...this.edits };
      const f = parse(from.value, false);
      const t = parse(to.value, true);
      if (bounds && f !== undefined && f > bounds.min) next.dateFrom = f;
      else delete next.dateFrom;
      if (bounds && t !== undefined && t < bounds.max) next.dateTo = t;
      else delete next.dateTo;
      this.edits = next;
      this.changed();
    };
    from.addEventListener('change', onRange);
    to.addEventListener('change', onRange);

    const zone = h('select', { class: 'cc-field', 'aria-label': 'Time zone' },
      supportedZones().map((z) => h('option', { value: z, selected: z === this.timeZone }, z)));
    zone.addEventListener('change', () => {
      this.timeZone = zone.value;
      // HTML and WhatsApp exports carry wall-clock times: the zone decides the instants, so read again.
      const fmt = this.imported?.meta?.['exportFormat'];
      if (fmt === 'html' || this.detected === 'whatsapp') void this.runImport();
      else this.render();
    });

    const orderSeg = this.segmented(
      [['source', 'As exported'], ['oldest-first', 'Oldest first'], ['newest-first', 'Newest first']],
      this.order,
      (v) => {
        this.order = v as MessageOrder;
        this.list?.reset(0);
        this.changed();
      },
      'Message order',
    );

    const reset = h('button', { class: 'cc-link', type: 'button', disabled: Object.keys(this.edits).length === 0 }, 'Reset');
    reset.addEventListener('click', () => {
      this.edits = {};
      this.render();
      this.changed();
    });

    return h('div', { class: 'cc-card' },
      h('div', { class: 'cc-card__head' }, h('h3', {}, 'Details'), reset),
      this.field('Title', title),
      this.field('Type', modeSeg),
      this.field('Participants', people, 'Rename anyone; “Me” marks your own messages (they sit on the right, and WhatsApp-format exports are written from your side).'),
      bounds ? this.field('Date range', h('div', { class: 'cc-row' }, from, h('span', { class: 'cc-muted' }, 'to'), to)) : null,
      this.field('Time zone', zone, 'The zone the times are shown and written in.'),
      this.field('Order', orderSeg, 'WhatsApp-format packages always keep the export’s own order.'),
    );
  }

  private renderConvert(): HTMLElement {
    const groups = GROUPS.map((g) => ({ ...g, formats: g.formats.filter((f) => f in FORMAT_META) })).filter((g) => g.formats.length);
    const cards = groups.map((g) =>
      h('div', { class: 'cc-targets' },
        h('p', { class: 'cc-label' }, g.label),
        g.formats.map((f) => {
          const meta = FORMAT_META[f as ExportFormatId];
          const btn = h('button', { class: 'cc-target', type: 'button', role: 'radio', 'aria-checked': String(this.target === f) },
            h('span', { class: 'cc-target__name' }, meta.label),
            h('span', { class: 'cc-target__note' }, TARGET_NOTES[f] ?? ''));
          btn.addEventListener('click', () => {
            this.target = f as ExportFormatId;
            this.render();
          });
          return btn;
        }),
      ),
    );

    const wa = isPackage(this.target) || this.target === 'whatsapp-txt';
    const toggles: Array<[keyof WhatsAppPackageOptions, string, boolean]> = [
      ['serviceAsText', 'Calls, pins and other events as text lines', true],
      ['omittedMarkers', 'Mark media that is not in the export (“image omitted”)', true],
      ['replyQuotes', 'Quote the message a reply answers', false],
      ['forwardLabels', 'Label forwarded messages', false],
      ['editedMarker', 'Mark edited messages', this.target === 'whatsapp-zip'],
      ['noticeLine', 'Start with WhatsApp’s encryption notice (Telegram reads it)', true],
    ];
    const options = wa
      ? h('details', { class: 'cc-options' },
          h('summary', {}, 'Options'),
          toggles.map(([key, label, dflt]) => {
            const box = h('input', { type: 'checkbox', class: 'cc-switch', checked: (this.options[key] as boolean | undefined) ?? dflt });
            box.addEventListener('change', () => {
              (this.options as Record<string, unknown>)[key] = box.checked;
              this.changed();
            });
            return h('label', { class: 'cc-toggle' }, box, label);
          }),
          (() => {
            const box = h('input', { type: 'checkbox', class: 'cc-switch', checked: this.options.animatedStickers === 'file' });
            box.addEventListener('change', () => {
              this.options.animatedStickers = box.checked ? 'file' : 'omit';
              this.changed();
            });
            return h('label', { class: 'cc-toggle' }, box, 'Attach animated stickers as files');
          })(),
        )
      : null;

    const busy = this.phase === 'converting';
    const go = h('button', { class: 'cc-btn cc-btn--primary cc-btn--block', type: 'button', disabled: busy },
      busy ? 'Converting…' : isPackage(this.target) ? 'Convert & save .zip' : 'Convert & download');
    go.addEventListener('click', () => void this.convert());

    return h('div', { class: 'cc-card' },
      h('div', { class: 'cc-card__head' }, h('h3', {}, 'Convert to')),
      cards,
      options,
      go,
      busy && isPackage(this.target) ? this.progressBlock() : null,
      this.phase === 'error' ? h('div', { class: 'cc-alert cc-alert--error', role: 'alert' }, this.error) : null,
      this.actions.length ? h('div', { class: 'cc-host-actions' }, this.actions) : null,
    );
  }

  private progressBlock(): HTMLElement {
    const cancel = h('button', { class: 'cc-link', type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => this.cancel());
    return h('div', { class: 'cc-progress', 'data-part': 'progress' },
      h('div', { class: 'cc-bar' }, h('i', { style: 'width:0%' })),
      h('p', { class: 'cc-muted', 'data-part': 'progress-text' }, 'Starting…'),
      cancel,
    );
  }

  private renderProgress(): void {
    const bar = this.root.querySelector<HTMLElement>('[data-part="progress"] .cc-bar > i');
    const text = this.root.querySelector<HTMLElement>('[data-part="progress-text"]');
    const pct = this.progress.total > 0 ? Math.min(100, (this.progress.bytes / this.progress.total) * 100) : 0;
    if (bar) bar.style.width = `${pct.toFixed(1)}%`;
    if (text) text.textContent = `${formatCount(this.progress.entries)} files · ${formatBytes(this.progress.bytes)} written`;
  }

  private renderResult(): HTMLElement | null {
    const r = this.result;
    if (!r || this.phase !== 'done') return null;
    const s = r.summary;
    const target = importTarget(this.target);
    const counts = (rec: Record<string, number>, tone: string) =>
      Object.entries(rec).map(([k, n]) => h('span', { class: `cc-chip ${tone}` }, `${k}: ${formatCount(n)}`));
    return h('div', { class: 'cc-card cc-result', role: 'status' },
      h('div', { class: 'cc-card__head' }, h('h3', {}, 'Done')),
      h('p', { class: 'cc-result__file' }, r.fileName, r.archiveBytes ? ` · ${formatBytes(r.archiveBytes)}` : ''),
      s
        ? h('dl', { class: 'cc-kv' },
            h('dt', {}, 'Messages'), h('dd', { class: s.messagesOut === s.messagesIn ? 'is-ok' : 'is-warn' }, `${formatCount(s.messagesOut)} of ${formatCount(s.messagesIn)}`),
            h('dt', {}, 'Media files'), h('dd', {}, `${formatCount(s.mediaWritten)} written`),
            h('dt', {}, 'Omitted markers'), h('dd', {}, formatCount(s.mediaOmitted)))
        : null,
      s && Object.keys(s.dropped).length ? h('div', { class: 'cc-chips' }, h('span', { class: 'cc-label' }, 'Not carried by this format'), counts(s.dropped, 'is-warn')) : null,
      s && Object.keys(s.approximated).length ? h('div', { class: 'cc-chips' }, h('span', { class: 'cc-label' }, 'Rewritten to fit'), counts(s.approximated, '')) : null,
      r.warnings.length ? h('ul', { class: 'cc-notes' }, r.warnings.map((w) => h('li', {}, w))) : null,
      target
        ? h('div', { class: 'cc-howto' },
            h('p', { class: 'cc-label' }, `How to import — ${target.app} ${target.client}`),
            h('ol', {}, target.steps.map((st) => h('li', {}, st))),
            h('ul', { class: 'cc-notes' }, target.limits.map((l) => h('li', {}, l))),
            target.sources.length
              ? h('p', { class: 'cc-muted' }, 'Read from: ', target.sources.flatMap((src, i) => [i ? ' · ' : '', h('a', { href: src.url, target: '_blank', rel: 'noopener noreferrer' }, src.label)]))
              : null)
        : null,
      r.opfsName
        ? h('button', { class: 'cc-btn', type: 'button', onclick: () => void downloadFromOpfs(r.opfsName!, r.fileName) }, 'Download again')
        : null,
    );
  }

  private renderTabs(): HTMLElement {
    return this.segmented(
      [['chat', 'Chat'], ['output', 'Output'], ['report', 'Report']],
      this.tab,
      (v) => {
        this.tab = v as typeof this.tab;
        this.renderTabBody();
      },
      'Preview',
    );
  }

  private renderTabBody(): void {
    const body = this.root.querySelector<HTMLElement>('[data-part="body"]');
    if (!body) return;
    if (this.tab === 'chat') {
      const bar = h('div', { class: 'cc-preview__bar', 'data-part': 'preview-bar' });
      const viewport = h('div', { class: 'cc-vl', tabindex: 0, 'aria-label': 'Messages' });
      replace(body, bar, viewport);
      this.list = undefined;
      this.refreshPreview(viewport);
      return;
    }
    this.list = undefined;
    if (this.tab === 'output') {
      replace(body, h('pre', { class: 'cc-output', 'data-part': 'output' }, 'Building the output preview…'));
      void this.renderOutput();
      return;
    }
    replace(body, this.renderReport());
  }

  private async renderOutput(): Promise<void> {
    const pre = this.root.querySelector<HTMLElement>('[data-part="output"]');
    if (!pre || !this.imported) return;
    try {
      const res = await this.worker().call({
        action: 'export',
        importId: this.importId,
        edits: this.effectiveEdits(),
        target: isPackage(this.target) ? this.target : this.target,
        exportOptions: { order: this.order, whatsapp: this.whatsappOptions() },
      });
      if (res.ok && res.action === 'export') {
        const file = res.artifact.files[0];
        const text = file ? new TextDecoder().decode(file.bytes.subarray(0, 200_000)) : '';
        const lines = text.split(/\r?\n/).slice(0, 400);
        pre.textContent = `${file?.name ?? ''}${isPackage(this.target) ? ' (inside the .zip)' : ''}\n${'─'.repeat(40)}\n${lines.join('\n')}${text.length >= 200_000 || lines.length >= 400 ? '\n…' : ''}`;
      }
    } catch (e) {
      pre.textContent = e instanceof Error ? e.message : String(e);
    }
  }

  private renderReport(): HTMLElement {
    const r = this.result;
    if (!r) {
      return h('div', { class: 'cc-empty' }, 'Convert once to see what the format kept, rewrote and left out.');
    }
    return h('div', { class: 'cc-report' },
      h('p', { class: 'cc-muted' }, `${formatCount(r.report.stats.messages)} messages · ${formatCount(r.report.stats.participants)} participants · ${formatCount(r.report.stats.attachments)} attachments`),
      r.report.entries.length
        ? h('div', { class: 'cc-chips' }, r.report.entries.map((e) => h('span', { class: `cc-chip is-${e.status}` }, `${e.capability}: ${e.status}${e.count ? ` (${formatCount(e.count)})` : ''}`)))
        : h('p', {}, 'Nothing lost — everything maps to this format.'),
    );
  }

  private refreshPreview(viewport?: HTMLElement): void {
    if (!this.imported || this.tab !== 'chat') return;
    const conv = orderMessages(applyEdits(this.imported, { ...this.edits, removedIds: [] }), this.order);
    this.shown = conv.messages;
    this.names = new Map(conv.participants.map((p) => [p.id, p]));
    const removed = new Set(this.edits.removedIds ?? []);
    const included = this.shown.length - this.shown.filter((m) => removed.has(m.id)).length;
    const bar = this.root.querySelector<HTMLElement>('[data-part="preview-bar"]');
    if (bar) {
      const jump = h('input', { type: 'date', class: 'cc-field cc-field--inline', 'aria-label': 'Jump to date' });
      jump.addEventListener('change', () => {
        const [y, m, d] = jump.value.split('-').map(Number);
        if (!y || !m || !d) return;
        const t = zonedTimeToUtc({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, this.timeZone);
        const idx = this.order === 'newest-first' ? this.shown.findIndex((x) => x.ts <= t + 86_399_999) : this.shown.findIndex((x) => x.ts >= t);
        this.list?.scrollToIndex(idx < 0 ? this.shown.length - 1 : idx);
      });
      replace(bar, h('span', {}, `Preview — ${formatCount(included)} of ${formatCount(this.imported.messages.length)} messages included`), h('label', { class: 'cc-muted' }, 'Jump to ', jump));
    }
    const vp = viewport ?? this.root.querySelector<HTMLElement>('.cc-vl') ?? undefined;
    if (!vp) return;
    if (!this.list) this.list = new VirtualList(vp, this.shown.length, (i) => this.bubble(i));
    else this.list.reset(this.shown.length);
  }

  private bubble(i: number): HTMLElement {
    const m = this.shown[i]!;
    const removed = (this.edits.removedIds ?? []).includes(m.id);
    const toggle = h('button', { class: 'cc-bubble__toggle', type: 'button', title: removed ? 'Put back in the output' : 'Leave out of the output' }, removed ? '↺' : '✕');
    toggle.addEventListener('click', () => {
      const set = new Set(this.edits.removedIds ?? []);
      if (set.has(m.id)) set.delete(m.id);
      else set.add(m.id);
      this.edits = { ...this.edits, removedIds: [...set] };
      this.list?.refresh();
      this.changed();
    });
    const time = h('span', { class: 'cc-bubble__time' }, formatDateTime(m, this.timeZone), m.editedAt ? ' · edited' : '');
    if (m.kind === 'service' || m.kind === 'system' || m.kind === 'call') {
      return h('div', { class: `cc-row-wrap cc-center${removed ? ' is-removed' : ''}` },
        h('div', { class: 'cc-event' }, this.richText(m), ' ', time, toggle));
    }
    const p = m.senderId ? this.names.get(m.senderId) : undefined;
    const name = p?.displayName ?? 'Unknown';
    const mine = !!this.selfId && m.senderId === this.selfId;
    return h('div', { class: `cc-row-wrap ${mine ? 'cc-right' : 'cc-left'}${removed ? ' is-removed' : ''}` },
      h('div', { class: `cc-bubble${mine ? ' is-mine' : ''}` },
        h('div', { class: 'cc-bubble__who', style: `--who-hue:${hue(name)}` }, name, m.viaBot ? h('span', { class: 'cc-muted' }, ` via ${m.viaBot}`) : null),
        m.forwardedFrom ? h('div', { class: 'cc-bubble__meta' }, `↪ Forwarded from ${m.forwardedFrom.name ?? 'someone'}`) : null,
        m.replyToId ? h('div', { class: 'cc-bubble__meta' }, '↩ Reply') : null,
        this.mediaBlock(m),
        m.poll || m.checklist || m.location || m.contact ? null : h('div', { class: 'cc-bubble__text' }, this.richText(m)),
        m.reactions?.length ? h('div', { class: 'cc-bubble__reactions' }, m.reactions.map((r) => `${r.emoji}${r.count && r.count > 1 ? ` ${r.count}` : ''}`).join('  ')) : null,
        time,
        toggle,
      ),
    );
  }

  private mediaBlock(m: Message): HTMLElement | null {
    const parts: HTMLElement[] = [];
    for (const a of m.attachments ?? []) {
      const state = a.present ? 'is-ok' : a.omitted === 'missing' ? 'is-error' : 'is-warn';
      const label = a.present ? 'in export' : a.omitted === 'not_included' ? 'not exported' : a.omitted === 'too_large' ? 'over size limit' : a.omitted === 'missing' ? 'missing' : 'unavailable';
      const kind = a.kind === 'sticker' && a.stickerFormat && a.stickerFormat !== 'webp' ? `${a.stickerFormat} sticker` : a.kind;
      parts.push(
        h('div', { class: `cc-media ${state}` },
          h('span', { 'aria-hidden': 'true' }, KIND_ICON[a.kind] ?? '📎'),
          h('span', {}, `${kind}${a.emoji ? ` ${a.emoji}` : ''}`),
          a.fileName ? h('span', { class: 'cc-media__name' }, a.fileName) : null,
          a.size ? h('span', { class: 'cc-muted' }, formatBytes(a.size)) : null,
          h('span', { class: 'cc-media__state' }, label)),
      );
    }
    if (m.poll) parts.push(h('div', { class: 'cc-media' }, `📊 ${m.poll.question}`, h('ul', {}, m.poll.options.map((o) => h('li', {}, `${o.text}${o.votes !== undefined ? ` — ${o.votes}` : ''}${o.chosen ? ' ✓' : ''}`)))));
    if (m.checklist) parts.push(h('div', { class: 'cc-media' }, `☑️ ${m.checklist.title}`, h('ul', {}, m.checklist.items.map((it) => h('li', {}, it.text)))));
    if (m.location) parts.push(h('div', { class: 'cc-media' }, `📍 ${m.location.live ? 'Live location ' : ''}${[m.location.name, m.location.address].filter(Boolean).join(', ')} (${m.location.lat}, ${m.location.lng})`));
    if (m.contact) parts.push(h('div', { class: 'cc-media' }, `👤 ${[m.contact.firstName, m.contact.lastName].filter(Boolean).join(' ')}${m.contact.phone ? ` · ${m.contact.phone}` : ''}${m.contact.vcardRef ? ' · vCard' : ''}`));
    return parts.length ? h('div', { class: 'cc-bubble__media' }, parts) : null;
  }

  private richText(m: Message): Node {
    const span = h('span', {});
    if (!m.content) return span;
    for (const seg of segmentRichText(m.content)) {
      let node: Node = document.createTextNode(seg.text);
      for (const t of seg.types) {
        const tag = t === 'bold' ? 'strong' : t === 'italic' ? 'em' : t === 'underline' ? 'u' : t === 'strikethrough' ? 's' : t === 'code' || t === 'pre' ? 'code' : t === 'spoiler' ? 'mark' : null;
        if (tag) {
          const el = document.createElement(tag);
          el.append(node);
          node = el;
        } else if (t === 'link' && seg.url && /^https?:/i.test(seg.url)) {
          const a = h('a', { href: seg.url, target: '_blank', rel: 'noopener noreferrer' });
          a.append(node);
          node = a;
        }
      }
      span.append(node);
    }
    return span;
  }

  // ---------------------------------------------------------------- small widgets

  private field(label: string, control: Node, hint?: string): HTMLElement {
    return h('div', { class: 'cc-fieldset' }, h('span', { class: 'cc-label' }, label), control, hint ? h('span', { class: 'cc-hint' }, hint) : null);
  }

  private segmented(items: Array<[string, string]>, value: string, onPick: (v: string) => void, label: string): HTMLElement {
    const seg = h('div', { class: 'cc-seg', role: 'radiogroup', 'aria-label': label });
    for (const [v, text] of items) {
      const b = h('button', { class: 'cc-seg__item', type: 'button', role: 'radio', 'aria-checked': String(v === value) }, text);
      b.addEventListener('click', () => {
        for (const other of seg.children) other.setAttribute('aria-checked', 'false');
        b.setAttribute('aria-checked', 'true');
        onPick(v);
      });
      seg.append(b);
    }
    return seg;
  }
}

export function defineChatConverter(tag = 'chat-converter-app'): void {
  if (!customElements.get(tag)) customElements.define(tag, ChatConverterElement);
}
