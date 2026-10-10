// Optional response fields the backend may add. types.ts is shared byte-for-byte with src/nc/miniapp/types.ts,
// so additions live here until the backend contract carries them; every field is optional and the UI degrades without it.
import type { Connection, GuestContext, SystemView, UsageView } from './types';

export interface AuditRow { at: string; actor: string; action: string; target?: string }
export interface SystemViewX extends SystemView {
  buildId?: string; deployedAt?: string; grafanaUrl?: string; recentAudit?: AuditRow[];
}
/** `managed`: run by the server (the owner's connector) — no key entry, no revoke. */
export interface ConnectionX extends Connection { managed?: boolean }
/** `voiceSeconds`: transcribed voice in the period (free, local whisper). */
export interface UsageViewX extends UsageView { voiceSeconds?: number }
export interface GuestContextX extends GuestContext { maxChars?: number }
export interface GuestPreview { answer: string }

export const GUEST_MAX_DEFAULT = 8000; // src/nc/guest-store.ts GUEST_MAX_CHARS
