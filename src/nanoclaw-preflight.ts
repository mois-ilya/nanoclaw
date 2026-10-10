/**
 * nanoclaw-fork: startup asset preflight (B4).
 *
 * The host resolves its agent-facing assets relative to the working directory
 * (`container/`, `templates/`, the MCP and skill fragments that
 * `project-doc-compose.ts` reads). Under a service manager a wrong
 * WorkingDirectory silently composes empty instructions; this turns that into
 * a startup failure. Strict mode (exit) is opt-in via `NANOCLAW_STRICT_ASSETS=1`,
 * set by the Nix module; otherwise a missing asset is logged at error level.
 */
import fs from 'fs';
import path from 'path';

import { log } from './log.js';
import { nc } from './nc/config.js';
import { REQUIRED_TEMPLATES, templateDirCandidates } from './nc/templates.js';

/** Paths (relative to the project root) that must exist; `nonEmptyDir` ones must also hold an entry. */
const MANIFEST: Array<{ rel: string; kind: 'file' | 'dir'; nonEmptyDir?: boolean }> = [
  { rel: path.join('container', 'CLAUDE.md'), kind: 'file' },
  { rel: path.join('container', 'agent-runner', 'src'), kind: 'dir' },
  // Read by project-doc-compose.ts (MCP_TOOLS_HOST_SUBPATH / SKILLS_HOST_SUBPATH).
  { rel: path.join('container', 'agent-runner', 'src', 'mcp-tools'), kind: 'dir' },
  { rel: path.join('container', 'skills'), kind: 'dir', nonEmptyDir: true },
  { rel: 'templates', kind: 'dir' },
];

/** Returns the manifest entries missing under `root`. */
export function missingNanoclawAssets(root: string = process.cwd()): string[] {
  const missing: string[] = [];
  for (const entry of MANIFEST) {
    const full = path.join(root, entry.rel);
    try {
      const stat = fs.statSync(full);
      if (entry.kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw new Error('wrong type');
      if (entry.nonEmptyDir && fs.readdirSync(full).length === 0) throw new Error('empty');
    } catch {
      missing.push(entry.rel);
    }
  }
  // Product templates (NC_TEMPLATES_DIR or the packaged copy): a missing one only surfaces on the first guest summons / friend.
  // Module-relative / cwd candidates only count when `root` is the real working directory.
  const candidates = [
    nc.templatesDir(),
    path.join(root, 'src', 'nc', 'templates'),
    path.join(root, 'nc-templates'),
    ...(path.resolve(root) === process.cwd() ? templateDirCandidates() : []),
  ].filter(Boolean);
  const dir = candidates.find((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
  for (const file of REQUIRED_TEMPLATES) {
    if (!dir || !fs.existsSync(path.join(dir, file))) missing.push(path.join('nc-templates', file));
  }
  return missing;
}

export function enforceNanoclawAssets(
  opts: { root?: string; env?: NodeJS.ProcessEnv; exit?: (code: number) => never } = {},
): string[] {
  const root = opts.root ?? process.cwd();
  const env = opts.env ?? process.env;
  const missing = missingNanoclawAssets(root);
  if (missing.length === 0) return missing;
  const strict = env.NANOCLAW_STRICT_ASSETS === '1';
  log.error('Required NanoClaw assets are missing from the working directory', { cwd: root, missing, strict });
  if (strict) {
    console.error(`FATAL: missing assets under ${root}: ${missing.join(', ')}`);
    (opts.exit ?? process.exit)(1);
  }
  return missing;
}
