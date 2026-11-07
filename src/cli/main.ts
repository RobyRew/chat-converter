/**
 * Command-line converter for exports too large for a browser tab, and for scripted checks.
 * Run from the repo: `npm run cli -- <command> …` (tsx transpiles the TypeScript sources).
 */
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  applyEdits,
  batchFileName,
  exportConversation,
  FORMAT_META,
  importArchive,
  IMPORT_TARGETS,
  listExports,
  packageFormatIds,
  splitConversation,
  summarizeConversation,
  writeBatch,
  writePackage,
  type Conversation,
  type Edits,
  type ExportFormatId,
  type WhatsAppPackageOptions,
} from '../index';
import { fileWritable, sourceFromPath } from '../node/index';
import { writeFile } from 'node:fs/promises';

const USAGE = `chat-converter <command> [options]

Commands:
  inspect <path>              What an export holds, and every conversation in it (folder, .zip, result.json,
                              messages.html, _chat.txt, an Instagram/Facebook/Snapchat/VSCO/Hinge download)
  convert <path> --target <format> [options]
  targets                     Where converted chats can be imported, and how

Formats: ${Object.keys(FORMAT_META).join(', ')}

Convert options:
  --out <file>                Output file (default: next to the input, named after the chat)
  --rename "Old=New"          Rename a participant (repeatable)
  --self <name>               Which participant is you (WhatsApp packages)
  --mode dm|group             Write a private-chat or a group export (WhatsApp packages)
  --title <text>              Chat title (group mode, file name)
  --tz <IANA zone>            Zone for wall-clock times (HTML exports, WhatsApp output)
  --no-service-text           Leave calls, pins and other events out of WhatsApp packages
  --animated-stickers omit|file
  --split <n>                 Write parts of at most n messages
  --export <n>                Which export to use when the input holds several (0-based)
  --chat <n|title>            Which conversation of a multi-chat export (number from inspect, or its title;
                              repeatable: several make one download)
  --all                       Every conversation of the export, in one download
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function participantByName(conv: Conversation, name: string): string {
  const p = conv.participants.find((x) => x.displayName === name);
  if (!p) fail(`No participant named "${name}". Participants: ${conv.participants.map((x) => x.displayName).join(', ')}`);
  return p.id;
}

function day(ts: number | undefined): string {
  return ts ? new Date(ts).toISOString().slice(0, 10) : '—';
}

async function inspect(path: string, tz?: string): Promise<void> {
  const exportsFound = await listExports(await sourceFromPath(path));
  for (const [i, source] of exportsFound.entries()) {
    const { archive, detectedPlatform, warnings } = await importArchive(source, tz ? { timeZone: tz } : {});
    if (archive.conversations.length > 1) {
      const rows = archive.conversations.map((c, n) => summarizeConversation(c, n));
      const total = rows.reduce((n, r) => n + r.messageCount, 0);
      process.stdout.write(
        [
          `[${i}] ${source.name}`,
          `  platform: ${detectedPlatform} (${archive.source?.variant ?? ''})  conversations: ${rows.length}  messages: ${total}`,
          ...rows.map(
            (r) =>
              `  #${String(r.index).padEnd(4)} ${r.title.slice(0, 40).padEnd(40)} ${String(r.messageCount).padStart(7)} msg  ${day(r.firstTs)} → ${day(r.lastTs)}` +
              `${r.media.total ? `  media ${r.media.present}/${r.media.total}` : ''}${r.folder ? `  [${r.folder}]` : ''}${r.flags.length ? `  ${r.flags.join(',')}` : ''}`,
          ),
          ...warnings.map((w) => `  warning: ${w}`),
          '',
        ].join('\n'),
      );
      continue;
    }
    const c = archive.conversations[0];
    if (!c) {
      process.stdout.write(`[${i}] ${source.name}\n  no conversation\n\n`);
      continue;
    }
    const att = c.messages.flatMap((m) => m.attachments ?? []);
    const omitted: Record<string, number> = {};
    for (const a of att) if (a.omitted) omitted[a.omitted] = (omitted[a.omitted] ?? 0) + 1;
    const kinds: Record<string, number> = {};
    for (const m of c.messages) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
    const first = c.messages[0];
    const last = c.messages.at(-1);
    process.stdout.write(
      [
        `[${i}] ${source.name}`,
        `  platform: ${detectedPlatform} (${String(c.meta?.['exportFormat'] ?? '')})  kind: ${c.kind}  title: ${c.title ?? '—'}`,
        `  messages: ${c.messages.length}  ${JSON.stringify(kinds)}`,
        `  people: ${c.participants.map((p) => p.displayName).join(' | ')}`,
        `  dates: ${first ? new Date(first.ts).toISOString() : '—'} → ${last ? new Date(last.ts).toISOString() : '—'}`,
        `  media: ${att.length} referenced, ${att.filter((a) => a.present).length} present, omitted ${JSON.stringify(omitted)}`,
        ...warnings.map((w) => `  warning: ${w}`),
        '',
      ].join('\n'),
    );
  }
}

/** `--chat` values → conversation indexes: a number from `inspect`, or a title (exact, then unique prefix). */
function pickChats(conversations: Conversation[], picks: string[]): number[] {
  return picks.map((pick) => {
    if (/^\d+$/.test(pick) && conversations[Number(pick)]) return Number(pick);
    const exact = conversations.findIndex((c) => c.title === pick);
    if (exact >= 0) return exact;
    const prefixed = conversations.flatMap((c, i) => (c.title?.toLowerCase().startsWith(pick.toLowerCase()) ? [i] : []));
    if (prefixed.length === 1) return prefixed[0]!;
    return fail(prefixed.length ? `"${pick}" matches ${prefixed.length} conversations; use its number from inspect` : `No conversation "${pick}"; run inspect to list them`);
  });
}

async function convert(path: string, values: Record<string, unknown>): Promise<void> {
  const target = values['target'] as ExportFormatId | undefined;
  if (!target || !(target in FORMAT_META)) fail(`--target must be one of: ${Object.keys(FORMAT_META).join(', ')}`);
  const tz = values['tz'] as string | undefined;
  const exportsFound = await listExports(await sourceFromPath(path));
  const source = exportsFound[Number(values['export'] ?? 0)];
  if (!source) fail(`No export #${String(values['export'])} in ${path}`);
  const imported = await importArchive(source, tz ? { timeZone: tz } : {});
  for (const w of imported.warnings) process.stderr.write(`warning: ${w}\n`);
  const all = imported.archive.conversations;
  const chats = values['all'] ? all.map((_, i) => i) : pickChats(all, (values['chat'] as string[] | undefined) ?? []);
  if (!chats.length && all.length > 1) fail(`This export holds ${all.length} conversations: choose with --chat <n|title> (repeatable) or --all; inspect lists them.`);

  if (chats.length > 1) {
    // One download for several conversations: renames/self/title apply per conversation where the name exists.
    const items = chats.map((i) => {
      const c = all[i]!;
      const whatsapp: WhatsAppPackageOptions = {};
      if (values['mode']) whatsapp.mode = values['mode'] as 'dm' | 'group';
      if (tz) whatsapp.timeZone = tz;
      if (values['no-service-text']) whatsapp.serviceAsText = false;
      const self = values['self'] ? c.participants.find((p) => p.displayName === values['self']) : undefined;
      if (self) whatsapp.selfId = self.id;
      const renames: Record<string, string> = {};
      for (const r of (values['rename'] as string[] | undefined) ?? []) {
        const at = r.indexOf('=');
        const p = at > 0 ? c.participants.find((x) => x.displayName === r.slice(0, at)) : undefined;
        if (p) renames[p.id] = r.slice(at + 1);
      }
      return { conversation: Object.keys(renames).length ? applyEdits(c, { renames }) : c, exportOptions: { whatsapp } };
    });
    const out = (values['out'] as string | undefined) ?? join(dirname(path), batchFileName(target, imported.archive.source?.name ?? source.name, items.length));
    const r = await writeBatch(items, { target, source, destination: fileWritable(out), name: source.name, ...(imported.archive.source ? { archiveSource: imported.archive.source } : {}) });
    for (const w of r.warnings) process.stderr.write(`warning: ${w}\n`);
    process.stdout.write(`${basename(out)}: ${r.conversations} conversations, ${r.messagesOut}/${r.messagesIn} messages, ${r.mediaWritten} media files, ${(r.archiveBytes / 1048576).toFixed(1)} MiB\n`);
    for (const f of r.files) process.stdout.write(`  ${f.name}: ${f.messagesOut} messages\n`);
    return;
  }
  let conv = all[chats[0] ?? 0];
  if (!conv) fail('The export holds no conversation');

  const edits: Edits = {};
  const renames: Record<string, string> = {};
  for (const r of (values['rename'] as string[] | undefined) ?? []) {
    const at = r.indexOf('=');
    if (at < 1) fail(`--rename expects "Old=New", got "${r}"`);
    renames[participantByName(conv, r.slice(0, at))] = r.slice(at + 1);
  }
  if (Object.keys(renames).length) edits.renames = renames;
  if (values['title']) edits.title = values['title'] as string;
  conv = applyEdits(conv, edits);

  const whatsapp: WhatsAppPackageOptions = {};
  if (values['mode']) whatsapp.mode = values['mode'] as 'dm' | 'group';
  if (values['self']) whatsapp.selfId = participantByName(conv, values['self'] as string);
  if (tz) whatsapp.timeZone = tz;
  if (values['no-service-text']) whatsapp.serviceAsText = false;
  if (values['animated-stickers']) whatsapp.animatedStickers = values['animated-stickers'] as 'omit' | 'file';

  const parts = values['split'] ? splitConversation(conv, Number(values['split'])) : [conv];
  for (const [i, part] of parts.entries()) {
    const suffix = parts.length > 1 ? ` (${i + 1} of ${parts.length})` : '';
    if (packageFormatIds.includes(target)) {
      const preview = await exportConversation(part, { target, source, exportOptions: { whatsapp } });
      const name = preview.artifact.suggestedName.replace(/\.zip$/, `${suffix}.zip`);
      const out = (values['out'] as string | undefined) ?? join(dirname(path), name);
      const file = parts.length > 1 && values['out'] ? out.replace(/\.zip$/, `${suffix}.zip`) : out;
      const result = await writePackage(part, { target, source, destination: fileWritable(file), exportOptions: { whatsapp } });
      for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
      const s = result.summary;
      process.stdout.write(
        `${basename(file)}: ${s.messagesOut}/${s.messagesIn} messages, ${s.mediaWritten} media files, ${s.mediaOmitted} omitted markers, ${(result.archiveBytes / 1048576).toFixed(1)} MiB\n` +
          `  dropped: ${JSON.stringify(s.dropped)}\n  approximated: ${JSON.stringify(s.approximated)}\n`,
      );
    } else {
      const result = await exportConversation(part, { target, source });
      const artifact = result.artifact.files[0];
      if (!artifact) fail('The exporter produced no file');
      const out = (values['out'] as string | undefined) ?? join(dirname(path), result.artifact.suggestedName);
      await writeFile(parts.length > 1 ? out.replace(/(\.[^.]+)$/, `${suffix}$1`) : out, artifact.bytes);
      process.stdout.write(`${basename(out)}: ${part.messages.length} messages\n`);
    }
  }
}

function targets(): void {
  for (const t of IMPORT_TARGETS) {
    process.stdout.write(
      [
        `${t.app} — ${t.client}  (--target ${t.format})`,
        `  accepts: ${t.accepts}`,
        `  media: ${t.carriesMedia ? 'yes' : 'no'}`,
        ...t.steps.map((s, i) => `  ${i + 1}. ${s}`),
        ...t.limits.map((l) => `  • ${l}`),
        ...t.sources.map((s) => `  source: ${s.url}`),
        '',
      ].join('\n'),
    );
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      target: { type: 'string' },
      out: { type: 'string' },
      rename: { type: 'string', multiple: true },
      self: { type: 'string' },
      mode: { type: 'string' },
      title: { type: 'string' },
      tz: { type: 'string' },
      'no-service-text': { type: 'boolean' },
      'animated-stickers': { type: 'string' },
      split: { type: 'string' },
      export: { type: 'string' },
      chat: { type: 'string', multiple: true },
      all: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, path] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }
  if (command === 'targets') return targets();
  if (!path) fail(USAGE);
  if (command === 'inspect') return inspect(path, values.tz);
  if (command === 'convert') return convert(path, values);
  fail(USAGE);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
