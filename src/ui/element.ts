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
import { EXPORT_GUIDES, OUTPUT_FORMATS, OUTPUT_GROUPS, importTarget, type ExportGuide } from '../targets/index';
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
import { dateInput, formatBytes, formatCount, formatDay, hue, localParts } from './format';
import { appStyle, icon, type IconName } from './icons';
import { avatar, filterRows, folderCounts, folderLabel, INBOX_DEFAULTS, renderHit, renderRow, type InboxState } from './inbox';
import { openMenu, openOverlay, type MenuEntry } from './overlay';
import { VirtualList } from './virtual-list';

type Phase = 'empty' | 'reading' | 'ready' | 'converting' | 'done' | 'error';
/** The workspace's panes; on a phone one shows at a time. */
type Pane = 'chat' | 'edit' | 'export';

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

/** Icons of the target formats in this UI; names, notes and groups come from OUTPUT_FORMATS. */
const FORMAT_ICON: Record<string, IconName> = {
  'telegram-ios': 'send', 'telegram-android': 'send', 'universalchat-zip': 'layers', universalchat: 'braces', html: 'globe',
  markdown: 'fileText', 'whatsapp-zip': 'package', 'whatsapp-txt': 'fileText', 'telegram-json': 'braces', json: 'braces',
};

const KIND_ICON: Record<string, IconName> = {
  image: 'image', video: 'video', gif: 'film', animation: 'film', audio: 'music', voice: 'mic', sticker: 'smile',
  file: 'file', contact: 'contact', location: 'pin', poll: 'poll', unknown: 'paperclip',
};

const PROFILE_STEPS: Array<[IconName, string, string]> = [
  ['upload', 'Drop your export', 'The folder or .zip the app gave you. It is read here, in this tab.'],
  ['users', 'Check names and dates', 'Rename people, mark which one is you, trim the dates, leave messages out.'],
  ['download', 'Convert and import', 'Pick a format and save it. For Telegram, share the .zip to the app.'],
];

function isPackage(format: ExportFormatId): boolean {
  return packageFormatIds.includes(format);
}

function extLabel(format: ExportFormatId): string {
  return `.${FORMAT_META[format].extension.split('.').pop() ?? ''}`;
}

function supportedZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return [defaultTimeZone()];
  }
}

const pad = (n: number): string => String(n).padStart(2, '0');

function dayKey(m: Message, tz: string): number {
  const w = localParts(m, tz);
  return w.year * 10_000 + w.month * 100 + w.day;
}

function longDay(m: Message, tz: string): string {
  const w = localParts(m, tz);
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).toLocaleDateString(undefined, {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function clock(m: Message, tz: string): string {
  const w = localParts(m, tz);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

const isEvent = (m: Message): boolean => m.kind === 'service' || m.kind === 'system' || m.kind === 'call';

/** Above this size, a browser without a save dialog shows a notice before it builds a package. */
const LARGE_WITHOUT_PICKER = 2 * 1024 ** 3;

function largeNotice(bytes: number): string {
  return `This package will be about ${formatBytes(bytes)}. This browser cannot write a file straight to disk, so the converter builds it in this site's browser storage first (${formatBytes(bytes)} of disk) and then hands it to your downloads; Safari has cancelled that hand-off for packages of several GB. Chrome and Edge write straight into the file you pick.`;
}

const SAFARI_UNZIP =
  'Safari unzips downloaded .zip files while “Open safe files after downloading” is on (Safari → Settings → General). Telegram needs the .zip itself, so turn that setting off before converting.';

/** Report words, matching the result panel's headings. */
const STATUS_WORD: Record<string, string> = { preserved: 'Kept', approximated: 'Rewritten', dropped: 'Not carried' };

/**
 * `<chat-converter-app>`: drop an export, check it, preview it, convert it. An export holding many
 * conversations (Instagram, Messenger, Snapchat…) opens on an inbox: search, filter, open one, or select
 * several and convert them together.
 *
 * Layout: a start screen, then an app frame whose panes (Details · Chat · Export, or Chats · Convert for an
 * inbox) sit side by side on a wide element and become bottom tabs on a narrow one. The breakpoints are
 * container queries on the element, so a host decides the width; `--cc-app-h` sets the frame's height.
 *
 * Host hooks (ChatForge uses them for "Save to Vault"):
 * - children with `slot="actions"` are moved into the export pane;
 * - `getConversation()` returns the edited conversation;
 * - events: `cc-imported`, `cc-opened`, `cc-change`, `cc-converted` (bubbling, composed);
 * - `data-phase` (empty | reading | ready | converting | done | error) and `data-view` (start | inbox | work)
 *   are mirrored on the element for host styling;
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
  private archiveWarnings: string[] = [];
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
  private focusPane: Pane = 'chat';
  private side: 'edit' | 'export' = 'edit';
  // Archive (every conversation of the export) and the inbox.
  private archive?: ArchiveSummary;
  private rows: ConversationSummary[] = [];
  private view: 'inbox' | 'chat' = 'chat';
  private inboxPane: 'list' | 'batch' = 'list';
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
  private stage!: HTMLDivElement;
  private toasts!: HTMLDivElement;
  private actions: Node[] = [];
  private largeNoticeFor = 0;
  private dragDepth = 0;
  private keepScroll = 0;

  connectedCallback(): void {
    if (this.root) return;
    this.actions = [...this.children].filter((c) => c.getAttribute('slot') === 'actions');
    for (const a of this.actions) (a as Element).remove();
    this.stage = h('div', { class: 'cc-stage' });
    this.toasts = h('div', { class: 'cc-toasts', role: 'status', 'aria-live': 'polite' });
    this.root = h('div', { class: 'cc' },
      this.stage,
      h('div', { class: 'cc-dropveil', 'aria-hidden': 'true' },
        h('div', { class: 'cc-dropveil__card' }, icon('upload', 28), h('p', {}, 'Drop to open this export'))),
      this.toasts,
    );
    this.append(this.root);
    this.wireDrop();
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

  private busy(): boolean {
    return this.phase === 'reading' || this.phase === 'converting' || this.batchRunning;
  }

  /** Files dropped anywhere on the converter open as a new export. */
  private wireDrop(): void {
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const reset = (): void => {
      this.dragDepth = 0;
      this.root.classList.remove('is-dragging');
    };
    this.root.addEventListener('dragenter', (e) => {
      if (!hasFiles(e) || this.busy()) return;
      e.preventDefault();
      this.dragDepth += 1;
      this.root.classList.add('is-dragging');
    });
    this.root.addEventListener('dragover', (e) => {
      if (!hasFiles(e) || this.busy()) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    this.root.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (!this.dragDepth) reset();
    });
    this.root.addEventListener('drop', (e) => {
      if (!hasFiles(e) || this.busy()) return;
      e.preventDefault();
      reset();
      if (!e.dataTransfer) return;
      // entriesFromDataTransfer takes the entries synchronously, as the drop event requires.
      void entriesFromDataTransfer(e.dataTransfer).then((entries) => this.load(entries, dropName(entries)));
    });
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
      this.inboxPane = 'list';
      this.focusPane = 'chat';
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
    this.keepScroll = 0;
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
      this.focusPane = 'chat';
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
      const advice = this.detected === 'telegram'
        ? 'In Telegram Desktop, export again with every media type ticked and the size limit at 4000 MB — the limit is per file, not for the whole export.'
        : this.detected === 'whatsapp'
          ? 'In WhatsApp, export the chat again and choose Attach Media; media that is no longer on the phone stays out.'
          : 'Export again from the app with media included.';
      out.push(`${formatCount(notIncluded.length)} media files are not in this export (${list}). ${advice}`);
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
    return `${(this.edits.title || conv.title || 'chat').replace(/[\\/:*?"<>|]/g, '_')}.${meta.extension}`;
  }

  private async convert(): Promise<void> {
    if (!this.imported || this.phase === 'converting') return;
    const client = this.worker();
    const fileName = this.suggestedName();
    const exportOptions = { order: this.order, whatsapp: this.whatsappOptions(), ...(this.edits.title ? { title: this.edits.title } : {}) };
    this.result = undefined;

    if (!isPackage(this.target)) {
      this.phase = 'converting';
      this.refreshWork();
      try {
        const res = await client.call({ action: 'export', importId: this.importId, conversationIndex: this.current, edits: this.edits, target: this.target, exportOptions });
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
          this.toast(`Saved ${this.result.fileName}`);
          this.emit('cc-converted', { target: this.target, fileName: this.result.fileName });
        }
      } catch (e) {
        this.phase = 'error';
        this.error = e instanceof Error ? e.message : String(e);
      }
      this.refreshWork(true);
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
    this.refreshWork();
    try {
      const res = await client.call(
        {
          action: 'package',
          importId: this.importId,
          conversationIndex: this.current,
          edits: this.edits,
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
        this.toast(`Saved ${res.summary.suggestedName} · ${formatBytes(res.archiveBytes)}`);
        this.emit('cc-converted', { target: this.target, fileName: res.summary.suggestedName, summary: res.summary });
      }
    } catch (e) {
      this.phase = 'error';
      this.error = e instanceof Error && e.name === 'AbortError' ? 'Conversion cancelled.' : e instanceof Error ? e.message : String(e);
    }
    if (streamed) void streamed.done.catch(() => undefined).finally(() => streamed.dispose());
    this.runningId = '';
    this.refreshWork(true);
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
    if (this.view === 'inbox') this.renderBatch();
    else this.renderExport();
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
    if (this.view === 'inbox') this.renderBatch();
    else this.renderExport();
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
    this.focusPane = 'chat';
    this.render();
  }

  private changed = debounce(() => {
    this.refreshPreview();
    this.renderTopbar();
    this.refreshOverview();
    this.renderConvertFoot();
    if (this.tab === 'output') void this.renderOutput();
    this.emit('cc-change', { messages: this.getConversation()?.messages.length ?? 0 });
  }, 120);

  // ---------------------------------------------------------------- render

  private piece<T extends HTMLElement = HTMLElement>(name: string): T | null {
    return this.root.querySelector<T>(`[data-part="${name}"]`);
  }

  private render(): void {
    const start = this.phase === 'empty' || this.phase === 'reading' || (this.phase === 'error' && !this.imported);
    const view = start ? 'start' : this.view === 'inbox' ? 'inbox' : 'work';
    this.dataset['phase'] = this.phase;
    this.dataset['view'] = view;
    this.root.dataset['view'] = view;
    if (start) {
      this.list = undefined;
      this.inboxList = undefined;
      replace(this.stage, this.renderStart());
      return;
    }
    if (view === 'inbox') {
      this.list = undefined;
      this.renderInbox();
      return;
    }
    this.inboxList = undefined;
    this.renderWork();
  }

  /** After a conversion step: everything that shows the phase, without rebuilding the preview. */
  private refreshWork(finished = false): void {
    this.dataset['phase'] = this.phase;
    this.renderExport();
    this.renderTabbar();
    if (this.tab === 'report') this.renderTabBody();
    if (finished && this.phase === 'done') this.piece('export')?.scrollTo({ top: 0 });
  }

  private iconButton(name: IconName, label: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
    const b = h('button', { class: `cc-iconbtn ${cls}`, type: 'button', 'aria-label': label, title: label }, icon(name));
    b.addEventListener('click', onClick);
    return b;
  }

  private toast(text: string, tone: 'ok' | 'error' = 'ok'): void {
    const t = h('div', { class: `cc-toast is-${tone}` }, icon(tone === 'ok' ? 'checkCircle' : 'alert'), h('span', {}, text));
    this.toasts.append(t);
    setTimeout(() => t.classList.add('is-leaving'), 4200);
    setTimeout(() => t.remove(), 4600);
  }

  // ---------------------------------------------------------------- start screen

  private renderStart(): HTMLElement {
    const reading = this.phase === 'reading';
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const folder = h('input', { type: 'file', hidden: true, webkitdirectory: true, multiple: true });
    const files = h('input', { type: 'file', hidden: true, multiple: true, accept: '.zip,.json,.html,.txt' });
    folder.addEventListener('change', () => {
      const entries = entriesFromFileList(folder.files ?? []);
      void this.load(entries, dropName(entries));
    });
    files.addEventListener('change', () => {
      const entries = entriesFromFileList(files.files ?? []);
      void this.load(entries, dropName(entries));
    });
    const pickFolder = h('button', { class: `cc-btn cc-btn--lg${coarse ? '' : ' cc-btn--primary'}`, type: 'button', onclick: () => folder.click() }, icon('folder'), 'Choose a folder');
    const pickFiles = h('button', { class: `cc-btn cc-btn--lg${coarse ? ' cc-btn--primary' : ''}`, type: 'button', onclick: () => files.click() }, icon('file'), coarse ? 'Choose a file' : 'Choose files');

    const drop = h('div', { class: `cc-drop${reading ? ' is-reading' : ''}`, tabindex: reading ? -1 : 0, role: 'group', 'aria-label': 'Open a chat export', 'aria-busy': reading ? 'true' : undefined },
      h('div', { class: 'cc-drop__art', 'aria-hidden': 'true' }, icon(reading ? 'layers' : 'upload', 30)),
      h('h2', { class: 'cc-drop__title' }, reading ? 'Reading your export…' : coarse ? 'Open a chat export' : 'Drop a chat export here'),
      h('p', { class: 'cc-drop__text' },
        reading
          ? `${this.dropLabel ? `${this.dropLabel} — ` : ''}large exports take a moment.`
          : 'A folder, a .zip or loose files from Telegram, WhatsApp, Instagram, Facebook, Snapchat, VSCO or Hinge — or a UniversalChat package.'),
      reading
        ? h('div', { class: 'cc-bar cc-bar--busy', role: 'progressbar', 'aria-label': 'Reading' }, h('i'))
        : h('div', { class: 'cc-drop__actions' }, coarse ? [pickFiles, pickFolder] : [pickFolder, pickFiles]),
      this.phase === 'error' ? h('div', { class: 'cc-notice is-error', role: 'alert' }, icon('alert'), h('span', {}, this.error)) : null,
      h('p', { class: 'cc-drop__privacy' }, icon('lock', 15), 'Read and converted on this device. Nothing is uploaded.'),
      folder,
      files,
    );
    drop.addEventListener('keydown', (e) => {
      if (reading || e.target !== drop) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        (coarse ? files : folder).click();
      }
    });

    const apps = h('div', { class: 'cc-apps' },
      h('p', { class: 'cc-eyebrow' }, 'Works with'),
      h('div', { class: 'cc-apps__list' },
        EXPORT_GUIDES.map((g) => {
          const chip = h('button', { class: 'cc-app-chip', type: 'button', 'aria-haspopup': 'dialog', title: `How to get your ${g.app} export` },
            h('span', { class: 'cc-app-chip__mark', style: appStyle(g.platform), 'aria-hidden': 'true' }, g.app.slice(0, 1)),
            h('span', {}, g.app));
          chip.addEventListener('click', () => this.showGuide(g, chip));
          return chip;
        })),
      h('p', { class: 'cc-hint' }, 'Tap an app to see how to get its export.'),
    );

    const steps = h('ol', { class: 'cc-steps' },
      PROFILE_STEPS.map(([name, title, text], i) =>
        h('li', { class: 'cc-step' },
          h('span', { class: 'cc-step__icon', 'aria-hidden': 'true' }, icon(name, 20), h('span', { class: 'cc-step__n' }, `${i + 1}`)),
          h('div', {}, h('p', { class: 'cc-step__title' }, title), h('p', { class: 'cc-step__text' }, text)))));

    return h('section', { class: 'cc-start' }, drop, apps, steps);
  }

  private showGuide(g: ExportGuide, anchor: HTMLElement): void {
    openOverlay(
      [
        h('p', { class: 'cc-guide__drop' }, icon('upload', 16), h('span', {}, 'Drop ', h('strong', {}, g.drop))),
        h('ol', { class: 'cc-guide__steps' }, g.steps.map((s) => h('li', {}, s))),
        g.tip ? h('p', { class: 'cc-notice is-info' }, icon('info'), h('span', {}, g.tip)) : null,
      ],
      { host: this.root, anchor, label: `${g.app} export`, title: `Get your ${g.app} export`, width: 380 },
    );
  }

  // ---------------------------------------------------------------- workspace (one conversation)

  private renderWork(): void {
    const prevScroll = this.root.querySelector<HTMLElement>('.cc-pane--chat .cc-vl')?.scrollTop ?? 0;
    this.keepScroll = this.list ? prevScroll : this.keepScroll;
    const sideSwitch = (): HTMLElement =>
      this.segmented([['edit', 'Details', 'sliders'], ['export', 'Export', 'download']], this.side, (v) => this.setFocus(v as Pane), 'Side panel', 'cc-sideswitch');
    const app = h('div', { class: 'cc-app cc-app--work', 'data-focus': this.focusPane, 'data-side': this.side },
      h('header', { class: 'cc-topbar', 'data-part': 'topbar' }),
      h('div', { class: 'cc-body cc-body--work' },
        h('section', { class: 'cc-pane cc-pane--edit', 'data-pane': 'edit', 'aria-label': 'Details' },
          h('div', { class: 'cc-pane__head' }, h('h3', { class: 'cc-pane__title' }, 'Details'), sideSwitch()),
          h('div', { class: 'cc-pane__scroll', 'data-part': 'details' })),
        h('section', { class: 'cc-pane cc-pane--chat', 'data-pane': 'chat', 'aria-label': 'Preview' },
          h('div', { class: 'cc-pane__head cc-previewhead' }, this.renderPreviewTabs(), h('div', { class: 'cc-previewhead__tools', 'data-part': 'preview-tools' })),
          h('div', { class: 'cc-pane__body', 'data-part': 'body' })),
        h('section', { class: 'cc-pane cc-pane--export', 'data-pane': 'export', 'aria-label': 'Export' },
          h('div', { class: 'cc-pane__head' }, h('h3', { class: 'cc-pane__title' }, 'Export'), sideSwitch()),
          h('div', { class: 'cc-pane__scroll', 'data-part': 'export' }),
          h('div', { class: 'cc-pane__foot', 'data-part': 'convert' })),
      ),
      h('nav', { class: 'cc-tabbar', 'data-part': 'tabbar', 'aria-label': 'Sections' }),
    );
    replace(this.stage, app);
    this.renderTopbar();
    this.renderDetailsPane();
    this.renderExport();
    this.renderTabbar();
    this.renderTabBody();
  }

  private setFocus(pane: Pane): void {
    this.focusPane = pane;
    if (pane !== 'chat') this.side = pane;
    const app = this.root.querySelector<HTMLElement>('.cc-app--work');
    if (app) {
      app.dataset['focus'] = pane;
      app.dataset['side'] = this.side;
      for (const seg of app.querySelectorAll<HTMLElement>('.cc-sideswitch')) this.syncSegmented(seg, this.side);
    }
    this.renderTabbar();
  }

  private renderTabbar(): void {
    const bar = this.piece('tabbar');
    if (!bar) return;
    if (this.view === 'inbox') {
      const n = this.selected.size;
      replace(bar, this.tabButton('list', 'Chats', 'list', this.inboxPane === 'list', () => this.setInboxPane('list')),
        this.tabButton('batch', 'Convert', 'download', this.inboxPane === 'batch', () => this.setInboxPane('batch'), n ? formatCount(n) : this.batchRunning ? '…' : ''));
      return;
    }
    const dot = this.phase === 'converting' ? '…' : this.phase === 'done' ? '✓' : '';
    replace(bar,
      this.tabButton('chat', 'Chat', 'message', this.focusPane === 'chat', () => this.setFocus('chat')),
      this.tabButton('edit', 'Details', 'sliders', this.focusPane === 'edit', () => this.setFocus('edit'), this.warnings.length ? '!' : ''),
      this.tabButton('export', 'Export', 'download', this.focusPane === 'export', () => this.setFocus('export'), dot));
  }

  private tabButton(id: string, label: string, name: IconName, on: boolean, pick: () => void, badge = ''): HTMLElement {
    return h('button', { class: `cc-tabbar__item${on ? ' is-on' : ''}`, type: 'button', 'aria-current': on ? 'page' : undefined, 'data-tab': id, onclick: pick },
      h('span', { class: 'cc-tabbar__icon' }, icon(name, 22), badge ? h('span', { class: 'cc-tabbar__badge' }, badge) : null),
      h('span', { class: 'cc-tabbar__label' }, label));
  }

  private renderTopbar(): void {
    const bar = this.piece('topbar');
    if (!bar || !this.imported) return;
    const conv = this.imported;
    const multi = this.rows.length > 1;
    const title = this.edits.title || conv.title || 'Conversation';
    const format = String(conv.meta?.['exportFormat'] ?? '');
    const included = this.getConversation()?.messages.length ?? 0;
    const more = this.iconButton('more', 'More actions', () => this.openWorkMenu(more));
    replace(bar,
      multi ? h('button', { class: 'cc-back', type: 'button', onclick: () => this.backToInbox(), 'aria-label': 'Back to all conversations' }, icon('chevronLeft', 20), h('span', {}, 'Chats')) : null,
      avatar(title),
      h('div', { class: 'cc-topbar__titles' },
        h('h2', { class: 'cc-topbar__title' }, title),
        h('p', { class: 'cc-topbar__sub' },
          h('span', {}, platformLabel(this.detected), format ? ` · ${variantLabel(format)}` : ''),
          h('span', {}, `${formatCount(included)}${included !== conv.messages.length ? ` of ${formatCount(conv.messages.length)}` : ''} messages`),
          h('span', { class: 'cc-hide-narrow' }, `${formatCount(conv.participants.length)} people`))),
      h('div', { class: 'cc-topbar__actions' },
        multi ? [this.navButton(-1), this.navButton(1)] : null,
        this.warnings.length
          ? (() => {
              const b = h('button', { class: 'cc-pill is-warn', type: 'button', 'aria-label': `${this.warnings.length} notes about this export` }, icon('info', 16), h('span', {}, String(this.warnings.length)));
              b.addEventListener('click', () => this.showNotes(this.warnings, b));
              return b;
            })()
          : null,
        more),
    );
  }

  private showNotes(notes: string[], anchor: HTMLElement): void {
    openOverlay(h('ul', { class: 'cc-notes' }, notes.map((w) => h('li', {}, w))), {
      host: this.root, anchor, label: 'Notes about this export', title: `${notes.length} note${notes.length > 1 ? 's' : ''} about this export`, width: 420,
    });
  }

  private exportSwitchEntries(): MenuEntry[] {
    if (this.exportsFound.length < 2) return [];
    return [
      'separator',
      { heading: `${this.exportsFound.length} exports in what you dropped` },
      ...this.exportsFound.map((name, i) => ({
        label: name,
        checked: i === this.exportIndex,
        onSelect: () => {
          if (i === this.exportIndex) return;
          this.exportIndex = i;
          void this.runImport();
        },
      })),
    ];
  }

  private openWorkMenu(anchor: HTMLElement): void {
    const multi = this.rows.length > 1;
    const order = this.filtered.length ? this.filtered : filterRows(this.rows, this.inbox);
    const at = order.findIndex((r) => r.index === this.current);
    const prev = at >= 0 ? order[at - 1] : undefined;
    const next = at >= 0 ? order[at + 1] : undefined;
    openMenu([
      { label: 'Open another export', icon: 'upload', onSelect: () => this.startOver() },
      multi ? { label: 'All conversations', icon: 'list', onSelect: () => this.backToInbox() } : null,
      multi && prev ? { label: 'Previous conversation', hint: prev.title, icon: 'chevronLeft', onSelect: () => void this.openConversation(prev.index) } : null,
      multi && next ? { label: 'Next conversation', hint: next.title, icon: 'chevronRight', onSelect: () => void this.openConversation(next.index) } : null,
      'separator',
      // With all three panes on screen (≥ 1180px wide) there is nothing to switch to.
      this.clientWidth < 1180 ? { label: 'Details', icon: 'sliders', onSelect: () => this.setFocus('edit') } : null,
      this.clientWidth < 1180 ? { label: 'Export', icon: 'download', onSelect: () => this.setFocus('export') } : null,
      { label: 'Reset changes', icon: 'undo', disabled: Object.keys(this.edits).length === 0, onSelect: () => this.resetEdits() },
      this.warnings.length ? { label: 'Notes about this export', icon: 'info', onSelect: () => this.showNotes(this.warnings, anchor) } : null,
      ...this.exportSwitchEntries(),
    ], { host: this.root, anchor, label: 'More actions' });
  }

  private resetEdits(): void {
    this.edits = {};
    this.renderDetailsPane();
    this.changed();
  }

  /** Previous/next conversation in the inbox's current order. */
  private navButton(step: -1 | 1): HTMLElement {
    const order = this.filtered.length ? this.filtered : filterRows(this.rows, this.inbox);
    const at = order.findIndex((r) => r.index === this.current);
    const next = at >= 0 ? order[at + step] : undefined;
    const b = this.iconButton(step < 0 ? 'chevronLeft' : 'chevronRight', step < 0 ? 'Previous conversation' : 'Next conversation', () => {
      if (next) void this.openConversation(next.index);
    }, 'cc-hide-narrow');
    b.disabled = !next;
    if (next) b.title = `${step < 0 ? 'Previous' : 'Next'}: ${next.title}`;
    return b;
  }

  // ---------------------------------------------------------------- details pane

  private renderDetailsPane(): void {
    const pane = this.piece('details');
    if (!pane || !this.imported) return;
    const top = pane.scrollTop;
    replace(pane, this.renderDetails());
    pane.scrollTop = top;
  }

  private section(title: string, body: Array<Node | null>, opts: { hint?: string; action?: Node | null; icon?: IconName } = {}): HTMLElement {
    return h('section', { class: 'cc-section' },
      h('div', { class: 'cc-section__head' },
        h('h4', { class: 'cc-section__title' }, opts.icon ? icon(opts.icon, 16) : null, title),
        opts.action ?? null),
      h('div', { class: 'cc-section__body' }, body),
      opts.hint ? h('p', { class: 'cc-hint' }, opts.hint) : null,
    );
  }

  private field(label: string, control: Node, hint?: string): HTMLElement {
    return h('label', { class: 'cc-field' }, h('span', { class: 'cc-field__label' }, label), control, hint ? h('span', { class: 'cc-hint' }, hint) : null);
  }

  private renderOverview(): HTMLElement {
    const conv = this.imported!;
    const att = conv.messages.flatMap((m) => m.attachments ?? []);
    const present = att.filter((a) => a.present).length;
    const bounds = dateBounds(conv);
    const included = this.getConversation()?.messages.length ?? 0;
    const tile = (label: string, value: string, sub: string, tone = ''): HTMLElement =>
      h('div', { class: `cc-stat ${tone}` }, h('span', { class: 'cc-stat__label' }, label), h('span', { class: 'cc-stat__value' }, value), h('span', { class: 'cc-stat__sub' }, sub));
    const source = this.exportsFound.length > 1
      ? (() => {
          const sel = h('select', { class: 'cc-input cc-input--sm', 'aria-label': 'Export to use' },
            this.exportsFound.map((name, i) => h('option', { value: i, selected: i === this.exportIndex }, name)));
          sel.addEventListener('change', () => {
            this.exportIndex = Number(sel.value);
            void this.runImport();
          });
          return h('div', { class: 'cc-source' }, icon('layers', 16), h('span', {}, `${this.exportsFound.length} exports:`), sel);
        })()
      : h('div', { class: 'cc-source' }, icon(this.entries.length > 1 ? 'folder' : 'file', 16), h('span', { title: this.sourceName || this.dropLabel }, this.sourceName || this.dropLabel));
    return h('div', { class: 'cc-overview', 'data-part': 'overview' },
      h('div', { class: 'cc-stats' },
        tile('Messages', formatCount(included), included === conv.messages.length ? 'all included' : `of ${formatCount(conv.messages.length)}`, included === conv.messages.length ? '' : 'is-accent'),
        tile('People', formatCount(conv.participants.length), conv.kind === 'dm' ? 'private chat' : conv.kind),
        tile('Media', att.length ? `${formatCount(present)}/${formatCount(att.length)}` : '0', att.length ? (present === att.length ? 'all in the export' : 'some not exported') : 'none', att.length && present < att.length ? 'is-warn' : att.length ? 'is-ok' : ''),
        tile('Dates', bounds ? formatDay(bounds.min, this.timeZone) : '—', bounds ? `to ${formatDay(bounds.max, this.timeZone)}` : '')),
      source,
    );
  }

  private refreshOverview(): void {
    const old = this.piece('overview');
    if (old && this.imported) old.replaceWith(this.renderOverview());
  }

  private renderDetails(): Node[] {
    const conv = this.imported!;
    const counts = participantMessageCounts(conv);
    const bounds = dateBounds(conv);

    const notes = this.warnings.length
      ? h('details', { class: 'cc-callout is-warn', open: true },
          h('summary', {}, icon('info', 16), `${this.warnings.length} note${this.warnings.length > 1 ? 's' : ''} about this export`, icon('chevronDown', 16)),
          h('ul', { class: 'cc-notes' }, this.warnings.map((w) => h('li', {}, w))))
      : null;

    const title = h('input', { class: 'cc-input', value: this.edits.title ?? conv.title ?? '', placeholder: 'Conversation title' });
    title.addEventListener('input', () => {
      this.edits = { ...this.edits, title: title.value };
      this.changed();
    });
    const modeSeg = this.segmented([['dm', 'Private chat'], ['group', 'Group']], this.mode, (v) => {
      this.mode = v as 'dm' | 'group';
      this.changed();
    }, 'Chat type');

    const people = h('div', { class: 'cc-people' },
      conv.participants.map((p) => {
        const name = p.displayName ?? p.id;
        const input = h('input', { class: 'cc-input', value: this.edits.renames?.[p.id] ?? '', placeholder: name, 'aria-label': `Name for ${name}` });
        input.addEventListener('input', () => {
          const renames = { ...this.edits.renames };
          if (input.value.trim()) renames[p.id] = input.value;
          else delete renames[p.id];
          this.edits = { ...this.edits, renames };
          this.changed();
        });
        const me = h('input', { type: 'radio', name: `cc-self-${this.importId}`, checked: this.selfId === p.id });
        me.addEventListener('change', () => {
          this.selfId = p.id;
          this.changed();
        });
        return h('div', { class: 'cc-person' },
          avatar(this.edits.renames?.[p.id] || name, 'sm'),
          h('div', { class: 'cc-person__main' },
            input,
            h('span', { class: 'cc-person__meta' },
              `${formatCount(counts[p.id] ?? 0)} messages`,
              p.meta?.['deletedAccount'] ? h('span', { class: 'cc-badge is-warn', title: 'Telegram exports a deleted account without a name' }, 'deleted account') : null)),
          h('label', { class: 'cc-me', title: `${name} is me` }, me, h('span', {}, 'Me')),
        );
      }),
    );

    const from = h('input', { type: 'date', class: 'cc-input', 'aria-label': 'From' });
    const to = h('input', { type: 'date', class: 'cc-input', 'aria-label': 'To' });
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
    const removed = this.edits.removedIds?.length ?? 0;
    const restore = removed
      ? h('button', { class: 'cc-btn cc-btn--sm', type: 'button', onclick: () => {
          this.edits = { ...this.edits, removedIds: [] };
          this.renderDetailsPane();
          this.changed();
        } }, icon('undo', 16), `Put back ${formatCount(removed)} left out`)
      : null;

    const zone = h('select', { class: 'cc-input', 'aria-label': 'Time zone' },
      supportedZones().map((z) => h('option', { value: z, selected: z === this.timeZone }, z.replace(/_/g, ' '))));
    zone.addEventListener('change', () => {
      this.timeZone = zone.value;
      // HTML and WhatsApp exports carry wall-clock times: the zone decides the instants, so read again.
      const fmt = this.imported?.meta?.['exportFormat'];
      if (fmt === 'html' || this.detected === 'whatsapp') void this.runImport();
      else this.render();
    });
    const orderSeg = this.segmented([['source', 'As exported'], ['oldest-first', 'Oldest'], ['newest-first', 'Newest']], this.order, (v) => {
      this.order = v as MessageOrder;
      this.list?.reset(0);
      this.changed();
    }, 'Message order');

    const edited = Object.keys(this.edits).length > 0;
    return [
      this.renderOverview(),
      notes,
      this.section('Chat', [this.field('Title', title), this.field('Type', modeSeg, 'A private chat is written from your side; a group keeps every sender.')], { icon: 'message' }),
      this.section(`People`, [people], {
        icon: 'users',
        hint: 'Rename anyone (blank keeps the original). “Me” marks your own messages: they sit on the right, and WhatsApp-format files are written from your side.',
      }),
      bounds
        ? this.section('Messages', [h('div', { class: 'cc-range' }, this.field('From', from), this.field('To', to)), restore], {
            icon: 'calendar',
            hint: 'Messages outside the range are left out. To leave out a single message, hover or tap it in the chat preview and press −.',
          })
        : null,
      this.section('Time', [this.field('Time zone', zone, 'Times are shown and written in this zone.'), this.field('Order', orderSeg, 'WhatsApp-format packages always keep the export’s own order.')], { icon: 'clock' }),
      edited ? h('button', { class: 'cc-btn cc-btn--quiet cc-btn--block', type: 'button', onclick: () => this.resetEdits() }, icon('undo', 16), 'Reset all changes') : null,
    ].filter((n): n is HTMLElement => !!n);
  }

  // ---------------------------------------------------------------- export pane

  /** A list of target formats in groups; the chosen one shows its note. */
  private formatPicker(value: ExportFormatId, onPick: (f: ExportFormatId) => void): HTMLElement {
    const root = h('div', { class: 'cc-formats', role: 'radiogroup', 'aria-label': 'Convert to' });
    for (const g of OUTPUT_GROUPS) {
      const formats = OUTPUT_FORMATS.filter((o) => o.group === g.id && o.format in FORMAT_META);
      if (!formats.length) continue;
      root.append(h('p', { class: 'cc-eyebrow' }, g.label));
      for (const o of formats) {
        const on = value === o.format;
        const b = h('button', { class: `cc-format${on ? ' is-on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(on) },
          h('span', { class: 'cc-format__icon' }, icon(FORMAT_ICON[o.format] ?? 'file')),
          h('span', { class: 'cc-format__text' },
            h('span', { class: 'cc-format__name' }, o.label),
            on ? h('span', { class: 'cc-format__note' }, o.note) : null),
          h('span', { class: 'cc-format__ext' }, extLabel(o.format)),
          h('span', { class: 'cc-format__check', 'aria-hidden': 'true' }, on ? icon('check', 16) : null));
        b.addEventListener('click', () => onPick(o.format));
        root.append(b);
      }
    }
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const all = [...root.querySelectorAll<HTMLButtonElement>('.cc-format')];
      const at = all.indexOf(document.activeElement as HTMLButtonElement);
      if (at < 0) return;
      e.preventDefault();
      all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
    });
    return root;
  }

  private optionsBlock(): HTMLElement | null {
    const wa = isPackage(this.target) || this.target === 'whatsapp-txt';
    if (!wa) return null;
    const toggles: Array<[keyof WhatsAppPackageOptions, string, string, boolean]> = [
      ['serviceAsText', 'Events as text', 'Calls, pins and other events become text lines', true],
      ['omittedMarkers', 'Omitted markers', 'Mark media that is not in the export (“image omitted”)', true],
      ['replyQuotes', 'Reply quotes', 'Quote the message a reply answers', false],
      ['forwardLabels', 'Forward labels', 'Label forwarded messages', false],
      ['editedMarker', 'Edit marks', 'Mark edited messages', this.target === 'whatsapp-zip'],
      ['noticeLine', 'Encryption notice', 'Start with WhatsApp’s notice line (Telegram reads it)', true],
    ];
    const row = (label: string, hint: string, checked: boolean, set: (on: boolean) => void): HTMLElement => {
      const box = h('input', { type: 'checkbox', class: 'cc-switch', checked });
      box.addEventListener('change', () => set(box.checked));
      return h('label', { class: 'cc-toggle' }, h('span', { class: 'cc-toggle__text' }, h('span', {}, label), h('small', {}, hint)), box);
    };
    const on = toggles.filter(([key, , , d]) => (this.options[key] as boolean | undefined) ?? d).length + (this.options.animatedStickers === 'file' ? 1 : 0);
    return h('details', { class: 'cc-disclosure' },
      h('summary', {}, icon('sliders', 16), h('span', {}, 'Options'), h('span', { class: 'cc-disclosure__count' }, `${on} on`), icon('chevronDown', 16)),
      h('div', { class: 'cc-toggles' },
        toggles.map(([key, label, hint, dflt]) =>
          row(label, hint, (this.options[key] as boolean | undefined) ?? dflt, (v) => {
            (this.options as Record<string, unknown>)[key] = v;
            this.changed();
          })),
        row('Animated stickers', 'Attach animated stickers as files', this.options.animatedStickers === 'file', (v) => {
          this.options.animatedStickers = v ? 'file' : 'omit';
          this.changed();
        })),
    );
  }

  private renderExport(): void {
    const pane = this.piece('export');
    if (!pane || !this.imported) return;
    const busy = this.phase === 'converting';
    const large = !busy && isPackage(this.target) && this.largeNoticeFor > 0 && this.largeNoticeFor === this.estimateTotal();
    replace(pane,
      this.renderResult(),
      this.phase === 'error' ? h('div', { class: 'cc-notice is-error', role: 'alert' }, icon('alert'), h('span', {}, this.error)) : null,
      this.formatPicker(this.target, (f) => {
        this.target = f;
        this.largeNoticeFor = 0;
        if (this.phase === 'done' || this.phase === 'error') this.phase = 'ready';
        this.result = this.phase === 'ready' ? undefined : this.result;
        this.renderExport();
        if (this.tab === 'output') void this.renderOutput();
        if (this.tab === 'report') this.renderTabBody();
      }),
      this.optionsBlock(),
      large ? h('div', { class: 'cc-notice is-warn', role: 'alert' }, icon('alert'), h('span', {}, largeNotice(this.largeNoticeFor))) : null,
      isPackage(this.target) && !canPickSaveFile() && isSafari() ? h('div', { class: 'cc-notice is-warn' }, icon('alert'), h('span', {}, SAFARI_UNZIP)) : null,
      this.actions.length ? h('div', { class: 'cc-host-actions' }, this.actions) : null,
    );
    this.renderConvertFoot();
  }

  private renderConvertFoot(): void {
    const foot = this.piece('convert');
    if (!foot || !this.imported) return;
    const busy = this.phase === 'converting';
    const large = !busy && isPackage(this.target) && this.largeNoticeFor > 0 && this.largeNoticeFor === this.estimateTotal();
    const go = h('button', { class: 'cc-btn cc-btn--primary cc-btn--lg cc-btn--block', type: 'button', disabled: busy },
      icon(busy ? 'clock' : 'download'),
      busy ? 'Converting…' : large ? 'Convert anyway' : isPackage(this.target) ? 'Convert & save .zip' : 'Convert & download');
    go.addEventListener('click', () => void this.convert());
    replace(foot,
      h('p', { class: 'cc-filename', title: this.suggestedName() }, icon('file', 15), h('span', {}, this.suggestedName())),
      go,
      busy && isPackage(this.target) ? this.progressBlock() : null,
    );
    if (busy) this.renderProgress();
  }

  private progressBlock(): HTMLElement {
    const cancel = h('button', { class: 'cc-btn cc-btn--sm cc-btn--quiet', type: 'button' }, icon('x', 16), 'Cancel');
    cancel.addEventListener('click', () => this.cancel());
    return h('div', { class: 'cc-progress', 'data-part': 'progress' },
      h('div', { class: 'cc-bar', role: 'progressbar', 'aria-label': 'Converting' }, h('i', { style: 'width:0%' })),
      h('div', { class: 'cc-progress__row' }, h('span', { 'data-part': 'progress-text' }, 'Starting…'), cancel));
  }

  private renderProgress(): void {
    const bar = this.root.querySelector<HTMLElement>('[data-part="progress"] .cc-bar > i');
    const text = this.piece('progress-text');
    const pct = this.progress.total > 0 ? Math.min(100, (this.progress.bytes / this.progress.total) * 100) : 0;
    if (bar) bar.style.width = `${pct.toFixed(1)}%`;
    if (text) text.textContent = `${pct ? `${Math.floor(pct)}% · ` : ''}${formatCount(this.progress.entries)} files · ${formatBytes(this.progress.bytes)}`;
  }

  private howTo(format: ExportFormatId): HTMLElement | null {
    const target = importTarget(format);
    if (!target) return null;
    return h('details', { class: 'cc-disclosure', open: true },
      h('summary', {}, icon('book', 16), h('span', {}, `How to import · ${target.app} ${target.client}`), icon('chevronDown', 16)),
      h('ol', { class: 'cc-howto' }, target.steps.map((st) => h('li', {}, st))),
      h('ul', { class: 'cc-notes' }, target.limits.map((l) => h('li', {}, l))),
      target.sources.length
        ? h('p', { class: 'cc-hint' }, 'Read from: ', target.sources.flatMap((src, i) => [i ? ' · ' : '', h('a', { href: src.url, target: '_blank', rel: 'noopener noreferrer' }, src.label)]))
        : null);
  }

  private renderResult(): HTMLElement | null {
    const r = this.result;
    if (!r || this.phase !== 'done') return null;
    const s = r.summary;
    const counts = (rec: Record<string, number>, tone: string): HTMLElement[] =>
      Object.entries(rec).map(([k, n]) => h('span', { class: `cc-chip ${tone}` }, `${k} · ${formatCount(n)}`));
    return h('div', { class: 'cc-result', role: 'status' },
      h('div', { class: 'cc-result__head' },
        h('span', { class: 'cc-result__icon' }, icon('checkCircle', 22)),
        h('div', {},
          h('p', { class: 'cc-result__title' }, r.streamed ? 'Saving to your downloads' : 'Saved'),
          h('p', { class: 'cc-result__file' }, r.fileName, r.archiveBytes ? ` · ${formatBytes(r.archiveBytes)}` : ''))),
      s
        ? h('div', { class: 'cc-stats cc-stats--3' },
            h('div', { class: `cc-stat ${s.messagesOut === s.messagesIn ? 'is-ok' : 'is-warn'}` }, h('span', { class: 'cc-stat__label' }, 'Messages'), h('span', { class: 'cc-stat__value' }, formatCount(s.messagesOut)), h('span', { class: 'cc-stat__sub' }, `of ${formatCount(s.messagesIn)}`)),
            h('div', { class: 'cc-stat' }, h('span', { class: 'cc-stat__label' }, 'Media'), h('span', { class: 'cc-stat__value' }, formatCount(s.mediaWritten)), h('span', { class: 'cc-stat__sub' }, 'files written')),
            h('div', { class: 'cc-stat' }, h('span', { class: 'cc-stat__label' }, 'Omitted'), h('span', { class: 'cc-stat__value' }, formatCount(s.mediaOmitted)), h('span', { class: 'cc-stat__sub' }, 'markers')))
        : null,
      s && Object.keys(s.dropped).length ? h('div', { class: 'cc-chips' }, h('span', { class: 'cc-eyebrow' }, 'Not carried'), counts(s.dropped, 'is-warn')) : null,
      s && Object.keys(s.approximated).length ? h('div', { class: 'cc-chips' }, h('span', { class: 'cc-eyebrow' }, 'Rewritten'), counts(s.approximated, '')) : null,
      r.warnings.length ? h('ul', { class: 'cc-notes' }, r.warnings.map((w) => h('li', {}, w))) : null,
      this.howTo(this.target),
      r.opfsName
        ? h('div', { class: 'cc-row' },
            h('button', { class: 'cc-btn cc-btn--sm', type: 'button', onclick: () => void downloadFromOpfs(r.opfsName!, r.fileName) }, icon('download', 16), 'Download again'),
            h('button', { class: 'cc-btn cc-btn--sm cc-btn--quiet', type: 'button', onclick: () => void this.removeStored() }, icon('trash', 16),
              `Remove from browser storage${r.archiveBytes ? ` (${formatBytes(r.archiveBytes)})` : ''}`))
        : null,
    );
  }

  // ---------------------------------------------------------------- preview pane

  private renderPreviewTabs(): HTMLElement {
    const tabs = h('div', { class: 'cc-tabs', role: 'tablist', 'aria-label': 'Preview' });
    const items: Array<[typeof this.tab, string, IconName]> = [['chat', 'Chat', 'message'], ['output', 'Output', 'code'], ['report', 'Report', 'checkCircle']];
    for (const [id, label, name] of items) {
      const b = h('button', { class: 'cc-tabs__item', type: 'button', role: 'tab', 'aria-selected': String(this.tab === id) }, icon(name, 16), h('span', {}, label));
      b.addEventListener('click', () => {
        for (const other of tabs.children) other.setAttribute('aria-selected', 'false');
        b.setAttribute('aria-selected', 'true');
        this.tab = id;
        this.renderTabBody();
      });
      tabs.append(b);
    }
    return tabs;
  }

  private renderTabBody(): void {
    const body = this.piece('body');
    if (!body) return;
    const tools = this.piece('preview-tools');
    if (this.tab === 'chat') {
      const viewport = h('div', { class: 'cc-vl cc-chatview', tabindex: 0, 'aria-label': 'Messages' });
      replace(body, viewport);
      this.list = undefined;
      this.refreshPreview(viewport);
      return;
    }
    if (tools) replace(tools);
    this.list = undefined;
    if (this.tab === 'output') {
      replace(body, h('div', { class: 'cc-output' }, h('p', { class: 'cc-output__name', 'data-part': 'output-name' }), h('pre', { class: 'cc-output__text', 'data-part': 'output' }, 'Building the output preview…')));
      void this.renderOutput();
      return;
    }
    replace(body, this.renderReport());
  }

  private async renderOutput(): Promise<void> {
    const pre = this.piece('output');
    const name = this.piece('output-name');
    if (!pre || !this.imported) return;
    try {
      const res = await this.worker().call({
        action: 'export',
        importId: this.importId,
        conversationIndex: this.current,
        edits: this.edits,
        target: this.target,
        exportOptions: { order: this.order, whatsapp: this.whatsappOptions() },
      });
      if (res.ok && res.action === 'export') {
        const file = res.artifact.files[0];
        const text = file ? new TextDecoder().decode(file.bytes.subarray(0, 200_000)) : '';
        const lines = text.split(/\r?\n/).slice(0, 400);
        if (name) replace(name, icon('fileText', 15), h('span', {}, file?.name ?? ''), isPackage(this.target) ? h('span', { class: 'cc-muted' }, ' · inside the .zip') : null, h('span', { class: 'cc-muted' }, ` · first ${formatCount(lines.length)} lines`));
        pre.textContent = `${lines.join('\n')}${text.length >= 200_000 || lines.length >= 400 ? '\n…' : ''}`;
      }
    } catch (e) {
      pre.textContent = e instanceof Error ? e.message : String(e);
    }
  }

  private renderReport(): HTMLElement {
    const r = this.result;
    if (!r) {
      return h('div', { class: 'cc-empty' },
        h('span', { class: 'cc-empty__icon' }, icon('checkCircle', 26)),
        h('p', { class: 'cc-empty__title' }, 'No report yet'),
        h('p', {}, 'Convert once to see what the format kept, rewrote and left out.'),
        h('button', { class: 'cc-btn cc-btn--sm', type: 'button', onclick: () => this.setFocus('export') }, icon('download', 16), 'Go to Export'));
    }
    const asText = (isPackage(this.target) || this.target === 'whatsapp-txt') &&
      r.report.entries.some((e) => e.status === 'dropped' && ['replies', 'forwards', 'edits'].includes(e.capability));
    const groups: Array<['preserved' | 'approximated' | 'dropped', IconName]> = [['preserved', 'checkCircle'], ['approximated', 'swap'], ['dropped', 'minusCircle']];
    return h('div', { class: 'cc-report' },
      h('div', { class: 'cc-stats cc-stats--3' },
        h('div', { class: 'cc-stat' }, h('span', { class: 'cc-stat__label' }, 'Messages'), h('span', { class: 'cc-stat__value' }, formatCount(r.report.stats.messages))),
        h('div', { class: 'cc-stat' }, h('span', { class: 'cc-stat__label' }, 'People'), h('span', { class: 'cc-stat__value' }, formatCount(r.report.stats.participants))),
        h('div', { class: 'cc-stat' }, h('span', { class: 'cc-stat__label' }, 'Attachments'), h('span', { class: 'cc-stat__value' }, formatCount(r.report.stats.attachments)))),
      r.report.entries.length
        ? groups.map(([status, name]) => {
            const entries = r.report.entries.filter((e) => e.status === status);
            if (!entries.length) return null;
            return h('div', { class: `cc-reportgroup is-${status}` },
              h('p', { class: 'cc-reportgroup__title' }, icon(name, 16), STATUS_WORD[status] ?? status),
              h('ul', {}, entries.map((e) => h('li', {}, h('span', {}, e.capability), e.count ? h('span', { class: 'cc-muted' }, formatCount(e.count)) : null))));
          })
        : h('p', {}, 'Nothing lost: everything maps to this format.'),
      r.report.entries.some((e) => e.status !== 'preserved')
        ? h('p', { class: 'cc-hint' }, 'Kept: in the output as it was. Rewritten: in the output in another form. Not carried: the format has no place for it; the messages themselves are still written.')
        : null,
      asText
        ? h('div', { class: 'cc-notice is-info' }, icon('info'), h('span', {}, 'WhatsApp’s format has no replies, forwards or edit marks. To keep them as text, switch on Reply quotes, Forward labels and Edit marks under Export → Options, then convert again.'))
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
    const tools = this.piece('preview-tools');
    if (tools) {
      const jump = h('input', { type: 'date', class: 'cc-input cc-input--sm', 'aria-label': 'Jump to date', title: 'Jump to date' });
      const bounds = dateBounds(this.imported);
      if (bounds) {
        jump.min = dateInput(bounds.min, this.timeZone);
        jump.max = dateInput(bounds.max, this.timeZone);
        // An empty date field shows today's date in Safari; show where the chat starts instead.
        jump.value = this.order === 'newest-first' ? jump.max : jump.min;
      }
      jump.addEventListener('click', () => {
        try {
          (jump as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
        } catch {
          /* the native control opens its own picker */
        }
      });
      jump.addEventListener('change', () => {
        const [y, m, d] = jump.value.split('-').map(Number);
        if (!y || !m || !d) return;
        const t = zonedTimeToUtc({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, this.timeZone);
        const idx = this.order === 'newest-first' ? this.shown.findIndex((x) => x.ts <= t + 86_399_999) : this.shown.findIndex((x) => x.ts >= t);
        this.list?.scrollToIndex(idx < 0 ? this.shown.length - 1 : idx);
      });
      replace(tools,
        h('span', { class: 'cc-previewhead__count', title: `${formatCount(included)} of ${formatCount(this.imported.messages.length)} messages are included` },
          `${formatCount(included)}`, h('span', { class: 'cc-hide-narrow' }, ` of ${formatCount(this.imported.messages.length)}`)),
        h('label', { class: 'cc-jump', title: 'Jump to a date' }, icon('calendar', 16), jump));
    }
    const vp = viewport ?? this.root.querySelector<HTMLElement>('.cc-chatview') ?? undefined;
    if (!vp) return;
    if (!this.list) {
      this.list = new VirtualList(vp, this.shown.length, (i) => this.bubble(i), 56);
      if (this.keepScroll && !this.jumpId) {
        vp.scrollTop = this.keepScroll;
        this.keepScroll = 0;
      }
    } else this.list.reset(this.shown.length);
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
    const prev = i > 0 ? this.shown[i - 1] : undefined;
    const removed = (this.edits.removedIds ?? []).includes(m.id);
    const newDay = !prev || dayKey(prev, this.timeZone) !== dayKey(m, this.timeZone);
    const cont = !newDay && !!prev && !isEvent(prev) && !isEvent(m) && prev.senderId === m.senderId && Math.abs(m.ts - prev.ts) < 5 * 60_000;
    const toggle = h('button', { class: 'cc-msg__toggle', type: 'button', 'aria-label': removed ? 'Put back in the output' : 'Leave out of the output', title: removed ? 'Put back in the output' : 'Leave out of the output' },
      icon(removed ? 'plusCircle' : 'minusCircle', 18));
    toggle.addEventListener('click', () => {
      const set = new Set(this.edits.removedIds ?? []);
      if (set.has(m.id)) set.delete(m.id);
      else set.add(m.id);
      this.edits = { ...this.edits, removedIds: [...set] };
      this.list?.refresh();
      this.changed();
    });
    const day = newDay ? h('div', { class: 'cc-day' }, h('span', {}, longDay(m, this.timeZone))) : null;
    const time = h('span', { class: 'cc-bubble__time', title: `${longDay(m, this.timeZone)} ${clock(m, this.timeZone)}` },
      removed ? h('span', { class: 'cc-bubble__out' }, 'left out · ') : null,
      m.editedAt ? 'edited · ' : '',
      clock(m, this.timeZone));
    const state = `${removed ? ' is-removed' : ''}${m.id === this.jumpId ? ' is-jump' : ''}${cont ? ' is-cont' : ''}`;
    const row = isEvent(m) ? this.eventRow(m, state, day, toggle) : this.messageRow(m, state, day, cont, time, toggle);
    // Touch screens have no hover: a tap on a message shows its leave-out button.
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a, button') || !window.matchMedia('(hover: none)').matches) return;
      row.classList.toggle('is-picked');
    });
    return row;
  }

  private eventRow(m: Message, state: string, day: HTMLElement | null, toggle: HTMLElement): HTMLElement {
    return h('div', { class: `cc-msg cc-msg--event${state}` },
      day,
      h('div', { class: 'cc-msg__line' },
        h('div', { class: 'cc-event' }, m.kind === 'call' ? icon('phone', 14) : null, this.richText(m), h('span', { class: 'cc-event__time' }, clock(m, this.timeZone))),
        toggle));
  }

  private messageRow(m: Message, state: string, day: HTMLElement | null, cont: boolean, time: HTMLElement, toggle: HTMLElement): HTMLElement {
    const p = m.senderId ? this.names.get(m.senderId) : undefined;
    const name = p?.displayName ?? 'Unknown';
    const mine = !!this.selfId && m.senderId === this.selfId;
    const structured = m.poll || m.checklist || m.location || m.contact;
    return h('div', { class: `cc-msg ${mine ? 'cc-msg--out' : 'cc-msg--in'}${state}` },
      day,
      h('div', { class: 'cc-msg__line' },
        h('div', { class: 'cc-bubble' },
          cont ? null : h('div', { class: 'cc-bubble__who', style: `--who-hue:${hue(name)}` }, name, m.viaBot ? h('span', { class: 'cc-muted' }, ` via ${m.viaBot}`) : null),
          m.forwardedFrom ? h('div', { class: 'cc-bubble__meta' }, icon('forward', 14), `Forwarded from ${m.forwardedFrom.name ?? 'someone'}`) : null,
          m.replyToId ? h('div', { class: 'cc-bubble__meta' }, icon('reply', 14), 'Reply') : null,
          this.mediaBlock(m),
          structured || !m.content ? null : h('div', { class: 'cc-bubble__text' }, this.richText(m)),
          m.meta?.['contentUnavailable'] ? h('div', { class: 'cc-bubble__meta' }, icon('info', 14), 'Not in the export') : null,
          m.meta?.['snap'] ? h('div', { class: 'cc-bubble__meta' }, icon('image', 14), 'Snap') : null,
          m.reactions?.length ? h('div', { class: 'cc-bubble__reactions' }, m.reactions.map((r) => h('span', {}, `${r.emoji}${r.count && r.count > 1 ? ` ${r.count}` : ''}`))) : null,
          time),
        toggle));
  }

  private mediaBlock(m: Message): HTMLElement | null {
    const parts: HTMLElement[] = [];
    for (const a of m.attachments ?? []) {
      const state = a.present ? 'is-ok' : a.omitted === 'missing' ? 'is-error' : 'is-warn';
      const label = a.present ? 'in export' : a.omitted === 'not_included' ? 'not exported' : a.omitted === 'too_large' ? 'over size limit' : a.omitted === 'missing' ? 'missing' : 'unavailable';
      const kind = a.kind === 'sticker' && a.stickerFormat && a.stickerFormat !== 'webp' ? `${a.stickerFormat} sticker` : a.kind;
      parts.push(
        h('div', { class: `cc-att ${state}` },
          h('span', { class: 'cc-att__icon' }, icon(KIND_ICON[a.kind] ?? 'paperclip', 18)),
          h('span', { class: 'cc-att__text' },
            h('span', { class: 'cc-att__kind' }, `${kind}${a.emoji ? ` ${a.emoji}` : ''}`, a.size ? h('span', { class: 'cc-muted' }, ` · ${formatBytes(a.size)}`) : null),
            a.fileName ? h('span', { class: 'cc-att__name' }, a.fileName) : null),
          h('span', { class: 'cc-att__state' }, label)),
      );
    }
    const card = (name: IconName, title: string, items?: string[]): HTMLElement =>
      h('div', { class: 'cc-att is-card' }, h('span', { class: 'cc-att__icon' }, icon(name, 18)),
        h('span', { class: 'cc-att__text' }, h('span', { class: 'cc-att__kind' }, title), items?.length ? h('ul', {}, items.map((t) => h('li', {}, t))) : null));
    if (m.poll) parts.push(card('poll', m.poll.question, m.poll.options.map((o) => `${o.text}${o.votes !== undefined ? ` — ${o.votes}` : ''}${o.chosen ? ' ✓' : ''}`)));
    if (m.checklist) parts.push(card('checklist', m.checklist.title, m.checklist.items.map((it) => it.text)));
    if (m.location) parts.push(card('pin', `${m.location.live ? 'Live location · ' : ''}${[m.location.name, m.location.address].filter(Boolean).join(', ') || 'Location'}`, [`${m.location.lat}, ${m.location.lng}`]));
    if (m.contact) parts.push(card('contact', [m.contact.firstName, m.contact.lastName].filter(Boolean).join(' ') || 'Contact', [m.contact.phone ?? '', m.contact.vcardRef ? 'vCard' : ''].filter(Boolean)));
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

  private setInboxPane(pane: 'list' | 'batch'): void {
    this.inboxPane = pane;
    const app = this.root.querySelector<HTMLElement>('.cc-app--inbox');
    if (app) app.dataset['focus'] = pane;
    this.renderTabbar();
  }

  private renderInbox(): void {
    const a = this.archive!;
    const more = this.iconButton('more', 'More actions', () => this.openInboxMenu(more));
    const title = a.name || this.sourceName || platformLabel(this.detected);
    const app = h('div', { class: 'cc-app cc-app--inbox', 'data-focus': this.inboxPane },
      h('header', { class: 'cc-topbar' },
        h('span', { class: 'cc-topbar__mark', style: appStyle(this.detected), 'aria-hidden': 'true' }, platformLabel(this.detected).slice(0, 1)),
        h('div', { class: 'cc-topbar__titles' },
          h('h2', { class: 'cc-topbar__title' }, `${platformLabel(this.detected)}${a.variant ? ` · ${variantLabel(a.variant)}` : ''}`),
          h('p', { class: 'cc-topbar__sub' },
            h('span', {}, `${formatCount(a.conversations)} conversations`),
            h('span', {}, `${formatCount(a.messages)} messages`),
            a.firstTs && a.lastTs ? h('span', { class: 'cc-hide-narrow' }, `${formatDay(a.firstTs, this.timeZone)} – ${formatDay(a.lastTs, this.timeZone)}`) : null,
            a.media.total ? h('span', { class: `cc-hide-narrow${a.media.present === a.media.total ? '' : ' is-warn'}` }, `${formatCount(a.media.present)}/${formatCount(a.media.total)} media`) : null)),
        h('div', { class: 'cc-topbar__actions' },
          this.archiveWarnings.length
            ? (() => {
                const b = h('button', { class: 'cc-pill is-warn', type: 'button', 'aria-label': `${this.archiveWarnings.length} notes about this export` }, icon('info', 16), h('span', {}, String(this.archiveWarnings.length)));
                b.addEventListener('click', () => this.showNotes(this.archiveWarnings, b));
                return b;
              })()
            : null,
          more)),
      h('div', { class: 'cc-body cc-body--inbox' },
        h('section', { class: 'cc-pane cc-pane--list', 'data-pane': 'list', 'aria-label': `Conversations in ${title}` },
          this.renderInboxTools(),
          h('div', { class: 'cc-inbox__status', 'data-part': 'inbox-status' }),
          h('div', { class: 'cc-vl cc-vl--inbox', 'data-part': 'inbox-list', tabindex: 0, 'aria-label': 'Conversations' })),
        h('section', { class: 'cc-pane cc-pane--batch', 'data-pane': 'batch', 'aria-label': 'Convert several' },
          h('div', { class: 'cc-pane__head' }, h('h3', { class: 'cc-pane__title' }, 'Convert several')),
          h('div', { class: 'cc-pane__scroll', 'data-part': 'batch' }),
          h('div', { class: 'cc-pane__foot', 'data-part': 'batch-foot' })),
      ),
      h('nav', { class: 'cc-tabbar cc-tabbar--2', 'data-part': 'tabbar', 'aria-label': 'Sections' }),
    );
    replace(this.stage, app);
    this.inboxList = undefined;
    this.hitsList = undefined;
    this.refreshInbox();
    this.renderBatch();
    this.renderTabbar();
  }

  private openInboxMenu(anchor: HTMLElement): void {
    const zones = supportedZones();
    openMenu([
      { label: 'Open another export', icon: 'upload', onSelect: () => this.startOver() },
      { label: 'Select all shown', icon: 'check', disabled: !this.filtered.length, onSelect: () => this.selectShown(true) },
      { label: 'Clear selection', icon: 'x', disabled: !this.selected.size, onSelect: () => this.selectShown(false, true) },
      'separator',
      {
        label: 'Time zone',
        hint: this.timeZone.replace(/_/g, ' '),
        icon: 'clock',
        onSelect: () => {
          const sel = h('select', { class: 'cc-input', 'aria-label': 'Time zone' }, zones.map((z) => h('option', { value: z, selected: z === this.timeZone }, z.replace(/_/g, ' '))));
          const o = openOverlay([sel, h('p', { class: 'cc-hint' }, 'Wall-clock times in the export (HTML pages, WhatsApp) are read in this zone, and every time is shown in it.')],
            { host: this.root, anchor, label: 'Time zone', title: 'Time zone', width: 340 });
          sel.addEventListener('change', () => {
            this.timeZone = sel.value;
            o.close();
            void this.runImport();
          });
          sel.focus();
        },
      },
      this.archiveWarnings.length ? { label: 'Notes about this export', icon: 'info', onSelect: () => this.showNotes(this.archiveWarnings, anchor) } : null,
      ...this.exportSwitchEntries(),
    ], { host: this.root, anchor, label: 'More actions' });
  }

  private selectShown(on: boolean, all = false): void {
    if (all && !on) this.selected.clear();
    else for (const r of this.filtered) on ? this.selected.add(r.index) : this.selected.delete(r.index);
    this.refreshInbox();
    this.renderBatch();
    this.renderTabbar();
  }

  private renderInboxTools(): HTMLElement {
    const search = h('input', {
      type: 'search',
      class: 'cc-input cc-search__input',
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
    }, 'Search in', 'cc-seg--sm');

    const chipSelect = (label: string, name: IconName, options: Array<[string, string]>, value: string, onPick: (v: string) => void): HTMLElement => {
      const sel = h('select', { 'aria-label': label }, options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)));
      sel.addEventListener('change', () => onPick(sel.value));
      return h('label', { class: 'cc-chipselect' }, icon(name, 15), sel, icon('chevronDown', 14));
    };
    const sort = chipSelect('Sort', 'sort', [['recent', 'Latest activity'], ['oldest', 'Oldest first'], ['messages', 'Most messages'], ['name', 'Name A–Z']], this.inbox.sort, (v) => {
      this.inbox.sort = v as InboxState['sort'];
      this.refreshInbox();
    });
    const folders = folderCounts(this.rows);
    const folder = folders.length > 1
      ? chipSelect('Folder', 'folder', [['all', `All folders (${formatCount(this.rows.length)})`], ...folders.map(([f, n]): [string, string] => [f, `${folderLabel(f)} (${formatCount(n)})`])], this.inbox.folder, (v) => {
          this.inbox.folder = v;
          this.refreshInbox();
        })
      : null;
    const groups = this.rows.filter((r) => r.kind !== 'dm').length;
    const kind = groups && groups < this.rows.length
      ? chipSelect('Kind', 'users', [['all', 'All chats'], ['dm', 'Private'], ['group', 'Groups']], this.inbox.kind, (v) => {
          this.inbox.kind = v as InboxState['kind'];
          this.refreshInbox();
        })
      : null;
    const media = this.rows.some((r) => r.media.total)
      ? (() => {
          const box = h('input', { type: 'checkbox', checked: this.inbox.withMedia });
          const chip = h('label', { class: `cc-chiptoggle${this.inbox.withMedia ? ' is-on' : ''}` }, box, icon('image', 15), 'With media');
          box.addEventListener('change', () => {
            this.inbox.withMedia = box.checked;
            chip.classList.toggle('is-on', box.checked);
            this.refreshInbox();
          });
          return chip;
        })()
      : null;

    return h('div', { class: 'cc-inbox__tools' },
      h('div', { class: 'cc-search' }, h('span', { class: 'cc-search__icon' }, icon('search', 17)), search),
      h('div', { class: 'cc-filters' }, scope, sort, folder, kind, media),
    );
  }

  /** Re-filters the list (or shows search hits) without rebuilding the toolbar, so typing keeps focus. */
  private refreshInbox(): void {
    const status = this.piece('inbox-status');
    const vp = this.piece('inbox-list');
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
      replace(status, h('span', {}, this.searching ? 'Searching…' : this.hitsTotal
        ? `${formatCount(this.hitsTotal)} message${this.hitsTotal === 1 ? '' : 's'} in ${formatCount(chats)} conversation${chats === 1 ? '' : 's'}${this.hitsTotal > this.hits.length ? ` — first ${formatCount(this.hits.length)} shown` : ''}`
        : 'No message matches.'));
      const hit = (i: number): HTMLElement => renderHit(this.hits[i]!, byIndex.get(this.hits[i]!.index), this.timeZone, (index, messageId) => void this.openConversation(index, messageId));
      if (!this.hitsList) this.hitsList = new VirtualList(fresh(), this.hits.length, hit, 76);
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
    all.addEventListener('change', () => this.selectShown(all.checked));
    replace(status,
      h('label', { class: 'cc-inbox__all' }, all, h('span', {}, `${formatCount(this.filtered.length)}${this.filtered.length !== this.rows.length ? ` of ${formatCount(this.rows.length)}` : ''} conversations`)),
      this.selected.size
        ? h('button', { class: 'cc-btn cc-btn--sm cc-btn--quiet', type: 'button', onclick: () => this.selectShown(false, true) }, `${formatCount(this.selected.size)} selected`, icon('x', 14))
        : null,
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
          this.renderTabbar();
        },
        onOpen: (index) => void this.openConversation(index),
      });
    };
    const target = this.piece('inbox-list')!;
    if (!this.inboxList) this.inboxList = new VirtualList(target, this.filtered.length, row, 72);
    else this.inboxList.reset(this.filtered.length);
    if (!this.filtered.length) {
      target.append(h('div', { class: 'cc-empty cc-empty--overlay' }, icon('search', 24), h('p', {}, 'No conversation matches these filters.')));
    }
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
    const pane = this.piece('batch');
    const foot = this.piece('batch-foot');
    if (!pane || !foot) return;
    const n = this.selected.size;
    const picked = this.rows.filter((x) => this.selected.has(x.index));
    const universal = this.batchTarget === 'universalchat' || this.batchTarget === 'universalchat-zip';
    const how = universal
      ? 'One archive holding every selected conversation.'
      : isPackage(this.batchTarget)
        ? 'One download with a .zip per conversation inside; each inner .zip is the file to share to Telegram.'
        : 'One download with a file per conversation.';
    const large = !this.batchRunning && n > 0 && this.largeNoticeFor > 0 && this.largeNoticeFor === this.batchEstimate();
    const r = this.batchResult;
    replace(pane,
      r
        ? h('div', { class: 'cc-result', role: 'status' },
            h('div', { class: 'cc-result__head' },
              h('span', { class: 'cc-result__icon' }, icon('checkCircle', 22)),
              h('div', {}, h('p', { class: 'cc-result__title' }, r.streamed ? 'Saving to your downloads' : 'Saved'), h('p', { class: 'cc-result__file' }, r.fileName, ` · ${formatBytes(r.archiveBytes)}`))),
            h('div', { class: 'cc-stats cc-stats--3' },
              h('div', { class: 'cc-stat' }, h('span', { class: 'cc-stat__label' }, 'Chats'), h('span', { class: 'cc-stat__value' }, formatCount(r.conversations))),
              h('div', { class: `cc-stat ${r.messagesOut === r.messagesIn ? 'is-ok' : 'is-warn'}` }, h('span', { class: 'cc-stat__label' }, 'Messages'), h('span', { class: 'cc-stat__value' }, formatCount(r.messagesOut)), h('span', { class: 'cc-stat__sub' }, `of ${formatCount(r.messagesIn)}`)),
              h('div', { class: 'cc-stat' }, h('span', { class: 'cc-stat__label' }, 'Media'), h('span', { class: 'cc-stat__value' }, formatCount(r.mediaWritten)))),
            r.files.length ? h('details', { class: 'cc-disclosure' }, h('summary', {}, icon('folder', 16), h('span', {}, `${formatCount(r.files.length)} files inside`), icon('chevronDown', 16)), h('ul', { class: 'cc-notes' }, r.files.map((f) => h('li', {}, `${f.name} · ${formatBytes(f.bytes)}`)))) : null,
            r.warnings.length ? h('details', { class: 'cc-disclosure' }, h('summary', {}, icon('info', 16), h('span', {}, `${formatCount(r.warnings.length)} notes`), icon('chevronDown', 16)), h('ul', { class: 'cc-notes' }, r.warnings.map((w) => h('li', {}, w)))) : null,
            r.opfsName
              ? h('div', { class: 'cc-row' },
                  h('button', { class: 'cc-btn cc-btn--sm', type: 'button', onclick: () => void downloadFromOpfs(r.opfsName!, r.fileName) }, icon('download', 16), 'Download again'),
                  h('button', { class: 'cc-btn cc-btn--sm cc-btn--quiet', type: 'button', onclick: () => void this.removeStored() }, icon('trash', 16), `Remove from browser storage (${formatBytes(r.archiveBytes)})`))
              : null)
        : null,
      this.batchError ? h('div', { class: 'cc-notice is-error', role: 'alert' }, icon('alert'), h('span', {}, this.batchError)) : null,
      n
        ? h('div', { class: 'cc-selection' },
            h('div', { class: 'cc-selection__avatars', 'aria-hidden': 'true' }, picked.slice(0, 4).map((x) => avatar(x.title, 'sm'))),
            h('div', {},
              h('p', { class: 'cc-selection__title' }, `${formatCount(n)} conversation${n === 1 ? '' : 's'} selected`),
              h('p', { class: 'cc-hint' }, `${formatCount(picked.reduce((s, x) => s + x.messageCount, 0))} messages${this.batchEstimate() ? ` · ${formatBytes(this.batchEstimate())} of media` : ''}`)))
        : h('div', { class: 'cc-empty' },
            h('span', { class: 'cc-empty__icon' }, icon('layers', 26)),
            h('p', { class: 'cc-empty__title' }, 'Select conversations'),
            h('p', {}, 'Tick conversations in the list to convert them in one download, or open one to check and convert it on its own.')),
      this.formatPicker(this.batchTarget, (f) => {
        this.batchTarget = f;
        this.largeNoticeFor = 0;
        this.renderBatch();
      }),
      h('p', { class: 'cc-hint' }, how, ' What you set on a conversation (names, “Me”, dates, left-out messages) is applied.'),
      large ? h('div', { class: 'cc-notice is-warn', role: 'alert' }, icon('alert'), h('span', {}, largeNotice(this.largeNoticeFor))) : null,
      n && !canPickSaveFile() && isSafari() && batchFileName(this.batchTarget, 'x', n).endsWith('.zip')
        ? h('div', { class: 'cc-notice is-warn' }, icon('alert'), h('span', {}, SAFARI_UNZIP))
        : null,
    );
    const go = h('button', { class: 'cc-btn cc-btn--primary cc-btn--lg cc-btn--block', type: 'button', disabled: !n || this.batchRunning },
      icon(this.batchRunning ? 'clock' : 'download'),
      this.batchRunning ? 'Converting…' : large ? 'Convert anyway' : n ? `Convert ${formatCount(n)} conversation${n === 1 ? '' : 's'}` : 'Select conversations');
    go.addEventListener('click', () => void this.runBatch());
    replace(foot, go, this.batchRunning ? this.progressBlock() : null);
    if (this.batchRunning) this.renderProgress();
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
    this.renderTabbar();
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
        this.toast(`Saved ${res.suggestedName} · ${formatBytes(res.archiveBytes)}`);
        this.emit('cc-converted', { target: this.batchTarget, fileName: res.suggestedName, conversations: res.conversations });
      }
    } catch (e) {
      this.batchError = e instanceof Error && e.name === 'AbortError' ? 'Conversion cancelled.' : e instanceof Error ? e.message : String(e);
    }
    if (streamed) void streamed.done.catch(() => undefined).finally(() => streamed.dispose());
    this.batchRunning = false;
    this.runningId = '';
    this.renderBatch();
    this.renderTabbar();
    this.piece('batch')?.scrollTo({ top: 0 });
  }

  // ---------------------------------------------------------------- small widgets

  private segmented(items: Array<[string, string, IconName?]>, value: string, onPick: (v: string) => void, label: string, cls = ''): HTMLElement {
    const seg = h('div', { class: `cc-seg ${cls}`, role: 'radiogroup', 'aria-label': label });
    for (const [v, text, name] of items) {
      const b = h('button', { class: 'cc-seg__item', type: 'button', role: 'radio', 'aria-checked': String(v === value), 'data-value': v }, name ? icon(name, 15) : null, h('span', {}, text));
      b.addEventListener('click', () => {
        this.syncSegmented(seg, v);
        onPick(v);
      });
      seg.append(b);
    }
    return seg;
  }

  private syncSegmented(seg: HTMLElement, value: string): void {
    for (const b of seg.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset['value'] === value));
  }
}

export function defineChatConverter(tag = 'chat-converter-app'): void {
  if (!customElements.get(tag)) customElements.define(tag, ChatConverterElement);
}
