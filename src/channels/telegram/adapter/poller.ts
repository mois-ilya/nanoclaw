/** Long-polling loop: persist, then process; single poller; 409 backoff. */
import { TelegramError, type Update } from '../botapi/index.js';
import { log } from '../../../log.js';
import { ALLOWED_UPDATES, type Ingress } from './ingress.js';
import type { TelegramRuntime } from './runtime.js';

export interface PollerOptions {
  pollTimeoutS?: number;
  conflictBackoffMs?: number;
}

export class Poller {
  private ctrl = new AbortController();
  private loop?: Promise<void>;
  private lastOkAt = 0;
  private running = false;

  constructor(
    private readonly rt: TelegramRuntime,
    private readonly ingress: Ingress,
    private readonly opts: PollerOptions = {},
  ) {}

  isHealthy(maxAgeMs = 150_000): boolean {
    return this.running && Date.now() - this.lastOkAt < maxAgeMs;
  }

  start(): void {
    if (this.loop) return;
    this.running = true;
    this.loop = this.run().finally(() => {
      this.running = false;
    });
  }

  async stop(): Promise<void> {
    this.ctrl.abort();
    await this.loop?.catch(() => {});
    await this.ingress.drain();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const signal = this.ctrl.signal;
      function done() {
        signal.removeEventListener('abort', done);
        clearTimeout(t);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }

  private async run(): Promise<void> {
    const { store, api } = this.rt;
    // Replay what a previous process journaled but did not finish.
    try {
      await store.purgeUpdates(Date.now());
      await store.purgeCallbacks(Date.now());
      for (const row of await store.loadPending()) {
        void this.ingress.dispatch(row.update_id, JSON.parse(row.json) as Update);
      }
    } catch (err) {
      log.error('Telegram journal replay failed', { err });
    }
    const max = await store.maxUpdateId().catch(() => null);
    let offset = max !== null ? max + 1 : undefined;
    let backoff = 1000;
    const timeout = this.opts.pollTimeoutS ?? 50;

    while (!this.ctrl.signal.aborted) {
      try {
        const updates = await api.getUpdates(
          { offset, timeout, allowed_updates: [...ALLOWED_UPDATES] },
          { signal: this.ctrl.signal },
        );
        this.lastOkAt = Date.now();
        backoff = 1000;
        const fresh: Update[] = [];
        // Journal everything first: the next getUpdates call is what advances Telegram's offset.
        for (const u of updates) {
          if (await store.saveUpdate(u.update_id, JSON.stringify(u), Date.now())) fresh.push(u);
        }
        if (updates.length) offset = Math.max(...updates.map((u) => u.update_id)) + 1;
        for (const u of fresh) void this.ingress.dispatch(u.update_id, u);
      } catch (err) {
        if (this.ctrl.signal.aborted) break;
        if (err instanceof TelegramError && err.kind === 'conflict') {
          log.error('Telegram getUpdates 409: another poller/webhook is active for this bot token', {
            desc: err.description,
          });
          await this.sleep(this.opts.conflictBackoffMs ?? 30_000);
          continue;
        }
        if (err instanceof TelegramError && err.kind === 'rate_limit') {
          await this.sleep((err.retryAfter ?? 1) * 1000 + 250);
          continue;
        }
        log.warn('getUpdates failed', { err, backoffMs: backoff });
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }
}
