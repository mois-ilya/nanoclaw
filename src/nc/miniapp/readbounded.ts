/**
 * Bounded reads and listings inside container-writable trees (the agent's
 * group folder), through AnchoredDir so a symlink the container plants can
 * never redirect the host (CWE-59), and a huge or special file can never
 * exhaust host memory or block it (FIFO).
 */
import fs from 'node:fs';

import { AnchoredDir } from '../../anchored-dir.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';

export class UnsafePathError extends Error {}

export interface BoundedRead {
  data: Buffer;
  /** Real size of the file at fstat time. */
  size: number;
  truncated: boolean;
  mtimeMs: number;
}

/**
 * Read at most `maxBytes` of the regular file `name` directly inside `dir`.
 * `openReadFd` refuses symlinks (O_NOFOLLOW) and non-regular files (checked on
 * the descriptor) and opens non-blocking, so a planted FIFO cannot stall us.
 */
export function readBounded(dir: AnchoredDir, name: string, maxBytes: number): BoundedRead {
  const fd = dir.openReadFd(name);
  try {
    const st = fs.fstatSync(fd);
    const want = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(want);
    let off = 0;
    while (off < want) {
      const n = fs.readSync(fd, buf, off, want - off, off);
      if (n === 0) break; // shrank under us
      off += n;
    }
    return { data: buf.subarray(0, off), size: st.size, truncated: st.size > maxBytes, mtimeMs: st.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

/** Validate a user-supplied relative path: no absolute, no `..`, no dotfiles, bounded depth. */
export function parseRelPath(rel: unknown, maxDepth = 6): string[] {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 400) throw new UnsafePathError('path');
  if (rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) throw new UnsafePathError('path');
  const parts = rel.split('/');
  if (parts.length > maxDepth) throw new UnsafePathError('depth');
  for (const p of parts) {
    if (!isSafeAttachmentName(p) || p.startsWith('.')) throw new UnsafePathError('segment');
  }
  return parts;
}

/** Read `rel` below `root`, opening every directory through its parent without following symlinks. */
export function readBoundedPath(root: AnchoredDir, rel: string, maxBytes: number): BoundedRead {
  const parts = parseRelPath(rel);
  let cur: AnchoredDir = root;
  const opened: AnchoredDir[] = [];
  try {
    for (const seg of parts.slice(0, -1)) {
      const next = cur.openDir(seg);
      if (!next) throw new UnsafePathError('missing');
      opened.push(next);
      cur = next;
    }
    return readBounded(cur, parts[parts.length - 1], maxBytes);
  } finally {
    for (const d of opened) d.close();
  }
}

export interface ListedEntry {
  path: string;
  size: number;
  mtimeMs: number;
  kind: 'file' | 'dir';
}

/**
 * Bounded recursive listing. Symlinks, special files, unsafe and dot names are
 * skipped; directories are entered only via `openDir` (no symlink follow).
 */
export function listBounded(
  root: AnchoredDir,
  opts: { maxEntries: number; maxDepth: number },
): { entries: ListedEntry[]; truncated: boolean } {
  const entries: ListedEntry[] = [];
  let truncated = false;

  const walk = (dir: AnchoredDir, prefix: string, depth: number): void => {
    let names: string[];
    try {
      names = dir.entries().sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (entries.length >= opts.maxEntries) {
        truncated = true;
        return;
      }
      if (!isSafeAttachmentName(name) || name.startsWith('.')) continue;
      let st: fs.Stats;
      try {
        st = dir.lstat(name);
      } catch {
        continue;
      }
      const path = prefix ? `${prefix}/${name}` : name;
      if (st.isSymbolicLink()) continue;
      if (st.isFile()) {
        entries.push({ path, size: st.size, mtimeMs: st.mtimeMs, kind: 'file' });
      } else if (st.isDirectory()) {
        entries.push({ path, size: 0, mtimeMs: st.mtimeMs, kind: 'dir' });
        if (depth + 1 < opts.maxDepth) {
          let sub: AnchoredDir | null = null;
          try {
            sub = dir.openDir(name);
          } catch {
            sub = null; // swapped for a symlink between lstat and open: skip
          }
          if (sub) {
            try {
              walk(sub, path, depth + 1);
            } finally {
              sub.close();
            }
          }
        }
      }
    }
  };
  walk(root, '', 0);
  return { entries, truncated };
}
