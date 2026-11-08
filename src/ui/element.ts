import type { BlobEntry } from '../sources/blob';
import type { Conversation, ExportFormatId, FidelityReport, Message, Participant, PlatformId } from '../model';
import { FORMAT_META, PLATFORM_META, packageFormatIds } from '../model';
import type { ExportOptions, PackageSummary, WhatsAppPackageOptions } from '../engine/contracts';
import type { BatchFile } from '../engine/batch';
import { batchFileName } from '../engine/batch-name';
import type { ArchiveSummary, ConversationSummary, SearchHit } from '../engine/summary';
import { applyEdits, dateBounds, orderMessages, participantMessageCounts, type Edits, type MessageOrder } from '../engine/transforms';
import { segmentRichText } from '../engine/richtext';
import { defaultTimeZone, zonedTimeToUtc } from '../engine/time';
import { archiveName, guessSelf } from '../exporters/whatsapp-format';
import { importTarget } from '../targets/index';
import {
  canPickSaveFile,
  clearOpfsOutputs,
  downloadFromOpfs,
  dropName,
  entriesFromDataTransfer,
  entriesFromFileList,
  isSafari,
  pickSaveFile,
  startStreamedDownload,
  type StreamedDownload,
} from '../browser/index';
import { ConverterClient, defaultWorker } from './client';
import { debounce, h, replace } from './dom';
import { dateInput, formatBytes, formatCount, formatDateTime, formatDay, hue } from './format';
import { VirtualList } from './virtual-list';
import { filterRows, folderCounts, folderLabel, INBOX_DEFAULTS, renderHit, renderRow, type InboxState } from './inbox';

type Phase = 'empty' | 'reading' | 'ready' | 'converting' | 'done' | 'error';

interface Result {
  fileName: string;
  report: FidelityReport;
  warnings: string[];
  summary?: PackageSummary;
  archiveBytes?: number;
  opfsName?: string;
  streamed?: boolean;
}

/** Where a package is written; `port` is a streamed download (download-sw.js). */
type Destination =
  | { kind: 'handle'; handle: FileSystemFileHandle }
  | { kind: 'opfs'; name: string }
  | { kind: 'port'; port: MessagePort };

interface BatchOutcome {
  fileName: string;
  layout: 'universalchat' | 'zip-of-files';
  conversations: number;
  messagesIn: number;
  messagesOut: number;
  mediaWritten: number;
  files: BatchFile[];
  warnings: string[];
  archiveBytes: number;
  opfsName?: string;
  streamed?: boolean;
}

/** What the user set on one conversation of an archive, kept while they move between conversations. */
interface ChatState {
  edits: Edits;
  selfId: string | undefined;
  mode: 'dm' | 'group';
}

/** "dyi-html" → "HTML", "snapchat-json" → "JSON", "html" → "HTML". */
function variantLabel(format: string): string {
  const tail = format.split('-').pop() ?? format;
  return tail.toUpperCase();
}

function platformLabel(id: string): string {
  if (id === 'telegram') return 'Telegram Desktop';
  return PLATFORM_META[id as PlatformId]?.label ?? id;
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
 * `<chat-converter-app>`: drop an export, edit the details, preview it, convert it. An export holding many
 * conversations (Instagram, Messenger, Snapchat…) opens on an inbox: search, filter, open one, or select
 * several and convert them together.
 *
 * Host hooks (ChatForge uses them for "Save to Vault"):
 * - children with `slot="actions"` are moved into the convert panel;
 * - `getConversation()` returns the edited conversation;
 * - events: `cc-imported`, `cc-change`, `cc-converted` (bubbling, composed).
 * - `workerFactory` can replace the bundled worker.
 */
/** Above this size, a browser without a save dialog shows a notice before it builds a package. */
const LARGE_WITHOUT_PICKER = 2 * 1024 ** 3;

function largeNotice(bytes: number): string {
  return `This package will be about ${formatBytes(bytes)}. This browser cannot write a file straight to disk, so the converter builds it in this site's browser storage first (${formatBytes(bytes)} of disk) and then hands it to your downloads; Safari has cancelled that hand-off for packages of several GB. Chrome and Edge write straight into the file you pick.`;
}

const SAFARI_UNZIP =
  'Safari unzips downloaded .zip files while “Open safe files after downloading” is on (Safari → Settings → General). Telegram needs the .zip itself, so turn that setting off before converting.';

/** Report words, matching the result panel's headings. */
const STATUS_WORD: Record<string, string> = { preserved: 'kept', approximated: 'rewritten', dropped: 'not carried' };

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
  // Archive (every conversation of the export) and the inbox.
  private archive?: ArchiveSummary;
  private rows: ConversationSummary[] = [];
  private view: 'inbox' | 'chat' = 'chat';
  private current = 0;
  private perChat = new Map<number, ChatState>();
  private selected = new Set<number>();
  private inbox: InboxState = { ...INBOX_DEFAULTS };
  private filtered: ConversationSummary[] = [];
  private inboxList?: VirtualList;
  private hits: SearchHit[] = [];
  private hitsTotal = 0;
  private searching = false;
  private batchTarget: ExportFormatId = 'universalchat-zip';
  private batchResult?: BatchOutcome;
  private batchRunning = false;
  private batchError = '';
  private hitsList?: VirtualList;
  private jumpId?: string;
  private names = new Map<string, Participant>();
  private root!: HTMLDivElement;
  private actions: Node[] = [];
  private largeNoticeFor = 0;

  connectedCallback(): void {
    if (this.root) return;
    this.actions = [...this.children].filter((c) => c.getAttribute('slot') === 'actions');
    for (const a of this.actions) (a as Element).remove();
    this.root = h('div', { class: 'cc' });
    this.append(this.root);
    this.render();
    // Packages from earlier visits still take disk space in this site's browser storage (Safari, Firefox).
    void clearOpfsOutputs().catch(() => 0);
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
      this.detected = res.detectedPlatform;
      this.archiveWarnings = res.warnings;
      this.exportsFound = res.exports;
      this.sourceName = res.sourceName;
      this.archive = res.archive;
      this.rows = res.conversations;
      this.perChat.clear();
      this.selected.clear();
      this.hits = [];
      this.hitsTotal = 0;
      this.batchResult = undefined;
      this.inboxList = undefined;
      this.setConversation(res.index, res.conversation);
      const tz = res.conversation.meta?.['timeZone'];
      if (typeof tz === 'string') this.timeZone = tz;
      this.view = this.rows.length > 1 ? 'inbox' : 'chat';
      this.phase = 'ready';
      this.render();
      this.emit('cc-imported', {
        title: res.conversation.title,
        messages: res.archive.messages,
        conversations: res.archive.conversations,
        platform: res.detectedPlatform,
      });
    } catch (e) {
      this.phase = 'error';
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    }
  }

  private archiveWarnings: string[] = [];

  /** Shows conversation `index`, restoring what the user set on it earlier. */
  private setConversation(index: number, conversation: Conversation): void {
    this.current = index;
    this.imported = conversation;
    const saved = this.perChat.get(index);
    this.edits = saved?.edits ?? {};
    this.selfId = saved ? saved.selfId : guessSelf(conversation);
    this.mode = saved?.mode ?? (conversation.kind === 'dm' ? 'dm' : 'group');
    this.warnings = [...(this.rows.length > 1 ? [] : this.archiveWarnings), ...this.exportWarnings(conversation)];
    this.result = undefined;
    this.list = undefined;
  }

  private saveCurrent(): void {
    if (!this.imported) return;
    this.perChat.set(this.current, { edits: this.edits, selfId: this.selfId, mode: this.mode });
  }

  private async openConversation(index: number, jumpTo?: string): Promise<void> {
    if (!this.importId) return;
    this.saveCurrent();
    try {
      const res = await this.worker().call({ action: 'open', importId: this.importId, index });
      if (!res.ok || res.action !== 'open') return;
      this.setConversation(index, res.conversation);
      this.view = 'chat';
      this.tab = 'chat';
      this.phase = 'ready';
      if (jumpTo) this.jumpId = jumpTo;
      this.render();
      this.emit('cc-opened', { index, title: res.conversation.title, messages: res.conversation.messages.length });
    } catch (e) {
      this.phase = 'error';
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    }
  }

  private backToInbox(): void {
    this.saveCurrent();
    this.view = 'inbox';
    this.list = undefined;
    if (this.phase === 'done' || this.phase === 'error') this.phase = 'ready';
    this.render();
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
    if (c.meta?.['exportFormat'] === 'dyi-html') {
      out.push(`Read from Meta's HTML pages: they show times to the minute and without a zone, so they are read in the ${this.timeZone} zone. Meta's JSON download has exact times.`);
    }
    if (c.meta?.['onlyOwnMessages']) out.push('This app exports only the messages you sent; the other side of the chat is not in the export.');
    const unavailable2 = c.messages.filter((m) => m.meta?.['contentUnavailable']).length;
    if (unavailable2) out.push(`${formatCount(unavailable2)} messages have no content in the export (the app left it out); they are kept, empty.`);
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
        const res = await client.call({ action: 'export', importId: this.importId, conversationIndex: this.current, edits: this.effectiveEdits(), target: this.target, exportOptions });
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

    const picked = await this.packageDestination(fileName, this.estimateTotal());
    if (!picked) return;
    const { destination, transfer, streamed } = picked;
    this.largeNoticeFor = 0;
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
          conversationIndex: this.current,
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
        transfer,
      );
      if (res.ok && res.action === 'package') {
        this.result = {
          fileName: res.summary.suggestedName,
          report: res.report,
          warnings: res.warnings,
          summary: res.summary,
          archiveBytes: res.archiveBytes,
          ...(res.opfsName ? { opfsName: res.opfsName } : {}),
          ...(streamed ? { streamed: true } : {}),
        };
        if (res.opfsName) await downloadFromOpfs(res.opfsName, res.summary.suggestedName);
        this.phase = 'done';
        this.emit('cc-converted', { target: this.target, fileName: res.summary.suggestedName, summary: res.summary });
      }
    } catch (e) {
      this.phase = 'error';
      this.error = e instanceof Error && e.name === 'AbortError' ? 'Conversion cancelled.' : e instanceof Error ? e.message : String(e);
    }
    if (streamed) void streamed.done.catch(() => undefined).finally(() => streamed.dispose());
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

  /**
   * Browsers without a save dialog (Safari, Firefox) build a package in this site's storage, then hand it to the
   * downloads. Above LARGE_WITHOUT_PICKER the first click shows a notice; a second click at the same size goes ahead.
   */
  private confirmLarge(estimate: number): boolean {
    if (canPickSaveFile() || estimate <= LARGE_WITHOUT_PICKER || this.largeNoticeFor === estimate) return true;
    this.largeNoticeFor = estimate;
    this.render();
    return false;
  }

  /**
   * Where a package goes: a picked file in Chromium (asked for inside this click); elsewhere a download streamed
   * through download-sw.js; when that is unavailable, browser storage (OPFS) and then a download. Undefined:
   * stop here (the picker was dismissed, or the size notice is showing).
   */
  private async packageDestination(
    fileName: string,
    estimate: number,
  ): Promise<{ destination: Destination; transfer: Transferable[]; streamed?: StreamedDownload } | undefined> {
    if (canPickSaveFile()) {
      const handle = await pickSaveFile(fileName);
      return handle ? { destination: { kind: 'handle', handle }, transfer: [] } : undefined;
    }
    const streamed = await startStreamedDownload(fileName);
    if (streamed) return { destination: { kind: 'port', port: streamed.port }, transfer: [streamed.port], streamed };
    if (!this.confirmLarge(estimate)) return undefined;
    await clearOpfsOutputs().catch(() => 0);
    return { destination: { kind: 'opfs', name: `chat-converter-${Date.now()}.zip` }, transfer: [] };
  }

  private batchEstimate(): number {
    return this.rows.filter((r) => this.selected.has(r.index)).reduce((s, r) => s + r.media.bytes, 0);
  }

  /** Deletes the package this page left in browser storage (and any older one); "Download again" goes with it. */
  private async removeStored(): Promise<void> {
    await clearOpfsOutputs().catch(() => 0);
    if (this.result) this.result = { ...this.result, opfsName: undefined };
    if (this.batchResult) this.batchResult = { ...this.batchResult, opfsName: undefined };
    this.render();
  }

  private startOver(): void {
    if (this.importId && this.client) void this.client.call({ action: 'release', importId: this.importId }).catch(() => undefined);
    void clearOpfsOutputs().catch(() => 0);
    this.phase = 'empty';
    this.imported = undefined;
    this.importId = '';
    this.entries = [];
    this.result = undefined;
    this.edits = {};
    this.list = undefined;
    this.archive = undefined;
    this.rows = [];
    this.perChat.clear();
    this.selected.clear();
    this.hits = [];
    this.inbox = { ...INBOX_DEFAULTS };
    this.inboxList = undefined;
    this.batchResult = undefined;
    this.view = 'chat';
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
    if (this.view === 'inbox') {
      this.list = undefined;
      this.renderInbox();
      return;
    }
    this.inboxList = undefined;
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
        'A Telegram Desktop export folder (HTML, JSON or both), a WhatsApp export (.zip or _chat.txt), an Instagram, Facebook, Snapchat, VSCO or Hinge data download (.zip or folder), or a UniversalChat package. Several exports at once are fine.'),
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
      this.rows.length > 1
        ? h('div', { class: 'cc-head__line' },
            h('div', { class: 'cc-row' },
              h('button', { class: 'cc-btn', type: 'button', onclick: () => this.backToInbox() }, `← All ${formatCount(this.rows.length)} conversations`),
              this.navButton(-1),
              this.navButton(1),
            ),
            h('button', { class: 'cc-link', type: 'button', onclick: () => this.startOver() }, 'Start over'))
        : null,
      h('div', { class: 'cc-head__line' },
        h('p', { class: 'cc-head__title' },
          this.rows.length > 1 ? h('strong', {}, conv.title ?? 'Conversation') : 'Imported from ',
          this.rows.length > 1 ? ` · ${platformLabel(this.detected)}` : h('strong', {}, platformLabel(this.detected)),
          format ? ` (${variantLabel(format)})` : '',
          ' · ', h('strong', {}, formatCount(conv.messages.length)), ' messages · ', formatCount(conv.participants.length), ' participants'),
        this.rows.length > 1 ? null : h('button', { class: 'cc-link', type: 'button', onclick: () => this.startOver() }, '← Start over'),
      ),
      h('div', { class: 'cc-chips' },
        this.exportsFound.length > 1 ? this.renderExportPicker() : chip(this.sourceName || this.dropLabel),
        bounds ? chip(`${formatDay(bounds.min, this.timeZone)} → ${formatDay(bounds.max, this.timeZone)}`) : null,
        att.length ? chip(`${formatCount(present)} of ${formatCount(att.length)} media files in the export`, present === att.length ? 'is-ok' : 'is-warn') : null,
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
    const large = !busy && isPackage(this.target) && this.largeNoticeFor > 0 && this.largeNoticeFor === this.estimateTotal();
    const go = h('button', { class: 'cc-btn cc-btn--primary cc-btn--block', type: 'button', disabled: busy },
      busy ? 'Converting…' : large ? 'Convert anyway' : isPackage(this.target) ? 'Convert & save .zip' : 'Convert & download');
    go.addEventListener('click', () => void this.convert());

    return h('div', { class: 'cc-card' },
      h('div', { class: 'cc-card__head' }, h('h3', {}, 'Convert to')),
      cards,
      options,
      large ? h('div', { class: 'cc-alert cc-alert--warn', role: 'alert' }, largeNotice(this.largeNoticeFor)) : null,
      isPackage(this.target) && !canPickSaveFile() && isSafari() ? h('div', { class: 'cc-alert cc-alert--warn' }, SAFARI_UNZIP) : null,
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
      r.streamed ? h('p', { class: 'cc-muted' }, 'Written straight into your browser’s downloads.') : null,
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
        ? h('div', { class: 'cc-row' },
            h('button', { class: 'cc-btn', type: 'button', onclick: () => void downloadFromOpfs(r.opfsName!, r.fileName) }, 'Download again'),
            h('button', { class: 'cc-link', type: 'button', onclick: () => void this.removeStored() },
              `Remove from browser storage${r.archiveBytes ? ` (${formatBytes(r.archiveBytes)})` : ''}`))
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
        conversationIndex: this.current,
        edits: this.effectiveEdits(),
        target: this.target,
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
    const asText = (isPackage(this.target) || this.target === 'whatsapp-txt') &&
      r.report.entries.some((e) => e.status === 'dropped' && ['replies', 'forwards', 'edits'].includes(e.capability));
    return h('div', { class: 'cc-report' },
      h('p', { class: 'cc-muted' }, `${formatCount(r.report.stats.messages)} messages · ${formatCount(r.report.stats.participants)} participants · ${formatCount(r.report.stats.attachments)} attachments`),
      r.report.entries.length
        ? h('div', { class: 'cc-chips' }, r.report.entries.map((e) => h('span', { class: `cc-chip is-${e.status}` }, `${e.capability}: ${STATUS_WORD[e.status] ?? e.status}${e.count ? ` (${formatCount(e.count)})` : ''}`)))
        : h('p', {}, 'Nothing lost — everything maps to this format.'),
      r.report.entries.some((e) => e.status !== 'preserved')
        ? h('p', { class: 'cc-muted' }, 'Kept: in the output as it was. Rewritten: in the output in another form. Not carried: the format has no place for it; the messages themselves are still written.')
        : null,
      asText
        ? h('p', { class: 'cc-muted' }, 'WhatsApp’s format has no replies, forwards or edit marks. To keep them as text, switch on “Quote the message a reply answers”, “Label forwarded messages” and “Mark edited messages”, then convert again.')
        : null,
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
    if (this.jumpId) {
      const at = this.shown.findIndex((m) => m.id === this.jumpId);
      if (at >= 0) requestAnimationFrame(() => this.list?.scrollToIndex(at));
      const id = this.jumpId;
      setTimeout(() => {
        if (this.jumpId === id) {
          this.jumpId = undefined;
          this.list?.refresh();
        }
      }, 2600);
    }
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
    const jump = m.id === this.jumpId ? ' is-jump' : '';
    if (m.kind === 'service' || m.kind === 'system' || m.kind === 'call') {
      return h('div', { class: `cc-row-wrap cc-center${removed ? ' is-removed' : ''}${jump}` },
        h('div', { class: 'cc-event' }, this.richText(m), ' ', time, toggle));
    }
    const p = m.senderId ? this.names.get(m.senderId) : undefined;
    const name = p?.displayName ?? 'Unknown';
    const mine = !!this.selfId && m.senderId === this.selfId;
    return h('div', { class: `cc-row-wrap ${mine ? 'cc-right' : 'cc-left'}${removed ? ' is-removed' : ''}${jump}` },
      h('div', { class: `cc-bubble${mine ? ' is-mine' : ''}` },
        h('div', { class: 'cc-bubble__who', style: `--who-hue:${hue(name)}` }, name, m.viaBot ? h('span', { class: 'cc-muted' }, ` via ${m.viaBot}`) : null),
        m.forwardedFrom ? h('div', { class: 'cc-bubble__meta' }, `↪ Forwarded from ${m.forwardedFrom.name ?? 'someone'}`) : null,
        m.replyToId ? h('div', { class: 'cc-bubble__meta' }, '↩ Reply') : null,
        this.mediaBlock(m),
        m.poll || m.checklist || m.location || m.contact ? null : h('div', { class: 'cc-bubble__text' }, this.richText(m)),
        m.meta?.['contentUnavailable'] ? h('div', { class: 'cc-bubble__meta' }, 'Not in the export') : null,
        m.meta?.['snap'] ? h('div', { class: 'cc-bubble__meta' }, 'Snap') : null,
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

  // ---------------------------------------------------------------- inbox

  /** Previous/next conversation in the inbox's current order. */
  private navButton(step: -1 | 1): HTMLElement {
    const order = this.filtered.length ? this.filtered : filterRows(this.rows, this.inbox);
    const at = order.findIndex((r) => r.index === this.current);
    const next = at >= 0 ? order[at + step] : undefined;
    return h('button', {
      class: 'cc-btn',
      type: 'button',
      disabled: !next,
      title: next ? next.title : '',
      'aria-label': step < 0 ? 'Previous conversation' : 'Next conversation',
      onclick: () => next && void this.openConversation(next.index),
    }, step < 0 ? '‹' : '›');
  }

  private renderInbox(): void {
    const a = this.archive!;
    const chip = (text: string, tone = ''): HTMLElement => h('span', { class: `cc-chip ${tone}` }, text);
    const zone = h('select', { class: 'cc-field cc-field--inline', 'aria-label': 'Time zone' },
      supportedZones().map((z) => h('option', { value: z, selected: z === this.timeZone }, z)));
    zone.addEventListener('change', () => {
      this.timeZone = zone.value;
      void this.runImport();
    });
    replace(
      this.root,
      h('section', { class: 'cc-work' },
        h('div', { class: 'cc-head' },
          h('div', { class: 'cc-head__line' },
            h('p', { class: 'cc-head__title' },
              'Imported from ', h('strong', {}, platformLabel(this.detected)),
              a.variant ? ` (${variantLabel(a.variant)})` : '',
              ' · ', h('strong', {}, formatCount(a.conversations)), ' conversations · ', h('strong', {}, formatCount(a.messages)), ' messages'),
            h('button', { class: 'cc-link', type: 'button', onclick: () => this.startOver() }, '← Start over'),
          ),
          h('div', { class: 'cc-chips' },
            this.exportsFound.length > 1 ? this.renderExportPicker() : chip(this.sourceName || this.dropLabel),
            a.firstTs && a.lastTs ? chip(`${formatDay(a.firstTs, this.timeZone)} → ${formatDay(a.lastTs, this.timeZone)}`) : null,
            a.media.total ? chip(`${formatCount(a.media.present)} of ${formatCount(a.media.total)} media files in the export`, a.media.present === a.media.total ? 'is-ok' : 'is-warn') : null,
            h('label', { class: 'cc-chip' }, 'Times: ', zone),
          ),
          this.archiveWarnings.length
            ? h('details', { class: 'cc-warnings', open: true },
                h('summary', {}, `${this.archiveWarnings.length} note${this.archiveWarnings.length > 1 ? 's' : ''} about this export`),
                h('ul', {}, this.archiveWarnings.map((w) => h('li', {}, w))))
            : null,
        ),
        h('div', { class: 'cc-grid cc-grid--inbox' },
          h('main', { class: 'cc-card cc-inbox' }, this.renderInboxTools(), h('div', { class: 'cc-inbox__status', 'data-part': 'inbox-status' }), h('div', { class: 'cc-vl cc-vl--inbox', 'data-part': 'inbox-list', tabindex: 0, 'aria-label': 'Conversations' })),
          h('aside', { class: 'cc-side', 'data-part': 'batch' }),
        ),
      ),
    );
    this.inboxList = undefined;
    this.hitsList = undefined;
    this.refreshInbox();
    this.renderBatch();
  }

  private renderInboxTools(): HTMLElement {
    const search = h('input', {
      type: 'search',
      class: 'cc-field',
      value: this.inbox.query,
      placeholder: this.inbox.scope === 'chats' ? `Search ${formatCount(this.rows.length)} conversations` : 'Search every message',
      'aria-label': 'Search',
    });
    const runSearch = debounce(() => void this.searchMessages(), 250);
    search.addEventListener('input', () => {
      this.inbox.query = search.value;
      if (this.inbox.scope === 'messages') runSearch();
      else this.refreshInbox();
    });
    const scope = this.segmented([['chats', 'Names'], ['messages', 'Messages']], this.inbox.scope, (v) => {
      this.inbox.scope = v as InboxState['scope'];
      search.placeholder = v === 'chats' ? `Search ${formatCount(this.rows.length)} conversations` : 'Search every message';
      if (v === 'messages') void this.searchMessages();
      else this.refreshInbox();
    }, 'Search in');

    const sort = h('select', { class: 'cc-field cc-field--inline', 'aria-label': 'Sort' },
      ([['recent', 'Latest activity'], ['oldest', 'Oldest first'], ['messages', 'Most messages'], ['name', 'Name A–Z']] as const)
        .map(([v, label]) => h('option', { value: v, selected: this.inbox.sort === v }, label)));
    sort.addEventListener('change', () => {
      this.inbox.sort = sort.value as InboxState['sort'];
      this.refreshInbox();
    });

    const folders = folderCounts(this.rows);
    const folder = folders.length > 1
      ? (() => {
          const sel = h('select', { class: 'cc-field cc-field--inline', 'aria-label': 'Folder' },
            h('option', { value: 'all', selected: this.inbox.folder === 'all' }, `All folders (${formatCount(this.rows.length)})`),
            folders.map(([f, n]) => h('option', { value: f, selected: this.inbox.folder === f }, `${folderLabel(f)} (${formatCount(n)})`)));
          sel.addEventListener('change', () => {
            this.inbox.folder = sel.value;
            this.refreshInbox();
          });
          return sel;
        })()
      : null;

    const groups = this.rows.filter((r) => r.kind !== 'dm').length;
    const kind = groups && groups < this.rows.length
      ? this.segmented([['all', 'All'], ['dm', 'Private'], ['group', 'Groups']], this.inbox.kind, (v) => {
          this.inbox.kind = v as InboxState['kind'];
          this.refreshInbox();
        }, 'Kind')
      : null;

    const media = this.rows.some((r) => r.media.total)
      ? (() => {
          const box = h('input', { type: 'checkbox', class: 'cc-switch', checked: this.inbox.withMedia });
          box.addEventListener('change', () => {
            this.inbox.withMedia = box.checked;
            this.refreshInbox();
          });
          return h('label', { class: 'cc-toggle' }, box, 'With media');
        })()
      : null;

    return h('div', { class: 'cc-inbox__tools' },
      h('div', { class: 'cc-row cc-inbox__search' }, search, scope),
      h('div', { class: 'cc-row' }, sort, folder, kind, media),
    );
  }

  /** Re-filters the list (or shows search hits) without rebuilding the toolbar, so typing keeps focus. */
  private refreshInbox(): void {
    const status = this.root.querySelector<HTMLElement>('[data-part="inbox-status"]');
    const vp = this.root.querySelector<HTMLElement>('[data-part="inbox-list"]');
    if (!status || !vp) return;
    const byIndex = new Map(this.rows.map((r) => [r.index, r]));

    // Rows and search hits each get their own scroll element, so neither list's listeners pile up on the other's.
    const fresh = (): HTMLElement => {
      const next = h('div', { class: 'cc-vl cc-vl--inbox', 'data-part': 'inbox-list', tabindex: 0, 'aria-label': 'Conversations' });
      vp.replaceWith(next);
      return next;
    };

    if (this.inbox.scope === 'messages' && this.inbox.query.trim().length >= 2) {
      this.inboxList = undefined;
      const chats = new Set(this.hits.map((x) => x.index)).size;
      replace(status, this.searching ? 'Searching…' : this.hitsTotal
        ? `${formatCount(this.hitsTotal)} message${this.hitsTotal === 1 ? '' : 's'} in ${formatCount(chats)} conversation${chats === 1 ? '' : 's'}${this.hitsTotal > this.hits.length ? ` — showing the first ${formatCount(this.hits.length)}` : ''}`
        : 'No message matches.');
      const hit = (i: number): HTMLElement => renderHit(this.hits[i]!, byIndex.get(this.hits[i]!.index), this.timeZone, (index, messageId) => void this.openConversation(index, messageId));
      if (!this.hitsList) this.hitsList = new VirtualList(fresh(), this.hits.length, hit, 72);
      else this.hitsList.reset(this.hits.length);
      return;
    }
    if (this.hitsList) {
      this.hitsList = undefined;
      this.inboxList = undefined;
      fresh();
    }

    this.filtered = filterRows(this.rows, this.inbox);
    const shownSelected = this.filtered.filter((r) => this.selected.has(r.index)).length;
    const all = h('input', { type: 'checkbox', class: 'cc-check', checked: shownSelected > 0 && shownSelected === this.filtered.length, 'aria-label': 'Select every conversation shown' });
    all.indeterminate = shownSelected > 0 && shownSelected < this.filtered.length;
    all.addEventListener('change', () => {
      for (const r of this.filtered) {
        if (all.checked) this.selected.add(r.index);
        else this.selected.delete(r.index);
      }
      this.refreshInbox();
      this.renderBatch();
    });
    replace(status,
      h('label', { class: 'cc-row' }, all, `${formatCount(this.filtered.length)} of ${formatCount(this.rows.length)} conversations`),
      this.selected.size ? h('span', { class: 'cc-muted' }, `${formatCount(this.selected.size)} selected`) : null,
    );
    const row = (i: number): HTMLElement => {
      const r = this.filtered[i]!;
      return renderRow(r, {
        selected: this.selected.has(r.index),
        edited: Object.keys(this.perChat.get(r.index)?.edits ?? {}).length > 0,
        current: r.index === this.current && !!this.perChat.get(r.index),
        timeZone: this.timeZone,
        onToggle: (index, on) => {
          if (on) this.selected.add(index);
          else this.selected.delete(index);
          this.refreshInbox();
          this.renderBatch();
        },
        onOpen: (index) => void this.openConversation(index),
      });
    };
    const target = this.root.querySelector<HTMLElement>('[data-part="inbox-list"]')!;
    if (!this.inboxList) this.inboxList = new VirtualList(target, this.filtered.length, row, 68);
    else this.inboxList.reset(this.filtered.length);
  }

  private async searchMessages(): Promise<void> {
    const query = this.inbox.query.trim();
    if (query.length < 2) {
      this.hits = [];
      this.hitsTotal = 0;
      this.refreshInbox();
      return;
    }
    this.searching = true;
    this.refreshInbox();
    try {
      const res = await this.worker().call({ action: 'search', importId: this.importId, query, limit: 500 });
      if (res.ok && res.action === 'search' && this.inbox.query.trim() === query) {
        this.hits = res.hits;
        this.hitsTotal = res.total;
      }
    } finally {
      this.searching = false;
      if (this.view === 'inbox') this.refreshInbox();
    }
  }

  private renderBatch(): void {
    const side = this.root.querySelector<HTMLElement>('[data-part="batch"]');
    if (!side) return;
    const n = this.selected.size;
    const targets = GROUPS.flatMap((g) => g.formats).filter((f) => f in FORMAT_META) as ExportFormatId[];
    const select = h('select', { class: 'cc-field', 'aria-label': 'Convert to' },
      GROUPS.map((g) => h('optgroup', { label: g.label },
        g.formats.filter((f) => targets.includes(f as ExportFormatId)).map((f) => h('option', { value: f, selected: f === this.batchTarget }, FORMAT_META[f as ExportFormatId].label)))));
    select.addEventListener('change', () => {
      this.batchTarget = select.value as ExportFormatId;
      this.renderBatch();
    });
    const universal = this.batchTarget === 'universalchat' || this.batchTarget === 'universalchat-zip';
    const how = universal
      ? 'One archive holding every selected conversation.'
      : isPackage(this.batchTarget)
        ? 'One download with a .zip per conversation inside — each inner .zip is the file to share to Telegram.'
        : 'One download with a file per conversation.';
    const large = !this.batchRunning && n > 0 && this.largeNoticeFor > 0 && this.largeNoticeFor === this.batchEstimate();
    const go = h('button', { class: 'cc-btn cc-btn--primary cc-btn--block', type: 'button', disabled: !n || this.batchRunning },
      this.batchRunning ? 'Converting…' : large ? 'Convert anyway' : n ? `Convert ${formatCount(n)} conversation${n === 1 ? '' : 's'}` : 'Select conversations to convert');
    go.addEventListener('click', () => void this.runBatch());
    const clear = h('button', { class: 'cc-link', type: 'button', disabled: !n, onclick: () => {
      this.selected.clear();
      this.refreshInbox();
      this.renderBatch();
    } }, 'Clear');
    const r = this.batchResult;
    replace(side,
      h('div', { class: 'cc-card' },
        h('div', { class: 'cc-card__head' }, h('h3', {}, 'Convert several'), clear),
        h('p', { class: 'cc-muted' }, n ? `${formatCount(n)} selected · ${formatCount(this.rows.filter((x) => this.selected.has(x.index)).reduce((s, x) => s + x.messageCount, 0))} messages` : 'Tick conversations in the list, or open one to edit and convert it on its own.'),
        this.field('Format', select, TARGET_NOTES[this.batchTarget]),
        h('p', { class: 'cc-hint' }, how, ' Renames, “Me”, date ranges and removed messages you set on a conversation are applied.'),
        large ? h('div', { class: 'cc-alert cc-alert--warn', role: 'alert' }, largeNotice(this.largeNoticeFor)) : null,
        n && !canPickSaveFile() && isSafari() && batchFileName(this.batchTarget, 'x', n).endsWith('.zip')
          ? h('div', { class: 'cc-alert cc-alert--warn' }, SAFARI_UNZIP)
          : null,
        go,
        this.batchRunning ? this.progressBlock() : null,
        this.batchError ? h('div', { class: 'cc-alert cc-alert--error', role: 'alert' }, this.batchError) : null,
      ),
      r
        ? h('div', { class: 'cc-card cc-result', role: 'status' },
            h('div', { class: 'cc-card__head' }, h('h3', {}, 'Done')),
            h('p', { class: 'cc-result__file' }, r.fileName, ` · ${formatBytes(r.archiveBytes)}`),
            r.streamed ? h('p', { class: 'cc-muted' }, 'Written straight into your browser’s downloads.') : null,
            h('dl', { class: 'cc-kv' },
              h('dt', {}, 'Conversations'), h('dd', {}, formatCount(r.conversations)),
              h('dt', {}, 'Messages'), h('dd', { class: r.messagesOut === r.messagesIn ? 'is-ok' : 'is-warn' }, `${formatCount(r.messagesOut)} of ${formatCount(r.messagesIn)}`),
              h('dt', {}, 'Media files'), h('dd', {}, `${formatCount(r.mediaWritten)} written`)),
            r.files.length ? h('details', { class: 'cc-options' }, h('summary', {}, `${formatCount(r.files.length)} files inside`), h('ul', { class: 'cc-notes' }, r.files.map((f) => h('li', {}, `${f.name} · ${formatBytes(f.bytes)}`)))) : null,
            r.warnings.length ? h('details', { class: 'cc-options' }, h('summary', {}, `${formatCount(r.warnings.length)} notes`), h('ul', { class: 'cc-notes' }, r.warnings.map((w) => h('li', {}, w)))) : null,
            r.opfsName
              ? h('div', { class: 'cc-row' },
                  h('button', { class: 'cc-btn', type: 'button', onclick: () => void downloadFromOpfs(r.opfsName!, r.fileName) }, 'Download again'),
                  h('button', { class: 'cc-link', type: 'button', onclick: () => void this.removeStored() }, `Remove from browser storage (${formatBytes(r.archiveBytes)})`))
              : null)
        : null,
    );
  }

  private batchItems(): Array<{ index: number; edits?: Edits; exportOptions: ExportOptions }> {
    return [...this.selected].sort((x, y) => x - y).map((index) => {
      const saved = this.perChat.get(index);
      const row = this.rows[index];
      const whatsapp: WhatsAppPackageOptions = { ...this.options, mode: saved?.mode ?? (row?.kind === 'dm' ? 'dm' : 'group'), timeZone: this.timeZone };
      const self = saved ? saved.selfId : row?.selfId;
      if (self) whatsapp.selfId = self;
      const exportOptions: ExportOptions = { order: this.order, whatsapp, ...(saved?.edits.title ? { title: saved.edits.title } : {}) };
      return { index, ...(saved && Object.keys(saved.edits).length ? { edits: saved.edits } : {}), exportOptions };
    });
  }

  private async runBatch(): Promise<void> {
    if (!this.selected.size || this.batchRunning) return;
    this.saveCurrent();
    const items = this.batchItems();
    const fileName = batchFileName(this.batchTarget, this.archive?.name ?? this.sourceName, items.length);
    const picked = await this.packageDestination(fileName, this.batchEstimate());
    if (!picked) return;
    const { destination, transfer, streamed } = picked;
    this.largeNoticeFor = 0;
    const client = this.worker();
    const id = client.nextId();
    this.runningId = id;
    this.batchRunning = true;
    this.batchResult = undefined;
    this.batchError = '';
    this.progress = { entries: 0, bytes: 0, total: this.batchEstimate() };
    this.renderBatch();
    try {
      const res = await client.call(
        { action: 'batch', importId: this.importId, items, target: this.batchTarget, destination: destination as never },
        (entries, bytes) => {
          this.progress.entries = entries;
          this.progress.bytes = bytes;
          this.renderProgress();
        },
        id,
        transfer,
      );
      if (res.ok && res.action === 'batch') {
        this.batchResult = {
          fileName: res.suggestedName,
          layout: res.layout,
          conversations: res.conversations,
          messagesIn: res.messagesIn,
          messagesOut: res.messagesOut,
          mediaWritten: res.mediaWritten,
          files: res.files,
          warnings: res.warnings,
          archiveBytes: res.archiveBytes,
          ...(res.opfsName ? { opfsName: res.opfsName } : {}),
          ...(streamed ? { streamed: true } : {}),
        };
        if (res.opfsName) await downloadFromOpfs(res.opfsName, res.suggestedName);
        this.emit('cc-converted', { target: this.batchTarget, fileName: res.suggestedName, conversations: res.conversations });
      }
    } catch (e) {
      this.batchError = e instanceof Error && e.name === 'AbortError' ? 'Conversion cancelled.' : e instanceof Error ? e.message : String(e);
    }
    if (streamed) void streamed.done.catch(() => undefined).finally(() => streamed.dispose());
    this.batchRunning = false;
    this.runningId = '';
    this.renderBatch();
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
