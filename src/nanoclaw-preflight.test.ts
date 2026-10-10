import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { enforceNanoclawAssets, missingNanoclawAssets } from './nanoclaw-preflight.js';

let root: string;

function populate(): void {
  fs.mkdirSync(path.join(root, 'container', 'agent-runner', 'src', 'mcp-tools'), { recursive: true });
  fs.mkdirSync(path.join(root, 'container', 'skills', 'welcome'), { recursive: true });
  fs.mkdirSync(path.join(root, 'templates'));
  fs.writeFileSync(path.join(root, 'container', 'CLAUDE.md'), '# base');
  fs.mkdirSync(path.join(root, 'src', 'nc', 'templates'), { recursive: true });
  for (const f of ['guest.md', 'friend-persona.md']) fs.writeFileSync(path.join(root, 'src', 'nc', 'templates', f), '#');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-preflight-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('nanoclaw asset preflight', () => {
  it('passes on a complete tree', () => {
    populate();
    expect(missingNanoclawAssets(root)).toEqual([]);
  });

  it('names every missing asset, including an empty skills dir', () => {
    populate();
    fs.rmSync(path.join(root, 'templates'), { recursive: true });
    fs.rmSync(path.join(root, 'container', 'skills', 'welcome'), { recursive: true });
    expect(missingNanoclawAssets(root)).toEqual([path.join('container', 'skills'), 'templates']);
  });

  it('names a missing nc template (guest.md) by path', () => {
    populate();
    fs.rmSync(path.join(root, 'src', 'nc', 'templates', 'guest.md'));
    expect(missingNanoclawAssets(root)).toEqual([path.join('nc-templates', 'guest.md')]);
  });

  it('accepts the packaged copy via NC_TEMPLATES_DIR', () => {
    populate();
    const alt = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-tpl-'));
    for (const f of ['guest.md', 'friend-persona.md']) fs.writeFileSync(path.join(alt, f), '#');
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    process.env.NC_TEMPLATES_DIR = alt;
    try {
      expect(missingNanoclawAssets(root)).toEqual([]);
    } finally {
      delete process.env.NC_TEMPLATES_DIR;
      fs.rmSync(alt, { recursive: true, force: true });
    }
  });

  it('exits only in strict mode', () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(enforceNanoclawAssets({ root, env: {}, exit })).not.toHaveLength(0);
    expect(exit).not.toHaveBeenCalled();
    enforceNanoclawAssets({ root, env: { NANOCLAW_STRICT_ASSETS: '1' }, exit });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('stays silent when nothing is missing, even in strict mode', () => {
    populate();
    const exit = vi.fn() as unknown as (code: number) => never;
    enforceNanoclawAssets({ root, env: { NANOCLAW_STRICT_ASSETS: '1' }, exit });
    expect(exit).not.toHaveBeenCalled();
  });
});
