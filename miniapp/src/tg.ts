// Thin typed wrapper over the vendored telegram-web-app.js (public/telegram-web-app.js,
// downloaded from https://telegram.org/js/telegram-web-app.js, Bot API 9.x era, webAppVersion 6.0 baseline).
// Every call is guarded: in a plain browser (dev) the script still defines window.Telegram.WebApp,
// but native UI is a no-op there, so `native` tells components to render in-page fallbacks.

interface BottomButton {
  setParams(p: { text?: string; is_visible?: boolean; is_active?: boolean; has_shine_effect?: boolean; color?: string; text_color?: string }): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
  showProgress(leave?: boolean): void;
  hideProgress(): void;
  hide(): void;
}
interface TgWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { language_code?: string; first_name?: string } };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string | undefined>;
  isVersionAtLeast(v: string): boolean;
  ready(): void;
  expand(): void;
  close(): void;
  setHeaderColor(c: string): void;
  setBackgroundColor(c: string): void;
  setBottomBarColor?(c: string): void;
  enableClosingConfirmation(): void;
  disableClosingConfirmation(): void;
  onEvent(e: string, cb: () => void): void;
  openLink(url: string, opts?: { try_instant_view?: boolean }): void;
  showPopup(p: { title?: string; message: string; buttons?: { id?: string; type?: string; text?: string }[] }, cb?: (id?: string) => void): void;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  MainButton: BottomButton;
  SecondaryButton?: BottomButton;
  HapticFeedback: {
    impactOccurred(s: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(t: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

const wa = (): TgWebApp | undefined => (typeof window === 'undefined' ? undefined : window.Telegram?.WebApp);
const at = (v: string) => {
  try { return !!wa()?.isVersionAtLeast(v); } catch { return false; }
};

/** True only inside a real Telegram client (initData is signed by Telegram). */
export const native = (): boolean => !!wa()?.initData;

export const initData = (): string => wa()?.initData ?? '';
export const startParam = (): string | undefined => wa()?.initDataUnsafe?.start_param;
export const userLang = (): string | undefined => wa()?.initDataUnsafe?.user?.language_code;

export function init(): void {
  const w = wa();
  if (!w) return;
  try { w.ready(); w.expand(); } catch { /* old client */ }
}

export function applyTheme(): void {
  const w = wa();
  if (!w) return;
  const root = document.documentElement;
  const forced = new URLSearchParams(location.search).get('theme');
  root.dataset.theme = forced === 'dark' || forced === 'light' ? forced : w.colorScheme || '';
  if (!native()) return;
  // 'secondary_bg_color' keywords are accepted from 6.1; the grouped page background is secondary_bg_color.
  if (at('6.1')) {
    try { w.setHeaderColor('secondary_bg_color'); w.setBackgroundColor('secondary_bg_color'); } catch { /* ignore */ }
  }
  if (at('7.10')) {
    try { w.setBottomBarColor?.('secondary_bg_color'); } catch { /* ignore */ }
  }
}

export function watchTheme(): void {
  wa()?.onEvent('themeChanged', applyTheme);
}

export function openLink(url: string): void {
  const w = wa();
  if (w && native()) w.openLink(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

export const haptic = {
  tap(): void { try { if (native() && at('6.1')) wa()!.HapticFeedback.impactOccurred('light'); } catch { /* ignore */ } },
  select(): void { try { if (native() && at('6.1')) wa()!.HapticFeedback.selectionChanged(); } catch { /* ignore */ } },
  success(): void { try { if (native() && at('6.1')) wa()!.HapticFeedback.notificationOccurred('success'); } catch { /* ignore */ } },
  error(): void { try { if (native() && at('6.1')) wa()!.HapticFeedback.notificationOccurred('error'); } catch { /* ignore */ } },
};

export interface ConfirmOptions {
  title?: string;
  message: string;
  okText: string;
  destructive?: boolean;
}

/** Native popup in Telegram (6.2+), `window.confirm` in a browser. */
export function confirm(o: ConfirmOptions): Promise<boolean> {
  const w = wa();
  if (w && native() && at('6.2')) {
    return new Promise((resolve) => {
      w.showPopup(
        {
          title: o.title,
          message: o.message,
          buttons: [
            { id: 'ok', type: o.destructive ? 'destructive' : 'default', text: o.okText },
            { id: 'cancel', type: 'cancel' },
          ],
        },
        (id) => resolve(id === 'ok'),
      );
    });
  }
  return Promise.resolve(window.confirm(o.title ? `${o.title}\n\n${o.message}` : o.message));
}

export function setClosingConfirmation(on: boolean): void {
  const w = wa();
  if (!w || !native() || !at('6.2')) return;
  try { on ? w.enableClosingConfirmation() : w.disableClosingConfirmation(); } catch { /* ignore */ }
}

export const supportsSecondary = (): boolean => native() && at('7.10') && !!wa()?.SecondaryButton;

/** BackButton (6.1+). Returns an unsubscribe. */
export function bindBack(visible: boolean, cb: () => void): () => void {
  const w = wa();
  if (!w || !native() || !at('6.1')) return () => {};
  try {
    if (visible) { w.BackButton.show(); w.BackButton.onClick(cb); } else w.BackButton.hide();
  } catch { /* ignore */ }
  return () => { try { w.BackButton.offClick(cb); } catch { /* ignore */ } };
}

export interface BottomParams { text: string; visible: boolean; active?: boolean; progress?: boolean; onClick: () => void; destructive?: boolean }

function bindBottom(kind: 'MainButton' | 'SecondaryButton', p: BottomParams): () => void {
  const w = wa();
  const b = w?.[kind];
  if (!w || !b || !native()) return () => {};
  try {
    const destructive = p.destructive ? { color: w.themeParams.destructive_text_color ?? '#e53935', text_color: '#ffffff' } : {};
    b.setParams({ text: p.text, is_visible: p.visible, is_active: p.active !== false && !p.progress, ...destructive });
    if (p.progress) b.showProgress(true); else b.hideProgress();
    b.onClick(p.onClick);
  } catch { /* ignore */ }
  return () => {
    try { b.offClick(p.onClick); b.hide(); } catch { /* ignore */ }
  };
}
export const bindMain = (p: BottomParams) => bindBottom('MainButton', p);
export const bindSecondary = (p: BottomParams) => bindBottom('SecondaryButton', p);
