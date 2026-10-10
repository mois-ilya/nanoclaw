// nanoclaw-fork: a tiny host-wide error bus. Core code reports failures that are otherwise only logged
// (container start, gateway outage); the product module counts them for /health and alerts the owner.
export type HostErrorClass = 'container' | 'gateway' | 'turn' | 'render' | 'update' | 'other';

export interface HostError {
  cls: HostErrorClass;
  /** Session / chat / component the error belongs to. No message content. */
  target: string;
  detail?: string;
}

type Sink = (e: HostError) => void;
const sinks: Sink[] = [];

export function onHostError(sink: Sink): void {
  sinks.push(sink);
}

export function emitHostError(cls: HostErrorClass, target: string, detail?: string): void {
  for (const s of sinks) {
    try {
      s({ cls, target, detail });
    } catch {
      /* a broken sink must never break the reporter */
    }
  }
}

/** One finished turn, metadata only (R18 / ux §7.1). Timestamps are epoch ms; absent when the stage never happened. */
export interface HostTurn {
  chatId: number;
  outcome: 'final' | 'failed' | 'cancelled';
  tInbound: number;
  tReact?: number;
  tFirstPreview?: number;
  tFinal?: number;
  voice?: boolean;
  /** The container had to be started for this turn. */
  coldStart?: boolean;
  /** The user pressed Stop / retried. */
  stopped?: boolean;
}

type TurnSink = (t: HostTurn) => void;
const turnSinks: TurnSink[] = [];

export function onHostTurn(sink: TurnSink): void {
  turnSinks.push(sink);
}

/** Called by the channel adapter when a turn ends. */
export function emitHostTurn(t: HostTurn): void {
  for (const s of turnSinks) {
    try {
      s(t);
    } catch {
      /* ignore */
    }
  }
}
