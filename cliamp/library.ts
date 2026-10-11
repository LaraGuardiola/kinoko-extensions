// The music library: songs by name and folders, found on disk under ~/Music.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const AUDIO = /\.(mp3|flac|ogg|opus|m4a|aac|wav|webm|wma|aiff?|mka)$/i;

/** Songs under the library whose path holds every word of the query. */
export async function findSongs(library: string, query: string, limit = 10): Promise<string[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const files = (await readdir(library, { recursive: true }).catch(() => [] as string[])).filter((f) => AUDIO.test(f)).slice(0, 20_000);
  return files.filter((f) => words.every((w) => f.toLowerCase().includes(w))).toSorted((a, b) => a.length - b.length).slice(0, limit).map((f) => join(library, f));
}

/** Every song in a folder, in order: what playing a folder queues. */
export async function songsIn(dir: string, limit = 200): Promise<string[]> {
  const files = (await readdir(dir, { recursive: true }).catch(() => [] as string[])).filter((f) => AUDIO.test(f));
  return files.toSorted((a, b) => a.localeCompare(b)).slice(0, limit).map((f) => join(dir, f));
}

const isDir = async (p: string): Promise<boolean> => (await stat(p).catch(() => undefined))?.isDirectory() ?? false;

/** The folder a query names: an absolute path to one, or a folder of the library by its whole name. */
export async function folderOf(library: string, query: string): Promise<string | undefined> {
  const path = query.replace(/^~(?=\/)/, homedir());
  if (path.startsWith("/")) return (await isDir(path)) ? path : undefined;
  const name = (await readdir(library).catch(() => [] as string[])).find((d) => d.toLowerCase() === query.toLowerCase());
  return name !== undefined && (await isDir(join(library, name))) ? join(library, name) : undefined;
}
