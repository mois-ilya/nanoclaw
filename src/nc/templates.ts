/** Loads the persona / guest templates and fills `{{placeholders}}`. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nc } from './config.js';

/** Files the host cannot answer without (guest summons, friend provisioning); the startup preflight checks them. */
export const REQUIRED_TEMPLATES = ['guest.md', 'friend-persona.md'] as const;

/** Where the templates may live: NC_TEMPLATES_DIR, next to this module, the working-directory source tree. */
export function templateDirCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [nc.templatesDir(), path.join(here, 'templates'), path.join(process.cwd(), 'src', 'nc', 'templates')].filter(
    Boolean,
  );
}

function templatesDir(): string {
  const candidates = templateDirCandidates();
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`nc: templates directory not found (tried ${candidates.join(', ')}); set NC_TEMPLATES_DIR`);
}

export function renderTemplate(raw: string, vars: Record<string, string>): string {
  return raw.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');
}

function load(file: string): string {
  return fs.readFileSync(path.join(templatesDir(), file), 'utf8');
}

/** User-controlled names are reduced to a single safe line before they reach a prompt. */
function safeName(raw: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  return (
    raw
      .replace(/[\u0000-\u001f\u007f{}<>`]+/g, ' ')
      .trim()
      .slice(0, 60) || fallback
  );
}

/**
 * Personal layer L1 for a friend (`instructions.prepend.md`, the only part the user and the agent may change).
 * The platform rules live in `platformLayer` and are composed on every spawn.
 */
export function friendPersona(vars: { name: string; tz: string }): string {
  return renderTemplate(load('friend-persona.md'), {
    name: safeName(vars.name, 'пользователя'),
    owner: nc.ownerName(),
    tz: vars.tz,
  });
}

/** Personal layer L1 for the owner. */
export function ownerPersona(vars: { tz: string }): string {
  return renderTemplate(load('owner-persona.md'), { owner: nc.ownerName(), tz: vars.tz });
}

/**
 * Locked platform layer L0, host-owned: shared style/voice/tasks rules plus the role-specific block.
 * `botName` is dropped from the text when it is the generic default.
 */
export function platformLayer(kind: 'owner' | 'friend', vars: { name: string; lang?: 'ru' | 'en' }): string {
  const bot = nc.botName();
  const rendered = (file: string): string =>
    renderTemplate(load(file), {
      name: safeName(vars.name, 'пользователь'),
      bot_name: bot,
      owner: nc.ownerName(),
      owner_gen: nc.ownerNameGen(),
    });
  let role = rendered(kind === 'owner' ? 'platform-owner.md' : 'platform-friend.md');
  // «Тебя зовут ассистент» reads oddly: only mention a real name.
  if (bot === 'ассистент') role = role.replace(/ Тебя зовут ассистент\./, '');
  const lang =
    vars.lang === 'en'
      ? '\n\n## Язык ответов\nПользователь выбрал английский в настройках: отвечай по-английски, пока он не попросит иначе.'
      : '';
  return `${role}\n\n${rendered('platform-base.md')}${lang}`;
}

/** System prompt for guest answers (template only; the published GUEST.md is appended by the caller). */
export function guestSystemTemplate(): string {
  return renderTemplate(load('guest.md'), { owner: nc.ownerName(), owner_gen: nc.ownerNameGen() });
}
