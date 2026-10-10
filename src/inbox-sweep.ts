// nanoclaw-fork: retention + quota for session inboxes (data/v2-sessions/<group>/<session>/inbox/<msgId>/<file>).
//
// Attachments the user sent stay in the inbox only as long as the agent plausibly needs them:
//   NC_INBOX_RETENTION_DAYS  delete message dirs older than this (default 30; 0 = keep forever)
//   NC_INBOX_QUOTA_MB        per agent group (tenant) cap; the oldest message dirs go first (default 500; 0 = no cap)
// The container owns these directories, so everything goes through descriptors (AnchoredDir), never paths.
import fs from 'fs';
import path from 'path';

import { AnchoredDir } from './anchored-dir.js';
import { log } from './log.js';
import { sessionsBaseDir } from './session-manager.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface MessageDir {
  inbox: string[]; // path segments below the session dir
  sessionDir: string;
  name: string;
  bytes: number;
  newestMs: number;
}

function intEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function removeMessageDir(inbox: AnchoredDir, name: string): boolean {
  let dir: AnchoredDir | null = null;
  try {
    dir = inbox.openDir(name);
    if (!dir) return false;
    // One level, no recursion — same shape as the outbox cleanup. Anything unexpected surfaces as an error.
    for (const entry of dir.entries()) dir.unlink(entry);
    dir.close();
    dir = null;
    inbox.rmdir(name);
    return true;
  } catch (err) {
    log.warn('Inbox cleanup failed', { name, err });
    return false;
  } finally {
    dir?.close();
  }
}

export function sweepInboxes(
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
  root = sessionsBaseDir(),
): { removedDirs: number; removedBytes: number } {
  const retentionMs = intEnv(env.NC_INBOX_RETENTION_DAYS, 30) * DAY_MS;
  const quotaBytes = intEnv(env.NC_INBOX_QUOTA_MB, 500) * 1024 * 1024;
  let removedDirs = 0;
  let removedBytes = 0;

  for (const group of subdirs(root)) {
    const found: MessageDir[] = [];
    for (const session of subdirs(path.join(root, group))) {
      const sessionDir = path.join(root, group, session);
      let inbox: AnchoredDir | null = null;
      try {
        inbox = AnchoredDir.open(sessionDir, ['inbox']);
        if (!inbox) continue;
        for (const name of inbox.entries()) {
          let msgDir: AnchoredDir | null = null;
          try {
            msgDir = inbox.openDir(name);
            if (!msgDir) continue;
            let bytes = 0;
            let newestMs = 0;
            for (const file of msgDir.entries()) {
              const st = msgDir.lstat(file);
              bytes += st.size;
              newestMs = Math.max(newestMs, st.mtimeMs);
            }
            if (newestMs === 0) newestMs = inbox.lstat(name).mtimeMs;
            found.push({ inbox: ['inbox'], sessionDir, name, bytes, newestMs });
          } catch (err) {
            log.warn('Inbox scan skipped an entry', { group, session, name, err });
          } finally {
            msgDir?.close();
          }
        }
      } catch (err) {
        log.warn('Inbox scan failed', { group, session, err });
      } finally {
        inbox?.close();
      }
    }

    // Decide per group: too old first, then oldest-first until under quota.
    const doomed = new Set<MessageDir>();
    if (retentionMs > 0) for (const m of found) if (now - m.newestMs > retentionMs) doomed.add(m);
    if (quotaBytes > 0) {
      let total = found.filter((m) => !doomed.has(m)).reduce((n, m) => n + m.bytes, 0);
      for (const m of [...found].sort((a, b) => a.newestMs - b.newestMs)) {
        if (total <= quotaBytes) break;
        if (doomed.has(m)) continue;
        doomed.add(m);
        total -= m.bytes;
      }
    }
    for (const m of doomed) {
      let inbox: AnchoredDir | null = null;
      try {
        inbox = AnchoredDir.open(m.sessionDir, ['inbox']);
        if (inbox && removeMessageDir(inbox, m.name)) {
          removedDirs++;
          removedBytes += m.bytes;
        }
      } catch (err) {
        log.warn('Inbox cleanup failed', { name: m.name, err });
      } finally {
        inbox?.close();
      }
    }
  }
  if (removedDirs > 0) log.info('Inbox sweep removed old attachments', { removedDirs, removedBytes });
  return { removedDirs, removedBytes };
}
