/**
 * Connects the product module to W1's adapter (`channels/telegram/adapter`,
 * integration contract C1). The `satisfies`-style assertion below makes `tsc`
 * fail if W1's exports drift from the interfaces in `port.ts`.
 */
import type { Update } from '../channels/telegram/botapi/index.js';
import * as adapter from '../channels/telegram/adapter/index.js';
import { nc } from './config.js';
import { consumeBudgetNote } from './budget.js';
import { commandHandler } from './commands.js';
import { productCallback } from './callbacks.js';
import { privateGate } from './gate.js';
import { guestHandler } from './guest.js';
import { getUserPrefs } from './prefs.js';
import { setAdapterSend, type AdapterHooks, type AdapterSend } from './port.js';
import { stopHandler } from './stop.js';
import { mintTaskToken } from './tasktokens.js';
import { transcribe } from './stt.js';

const _contract: AdapterHooks & AdapterSend = adapter;
void _contract;

export function registerHooks(h: AdapterHooks): void {
  h.setPrivateGate(privateGate);
  h.setCommandHandler(commandHandler);
  h.setProductCallbackHandler(productCallback);
  // Always registered: the backend (Groq key, possibly saved later, or local whisper) is picked per call, and
  // transcribe() answers `failed` when there is none.
  h.setTranscriber((audio, meta) => transcribe(audio, meta));
  h.setGuestHandler((msg) => guestHandler(msg));
  h.setStopHandler(stopHandler);
}

export function bindAdapter(): void {
  registerHooks(adapter);
  adapter.setTaskTokenProvider((chatId, seriesId) => mintTaskToken(chatId, seriesId));
  adapter.setUserPrefsProvider((chatId) => getUserPrefs(chatId));
  adapter.setBudgetNoteProvider((chatId) => {
    const text = consumeBudgetNote(chatId);
    return text ? { text, button: { text: 'Подробнее', webApp: 'usage' } } : null;
  });
  setAdapterSend({
    sendProduct: (c, md, o) => adapter.sendProduct(c, md, o),
    editProduct: (c, m, md, o) => adapter.editProduct(c, m, md, o),
    react: (c, m, e) => adapter.react(c, m, e),
    api: () => adapter.api(),
    hasActiveTurn: (chatId: number, threadId?: number) => adapter.getRuntime()?.turns.hasActiveTurn(chatId, threadId),
    hasActiveTurnInChat: (chatId: number) => adapter.getRuntime()?.turns.hasActiveTurnInChat(chatId),
    replay: (u: Update) => adapter.replayPrivateUpdate(u),
    retryPrompt: (c, t) => adapter.retryPrompt(c, t),
    buttonValue: (c, id, k) => adapter.buttonValue(c, id, k),
    clearButtons: (c, m) => adapter.clearButtons(c, m),
  });
}
