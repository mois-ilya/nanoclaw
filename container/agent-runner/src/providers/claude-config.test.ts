import { describe, expect, it } from 'bun:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SDK_DISALLOWED_TOOLS,
  TOOL_ALLOWLIST,
  listInstalledSkills,
  resolveClaudeBuiltinTools,
  resolveClaudeInference,
} from './claude-config.js';

describe('resolveClaudeInference', () => {
  it('passes model and effort through verbatim with no settings by default', () => {
    const resolved = resolveClaudeInference({ model: 'opus', effort: 'high' }, {});
    expect(resolved).toEqual({ model: 'opus', effort: 'high' });
    expect(resolved.settings).toBeUndefined();
  });

  it("maps speed 'fast' to the SDK fastMode setting", () => {
    expect(resolveClaudeInference({ speed: 'fast' }, {}).settings).toEqual({ fastMode: true });
  });

  it("maps speed 'standard' to the SDK default", () => {
    expect(resolveClaudeInference({ speed: 'standard' }, {}).settings).toBeUndefined();
  });

  it('ignores unknown speed values instead of guessing', () => {
    expect(resolveClaudeInference({ speed: 'ultrafast' }, {}).settings).toBeUndefined();
  });
});

describe('resolveClaudeBuiltinTools', () => {
  it('is TOOL_ALLOWLIST as a fresh array, keeps ToolSearch/Skill/Task and none of the disallowed tools', () => {
    const tools = resolveClaudeBuiltinTools();
    expect(tools).toEqual(TOOL_ALLOWLIST);
    expect(tools).not.toBe(TOOL_ALLOWLIST);
    for (const t of ['ToolSearch', 'Skill', 'Task', 'Bash', 'Glob', 'Grep']) expect(tools).toContain(t);
    for (const t of SDK_DISALLOWED_TOOLS) expect(tools).not.toContain(t);
  });
});

describe('listInstalledSkills', () => {
  it('lists skill directories and symlinks to directories, skipping files, dotdirs and broken links', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-src-'));
    const dir = path.join(root, 'skills');
    fs.mkdirSync(path.join(dir, 'authored'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.hidden'));
    fs.writeFileSync(path.join(dir, 'README.md'), 'x');
    fs.symlinkSync(target, path.join(dir, 'linked'));
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(dir, 'broken'));
    expect(listInstalledSkills(root)).toEqual(['authored', 'linked']);
  });

  it('returns [] when the skills directory is missing', () => {
    expect(listInstalledSkills(path.join(os.tmpdir(), 'no-such-config-dir'))).toEqual([]);
  });
});
