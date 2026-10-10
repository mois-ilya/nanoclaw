/**
 * nanoclaw-fork: product commands for the agent (`ncl me set-timezone`, `ncl guest append`).
 *
 * Both act on the CALLER'S agent group only (taken from the transport context) and need no approval:
 * a friend setting their own timezone must not send an approval card to the owner.
 */
import { normalizeArgs } from '../args.js';
import { register } from '../registry.js';
import type { CallerContext } from '../frame.js';

function agentGroup(ctx: CallerContext): string {
  if (ctx.caller !== 'agent') throw new Error('this command is for agents only');
  return ctx.agentGroupId;
}

register({
  name: 'me-set-timezone',
  description: "Set the user's timezone (IANA id, e.g. Europe/Moscow) for reminders and the agent clock.",
  access: 'open',
  resource: 'me',
  parseArgs: (raw) => {
    const a = normalizeArgs(raw);
    const timezone = typeof a.timezone === 'string' ? a.timezone.trim() : typeof a.tz === 'string' ? a.tz.trim() : '';
    if (!timezone) throw new Error('--timezone is required (IANA id, e.g. Europe/Moscow)');
    return { timezone };
  },
  handler: async (args, ctx) =>
    (await import('../../nc/agent-actions.js')).setTimezoneForGroup(agentGroup(ctx), args.timezone),
});

register({
  name: 'guest-append',
  description: 'Owner only: append facts (one per line) to the guest-context draft. Does not publish.',
  access: 'open',
  resource: 'guest',
  parseArgs: (raw) => {
    const a = normalizeArgs(raw);
    const text = typeof a.text === 'string' ? a.text : '';
    if (!text.trim()) throw new Error('--text is required');
    return { text };
  },
  handler: async (args, ctx) =>
    (await import('../../nc/agent-actions.js')).appendGuestDraft(agentGroup(ctx), args.text),
});
