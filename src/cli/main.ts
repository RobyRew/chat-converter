/**
 * Command-line converter for exports too large for a browser tab, and for scripted checks.
 * Run from the repo: `npm run cli -- <command> …` (tsx transpiles the TypeScript sources).
 */
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  applyEdits,
  exportConversation,
  FORMAT_META,
  importConversation,
  IMPORT_TARGETS,
  listExports,
  packageFormatIds,
  splitConversation,
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
  inspect <path>              What an export holds (folder, .zip, result.json, messages.html, _chat.txt)
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

async function inspect(path: string, tz?: string): Promise<void> {
  const exportsFound = await listExports(await sourceFromPath(path));
  for (const [i, source] of exportsFound.entries()) {
    const { conversation: c, detectedPlatform, warnings } = await importConversation(source, tz ? { timeZone: tz } : {});
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

async function convert(path: string, values: Record<string, unknown>): Promise<void> {
  const target = values['target'] as ExportFormatId | undefined;
  if (!target || !(target in FORMAT_META)) fail(`--target must be one of: ${Object.keys(FORMAT_META).join(', ')}`);
  const tz = values['tz'] as string | undefined;
  const exportsFound = await listExports(await sourceFromPath(path));
  const source = exportsFound[Number(values['export'] ?? 0)];
  if (!source) fail(`No export #${String(values['export'])} in ${path}`);
  const imported = await importConversation(source, tz ? { timeZone: tz } : {});
  for (const w of imported.warnings) process.stderr.write(`warning: ${w}\n`);
  let conv = imported.conversation;

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
