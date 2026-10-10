import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AnchoredDir } from '../../anchored-dir.js';
import { listBounded, parseRelPath, readBounded, readBoundedPath, UnsafePathError } from './readbounded.js';

let dir: string;
let root: AnchoredDir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-rb-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a.md'), 'hello');
  fs.writeFileSync(path.join(dir, 'sub', 'b.md'), 'nested');
  root = AnchoredDir.open(dir, [])!;
});
afterEach(() => {
  root.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readBounded', () => {
  it('reads small files fully', () => {
    const r = readBounded(root, 'a.md', 100);
    expect(r.data.toString()).toBe('hello');
    expect(r.truncated).toBe(false);
  });

  it('truncates oversize files to the bound without reading the rest', () => {
    fs.writeFileSync(path.join(dir, 'big.md'), 'x'.repeat(10_000));
    const r = readBounded(root, 'big.md', 100);
    expect(r.data.length).toBe(100);
    expect(r.truncated).toBe(true);
    expect(r.size).toBe(10_000);
  });

  it('refuses a symlinked leaf (even to a readable file)', () => {
    fs.writeFileSync(path.join(os.tmpdir(), 'nc-rb-secret'), 'SECRET');
    fs.symlinkSync(path.join(os.tmpdir(), 'nc-rb-secret'), path.join(dir, 'link.md'));
    expect(() => readBounded(root, 'link.md', 100)).toThrow();
    fs.rmSync(path.join(os.tmpdir(), 'nc-rb-secret'));
  });

  it('refuses a FIFO without blocking', () => {
    execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    expect(() => readBounded(root, 'pipe', 100)).toThrow(/regular file/);
  });

  it('refuses a directory', () => {
    expect(() => readBounded(root, 'sub', 100)).toThrow();
  });
});

describe('readBoundedPath', () => {
  it('reads nested files', () => {
    expect(readBoundedPath(root, 'sub/b.md', 100).data.toString()).toBe('nested');
  });

  it('refuses a symlinked directory in the middle of the path', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-rb-out-'));
    fs.writeFileSync(path.join(outside, 'x.md'), 'OUTSIDE');
    fs.symlinkSync(outside, path.join(dir, 'evil'));
    expect(() => readBoundedPath(root, 'evil/x.md', 100)).toThrow();
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('rejects traversal, absolute, dot and odd paths', () => {
    for (const bad of [
      '../a.md',
      'sub/../a.md',
      '/etc/passwd',
      '.hidden',
      'sub/.x',
      'a\\b',
      '',
      'a/./b',
      'a//b',
      'x\0y',
    ]) {
      expect(() => parseRelPath(bad), bad).toThrow(UnsafePathError);
    }
    expect(() => parseRelPath('a/b/c/d/e/f/g')).toThrow(/depth/);
    expect(() => parseRelPath(undefined)).toThrow(UnsafePathError);
  });
});

describe('listBounded', () => {
  it('skips symlinks, dotfiles and special files; does not descend symlinked dirs', () => {
    execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    fs.writeFileSync(path.join(dir, '.secret'), 's');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-rb-out-'));
    fs.writeFileSync(path.join(outside, 'x.md'), 'OUTSIDE');
    fs.symlinkSync(outside, path.join(dir, 'evil'));
    fs.symlinkSync(path.join(dir, 'a.md'), path.join(dir, 'alias.md'));
    const { entries } = listBounded(root, { maxEntries: 100, maxDepth: 5 });
    expect(entries.map((e) => e.path).sort()).toEqual(['a.md', 'sub', 'sub/b.md']);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('caps entries and depth', () => {
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, `f${i}.md`), 'x');
    const r = listBounded(root, { maxEntries: 5, maxDepth: 5 });
    expect(r.entries.length).toBe(5);
    expect(r.truncated).toBe(true);
    const shallow = listBounded(root, { maxEntries: 100, maxDepth: 1 });
    expect(shallow.entries.some((e) => e.path === 'sub/b.md')).toBe(false);
  });
});
