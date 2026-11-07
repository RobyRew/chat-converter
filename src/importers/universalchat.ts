import { readUniversalChat, type CapabilityMatrix, type Conversation, type UniversalChat } from '../model';
import { capabilities } from '../model';
import { ConversionError, type DetectResult, type Importer, type ImportInput, type ParseContext } from '../engine/contracts';
import { readHeadText, readText, type SourceFile } from '../sources/source';

/**
 * Reads a UniversalChat document (`universalchat.json`) or package (the JSON plus `media/`). In a package,
 * attachment refs are pointed at the package paths from each conversation's media manifest, and the path
 * the original export used is kept under `ext.universalchat.originalRef`.
 */
const caps = Object.fromEntries(capabilities.map((c) => [c, true])) as CapabilityMatrix;

async function findDocument(files: readonly SourceFile[]): Promise<SourceFile | undefined> {
  const named = files.find((f) => f.path === 'universalchat.json' || /(^|\/)[^/]*\.universalchat\.json$/i.test(f.path));
  if (named) return named;
  for (const f of files) {
    if (!/\.json$/i.test(f.path)) continue;
    if (/"format"\s*:\s*"UniversalChat"/.test(await readHeadText(f, 512))) return f;
  }
  return undefined;
}

function relink(archive: UniversalChat, ctx: ParseContext): UniversalChat {
  for (const c of archive.conversations) {
    const byRef = new Map((c.media ?? []).filter((x) => x.path && ctx.media.has(x.path)).map((x) => [x.ref, x.path!]));
    if (!byRef.size) continue;
    for (const m of c.messages) {
      for (const a of m.attachments ?? []) {
        const path = a.ref ? byRef.get(a.ref) : undefined;
        if (!path || !a.ref) continue;
        a.ext = { ...a.ext, universalchat: { ...a.ext?.['universalchat'], originalRef: a.ref } };
        a.ref = path;
        a.present = true;
        delete a.omitted;
        if (a.thumbnailRef && byRef.has(a.thumbnailRef)) a.thumbnailRef = byRef.get(a.thumbnailRef)!;
      }
      if (m.contact?.vcardRef && byRef.has(m.contact.vcardRef)) m.contact.vcardRef = byRef.get(m.contact.vcardRef)!;
    }
  }
  return archive;
}

async function parseArchive(input: ImportInput, ctx: ParseContext): Promise<UniversalChat> {
  const doc = await findDocument(input.files);
  if (!doc) throw new ConversionError('No universalchat.json found', 'NO_CHAT_FILE');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readText(doc));
  } catch {
    throw new ConversionError(`${doc.path} is not valid JSON`, 'BAD_FILE');
  }
  try {
    return relink(readUniversalChat(parsed), ctx);
  } catch (e) {
    throw new ConversionError(e instanceof Error ? e.message : String(e), 'BAD_FILE');
  }
}

async function parse(input: ImportInput, ctx: ParseContext): Promise<Conversation> {
  const archive = await parseArchive(input, ctx);
  const first = archive.conversations[0];
  if (!first) throw new ConversionError('The UniversalChat document holds no conversation', 'EMPTY_EXPORT');
  return first;
}

async function detect(input: ImportInput): Promise<DetectResult> {
  const doc = await findDocument(input.files);
  return doc
    ? { platform: 'universalchat', confidence: 0.99, reason: `UniversalChat: ${doc.path}` }
    : { platform: 'universalchat', confidence: 0 };
}

export const universalchatImporter: Importer = {
  platform: 'universalchat',
  capabilities: caps,
  detect,
  parse,
  parseArchive,
};
