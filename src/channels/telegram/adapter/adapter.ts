/** The ChannelAdapter implementation tying runtime, ingress, poller and deliverer together. */
import { BotApi, TelegramError } from '../botapi/index.js';
import { log } from '../../../log.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup } from '../../adapter.js';
import { COPY } from './copy.js';
import { Deliverer } from './deliver.js';
import { chatIdFromPlatformId } from './format.js';
import { Ingress } from './ingress.js';
import { Poller } from './poller.js';
import { createRuntime, setReplayHandler, setRuntime, type TelegramRuntime } from './runtime.js';
import { DbStore, type TgStore } from './store.js';

export const TELEGRAM_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'dm-only',
};

export interface TelegramAdapterOptions {
  token: string;
  baseUrl?: string;
  ownerId?: number;
  miniAppShortName?: string;
  store?: TgStore;
  api?: BotApi;
  /** Backoff between getMe attempts at boot; default 1 s .. 30 s, ~3 min in total. */
  bootRetryMs?: number[];
  /** Called when Telegram stays unreachable at boot (default: process.exit(1), so systemd restarts us). */
  exit?: (code: number) => void;
}

const BOOT_RETRY_MS = [1000, 2000, 4000, 8000, 15_000, 30_000, 30_000, 30_000, 30_000, 30_000];
const TRANSIENT = new Set(['network', 'timeout', 'server', 'rate_limit']);

async function getMeWithRetry(
  api: BotApi,
  delays: number[],
  exit: (code: number) => void,
): Promise<Awaited<ReturnType<BotApi['getMe']>>> {
  for (let i = 0; ; i++) {
    try {
      return await api.getMe();
    } catch (err) {
      if (!(err instanceof TelegramError) || !TRANSIENT.has(err.kind)) throw err;
      if (i >= delays.length) {
        // A channel-less host looks healthy to systemd: die loudly instead.
        log.error('Telegram unreachable at boot; exiting so the service restarts', { err });
        exit(1);
        throw err;
      }
      const wait = Math.max(delays[i], (err.retryAfter ?? 0) * 1000);
      log.warn('Telegram getMe failed; retrying', { attempt: i + 1, kind: err.kind, waitMs: wait });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Status cards left by the previous process stay «Работаю» forever: say what happened (best effort). */
async function markInterruptedCards(api: BotApi, store: TgStore): Promise<void> {
  const cards = await store.listOpenStatusCards().catch(() => []);
  await Promise.all(
    cards.map((d) =>
      api
        .editMessageText({
          chat_id: d.chat_id,
          message_id: d.status_message_id!,
          rich_message: { blocks: [{ type: 'paragraph', text: COPY.restarted }] },
        })
        .catch((err: unknown) => log.debug('interrupted status card edit failed', { chatId: d.chat_id, err })),
    ),
  );
}

export function createTelegramAdapter(o: TelegramAdapterOptions): ChannelAdapter {
  let rt: TelegramRuntime | undefined;
  let poller: Poller | undefined;
  let ingress: Ingress | undefined;
  let deliverer: Deliverer | undefined;

  return {
    name: 'telegram',
    channelType: 'telegram',
    supportsThreads: false,
    defaults: TELEGRAM_DEFAULTS,

    async setup(host: ChannelSetup) {
      const api = o.api ?? new BotApi({ token: o.token, baseUrl: o.baseUrl });
      const me = await getMeWithRetry(api, o.bootRetryMs ?? BOOT_RETRY_MS, o.exit ?? ((code) => process.exit(code)));
      const store = o.store ?? new DbStore();
      await markInterruptedCards(api, store);
      await store.closeAllOpenDrafts(Date.now());
      rt = createRuntime({
        api,
        store,
        ownerId: o.ownerId,
        botUsername: me.username,
        miniAppShortName: o.miniAppShortName,
      });
      setRuntime(rt);
      deliverer = new Deliverer(rt);
      ingress = new Ingress(rt, host);
      const ing = ingress;
      setReplayHandler((u) => ing.replay(u));
      poller = new Poller(rt, ingress);
      poller.start();
      log.info('Telegram adapter started', { bot: me.username });
    },

    async teardown() {
      await poller?.stop();
      ingress?.shutdown();
      rt?.turns.shutdown();
      rt?.sched.stop();
      setRuntime(undefined);
      setReplayHandler(undefined);
    },

    isConnected: () => poller?.isHealthy() ?? false,

    async deliver(platformId, threadId, message) {
      if (!deliverer) throw new Error('telegram adapter not started');
      return deliverer.deliver(platformId, threadId, message);
    },

    async setTyping(platformId) {
      const chatId = chatIdFromPlatformId(platformId);
      if (chatId !== null) rt?.turns.sendTyping(chatId);
    },

    async openDM(userHandle: string) {
      return `telegram:${userHandle.replace(/^telegram:/, '')}`;
    },
  };
}
