// nanoclaw-fork: container lifecycle limits driven by env, resolved per session kind.
//
//   NC_MAX_CONTAINERS        global cap on concurrently running agent containers (unset/0 = no cap)
//   NC_IDLE_OWNER_MINUTES    stop an idle owner container after this long (default 30)
//   NC_IDLE_FRIEND_MINUTES   stop an idle friend container after this long (default 10)
//
// Core does not know who the owner is: the product module registers a resolver (agent group -> kind).
// Without one, no idle reaping happens and every session ranks the same (upstream behaviour).
export type SessionKind = 'owner' | 'friend';

let kindResolver: ((agentGroupId: string) => SessionKind) | null = null;

export function registerSessionKindResolver(next: ((agentGroupId: string) => SessionKind) | null): void {
  kindResolver = next;
}

export function sessionKind(agentGroupId: string): SessionKind | null {
  return kindResolver ? kindResolver(agentGroupId) : null;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 0 = unlimited. */
export function maxContainers(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.NC_MAX_CONTAINERS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function idleMinutes(kind: SessionKind, env: NodeJS.ProcessEnv = process.env): number {
  return kind === 'owner' ? positiveInt(env.NC_IDLE_OWNER_MINUTES, 30) : positiveInt(env.NC_IDLE_FRIEND_MINUTES, 10);
}

/** Idle-stop threshold for a session's agent group, or null when no kind resolver is registered. */
export function idleMsFor(agentGroupId: string, env: NodeJS.ProcessEnv = process.env): number | null {
  const kind = sessionKind(agentGroupId);
  return kind ? idleMinutes(kind, env) * 60_000 : null;
}
