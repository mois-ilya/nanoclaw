/**
 * Host-side actions the agent can call through `ncl` (see src/cli/resources/nc.ts). Each one is scoped to the
 * CALLER'S own agent group: the group id comes from the transport, never from arguments.
 */
import { ownerTgId } from './config.js';
import { tg } from './port.js';
import { GUEST_MAX_CHARS, getDraft, putDraft } from './guest-store.js';
import { applyTimezone, validTz } from './settings.js';
import { audit, getTenantByGroup } from './store.js';

/** 1 факт, 2-4 факта, 5+ фактов. */
function plural(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'факт';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'факта';
  return 'фактов';
}

export async function setTimezoneForGroup(agentGroupId: string, tz: string): Promise<{ timezone: string }> {
  if (!validTz(tz)) throw new Error(`unknown timezone: ${tz} (use an IANA id like Europe/Moscow)`);
  const t = await getTenantByGroup(agentGroupId);
  if (!t || (t.state !== 'ready' && t.state !== 'paused')) throw new Error('no tenant for this agent group');
  await applyTimezone(t, tz);
  await audit(t.user_id, 'set_timezone', t.user_id, { tz });
  return { timezone: tz };
}

/** Append facts to the owner's guest-context DRAFT (never publishes). */
export async function appendGuestDraft(
  agentGroupId: string,
  text: string,
): Promise<{ added: number; draftChars: number }> {
  const t = await getTenantByGroup(agentGroupId);
  const owner = ownerTgId();
  if (!t || owner === null || t.tg_id !== owner) throw new Error('only the owner agent can edit the guest context');
  const facts = text
    .split('\n')
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);
  if (facts.length === 0) throw new Error('--text is empty');
  const cur = (await getDraft()).trimEnd();
  const next = `${cur}${cur ? '\n' : ''}${facts.map((f) => `- ${f}`).join('\n')}\n`;
  if (next.length > GUEST_MAX_CHARS) throw new Error('guest draft would exceed the size limit');
  await putDraft(next);
  await audit(t.user_id, 'guest_draft_append', t.user_id, { facts: facts.length });
  await tg
    .sendProduct(owner, `Добавил в гостевой черновик (${facts.length} ${plural(facts.length)}). Опубликуй в «Гость».`, {
      silent: true,
      buttons: [[{ text: 'Открыть «Гость»', webApp: 'guest' }]],
    })
    .catch(() => undefined);
  return { added: facts.length, draftChars: next.length };
}
