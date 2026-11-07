import { createWriteStream, openAsBlob } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { Writable } from 'node:stream';
import { fileFromBlob } from '../sources/blob';
import { makeSource, type Source, type SourceFile } from '../sources/source';
import { sourceFromZip } from '../sources/zip';

async function walk(dir: string, root: string, out: SourceFile[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, out);
    } else if (entry.isFile()) {
      // openAsBlob returns a disk-backed Blob: nothing is read until a byte is needed.
      const blob = await openAsBlob(full);
      out.push(fileFromBlob(relative(root, full).split(sep).join('/'), blob));
    }
  }
}

/** Opens a folder, a `.zip` or a single file from disk as a lazy `Source`. */
export async function sourceFromPath(path: string): Promise<Source> {
  const info = await stat(path);
  const name = basename(path);
  if (info.isDirectory()) {
    const files: SourceFile[] = [];
    await walk(path, path, files);
    // Keep the folder name as the source name; makeSource only strips folders shared by every file.
    return makeSource(name, files);
  }
  const blob = await openAsBlob(path);
  if (/\.zip$/i.test(name)) return sourceFromZip(name, blob);
  return makeSource(name.replace(/\.[^.]+$/, ''), [fileFromBlob(name, blob)]);
}

/** A web `WritableStream` writing to a file on disk. */
export function fileWritable(path: string): WritableStream<Uint8Array> {
  return Writable.toWeb(createWriteStream(path)) as WritableStream<Uint8Array>;
}
