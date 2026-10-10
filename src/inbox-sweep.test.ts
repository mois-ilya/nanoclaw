import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sweepInboxes } from './inbox-sweep.js';

const DAY = 24 * 60 * 60 * 1000;
let root: string;

function put(group: string, session: string, msg: string, file: string, bytes: number, ageMs: number): string {
  const dir = path.join(root, group, session, 'inbox', msg);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, file);
  fs.writeFileSync(f, Buffer.alloc(bytes));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(f, t, t);
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-sweep-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('sweepInboxes', () => {
  it('removes message dirs past retention and keeps recent ones', () => {
    const old = put('g', 's', 'm-old', 'a.jpg', 10, 40 * DAY);
    const fresh = put('g', 's', 'm-new', 'b.jpg', 10, 1 * DAY);
    const res = sweepInboxes(Date.now(), {}, root);
    expect(res.removedDirs).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('enforces the per-group quota, oldest first, across sessions', () => {
    const a = put('g', 's1', 'm1', 'a', 600 * 1024, 3 * DAY);
    const b = put('g', 's2', 'm2', 'b', 600 * 1024, 2 * DAY);
    const c = put('g', 's2', 'm3', 'c', 600 * 1024, 1 * DAY);
    const other = put('h', 's9', 'm4', 'd', 600 * 1024, 5 * DAY);
    sweepInboxes(Date.now(), { NC_INBOX_QUOTA_MB: '1' }, root);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
    expect(fs.existsSync(c)).toBe(true);
    expect(fs.existsSync(other)).toBe(true); // other tenant is under its own quota
  });

  it('does not follow a symlinked inbox out of the session', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-outside-'));
    fs.mkdirSync(path.join(outside, 'm'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'm', 'secret'), 'x');
    fs.mkdirSync(path.join(root, 'g', 's'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'g', 's', 'inbox'));
    sweepInboxes(Date.now() + 100 * DAY, {}, root);
    expect(fs.existsSync(path.join(outside, 'm', 'secret'))).toBe(true);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
