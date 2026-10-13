// In-memory registry of dangerous MCP tools/call requests held for the owner's decision. Not durable on purpose:
// the held call lives exactly as long as the agent's open HTTP request, so a restart of either side drops it.
import crypto from 'node:crypto';

export type ApprovalOutcome =
  | 'approve'
  | 'deny'
  | 'unavailable'
  | 'expired'
  | 'disconnected'
  | 'revoked'
  | 'disabled'
  | 'cancelled';
export type OwnerDecision = 'approve' | 'deny' | 'unavailable';

export interface ArgField {
  label: string;
  type: 'text' | 'long_text';
  value: string;
}

export interface McpPending {
  id: string;
  tenantId: string;
  sessionKey: string;
  connectorId: string;
  connectorTitle: string;
  tool: string;
  args: ArgField[];
  createdAt: string;
  expiresAt: string;
}

export interface HoldInput {
  tenantId: string;
  sessionKey: string;
  connectorId: string;
  connectorTitle: string;
  tool: string;
  args: ArgField[];
  holdMs: number;
  /** gateway MCP session id + JSON-RPC id of the held call: notifications/cancelled finds it by these */
  gwSid: string;
  rpcId: string | number;
}

interface Entry {
  p: McpPending;
  gwSid: string;
  rpcIdKey: string;
  timer: NodeJS.Timeout;
  settle(o: ApprovalOutcome): void;
}

export interface Held {
  id: string;
  outcome: Promise<ApprovalOutcome>;
  /** settle from the proxy side (client gone, token revoked, ...); no-op if already settled */
  release(o: ApprovalOutcome): void;
}

export const callId = (): string => `mc_${crypto.randomBytes(12).toString('hex')}`;

export class McpApprovals {
  /** Starts at the boot time in seconds so a restarted process never reports a version below one a poller already saw. */
  version = Math.floor(Date.now() / 1000);
  private readonly entries = new Map<string, Entry>();
  private readonly waiters = new Set<() => void>();

  private bump(): void {
    this.version++;
    for (const w of [...this.waiters]) w();
  }

  count(tenantId?: string): number {
    if (tenantId === undefined) return this.entries.size;
    let n = 0;
    for (const e of this.entries.values()) if (e.p.tenantId === tenantId) n++;
    return n;
  }

  hold(i: HoldInput, id: string = callId()): Held {
    const now = Date.now();
    let resolve!: (o: ApprovalOutcome) => void;
    const outcome = new Promise<ApprovalOutcome>((r) => (resolve = r));
    let done = false;
    const settle = (o: ApprovalOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.entries.delete(id);
      this.bump();
      resolve(o);
    };
    const timer = setTimeout(() => settle('expired'), i.holdMs);
    timer.unref();
    this.entries.set(id, {
      p: {
        id,
        tenantId: i.tenantId,
        sessionKey: i.sessionKey,
        connectorId: i.connectorId,
        connectorTitle: i.connectorTitle,
        tool: i.tool,
        args: i.args,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + i.holdMs).toISOString(),
      },
      gwSid: i.gwSid,
      rpcIdKey: JSON.stringify(i.rpcId),
      timer,
      settle,
    });
    this.bump();
    return { id, outcome, release: settle };
  }

  /** The owner's answer. false = the call is no longer waiting (finished, expired, dropped). */
  decide(id: string, d: OwnerDecision): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    e.settle(d);
    return true;
  }

  /** notifications/cancelled for a held call (same gateway session + request id). */
  cancel(gwSid: string, rpcId: unknown): boolean {
    const key = JSON.stringify(rpcId);
    for (const e of [...this.entries.values()]) {
      if (e.gwSid === gwSid && e.rpcIdKey === key) {
        e.settle('cancelled');
        return true;
      }
    }
    return false;
  }

  /** The MCP session was terminated: its held calls die with it. */
  cancelSession(gwSid: string): number {
    let n = 0;
    for (const e of [...this.entries.values()]) {
      if (e.gwSid === gwSid) {
        e.settle('cancelled');
        n++;
      }
    }
    return n;
  }

  rejectForConnector(connectorId: string, reason: 'disabled' | 'revoked'): number {
    let n = 0;
    for (const e of [...this.entries.values()]) {
      if (e.p.connectorId !== connectorId) continue;
      e.settle(reason);
      n++;
    }
    return n;
  }

  snapshot(): McpPending[] {
    return [...this.entries.values()].map((e) => e.p);
  }

  /** Long-poll: answer at once when the version differs from `since`, else after a change or `waitMs`. */
  waitPending(
    since: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<{ version: number; pending: McpPending[] }> {
    const reply = () => ({ version: this.version, pending: this.snapshot() });
    if (this.version !== since || waitMs <= 0 || signal?.aborted) return Promise.resolve(reply());
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(t);
        this.waiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve(reply());
      };
      const t = setTimeout(finish, waitMs);
      this.waiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  /** Shutdown: drop every wait so no timer outlives the server. */
  closeAll(): void {
    for (const e of [...this.entries.values()]) e.settle('unavailable');
    for (const w of [...this.waiters]) w();
  }
}

// ---- card fields ---------------------------------------------------------------------------------------------

const MAX_FIELDS = 12;
const TEXT_MAX = 200;
const LONG_MAX = 1200;
const LONG_ABOVE = 80;
const LABEL_MAX = 100;
const MASK = '•••';
/** Field names whose values never reach a card (matched anywhere in the name, at any depth). */
const SECRET_KEY_RE = /token|secret|password|key|authorization/i;

function mask(v: unknown, depth = 0): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (depth > 8) return '[…]'; // too deep to check key names: never show it as is
  if (Array.isArray(v)) return v.map((x) => mask(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>))
    out[k] = SECRET_KEY_RE.test(k) ? MASK : mask(x, depth + 1);
  return out;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… (+${s.length - max} симв.)`;
}

/** One card field per top-level argument: masked, stringified, truncated with an explicit marker. */
export function argFields(args: unknown): ArgField[] {
  if (args === undefined || args === null) return [];
  if (typeof args !== 'object' || Array.isArray(args))
    return [{ label: 'arguments', type: 'long_text', value: clip(JSON.stringify(mask(args)) ?? '', LONG_MAX) }];
  const entries = Object.entries(args as Record<string, unknown>);
  const fields: ArgField[] = [];
  for (const [k, v] of entries) {
    if (fields.length === MAX_FIELDS - (entries.length > MAX_FIELDS ? 1 : 0)) break;
    const masked = SECRET_KEY_RE.test(k) ? MASK : mask(v);
    const str = typeof masked === 'string' ? masked : (JSON.stringify(masked) ?? 'null');
    const long = str.length > LONG_ABOVE;
    fields.push({
      label: clip(k, LABEL_MAX),
      type: long ? 'long_text' : 'text',
      value: clip(str, long ? LONG_MAX : TEXT_MAX),
    });
  }
  if (entries.length > MAX_FIELDS)
    fields.push({ label: '…', type: 'text', value: `ещё ${entries.length - fields.length} полей` });
  return fields;
}
