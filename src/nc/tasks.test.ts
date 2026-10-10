import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = vi.hoisted(() => `/tmp/nc-tasks-${process.pid}`);
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: `${TMP}/data`, GROUPS_DIR: `${TMP}/groups`, TIMEZONE: 'UTC' };
});
vi.mock('../container-runner.js', () => ({ isContainerRunning: vi.fn(() => false), killContainer: vi.fn() }));

import { closeDb, createAgentGroup } from '../db/index.js';
import { createSession } from '../db/sessions.js';
import { createScheduledTask, prepareScheduledTask } from '../modules/scheduling/create.js';
import { initSessionFolder, withMailboxSession } from '../session-manager.js';
import {
  hasSystemPaused,
  humanSchedule,
  listTasks,
  pauseAllTasks,
  pauseTask,
  resumeAllTasks,
  resumeTask,
} from './tasks.js';
import { kvGet } from './store.js';
import { setupDb } from './test-helpers.js';

const G = 'ag-t';
const TG = 3001;

async function mk(name: string, spec: { recurrence?: string; processAfter?: string }): Promise<string> {
  const t = await createScheduledTask(G, prepareScheduledTask({ name, prompt: `prompt ${name}`, ...spec }));
  return t.row.seriesId ?? t.row.id;
}

async function setProcessAfter(id: string, iso: string): Promise<void> {
  const sess = (await import('../db/sessions.js')).findTaskSessions;
  for (const s of await sess(G, true)) {
    await withMailboxSession(G, s.id, (db) => db.updateTask(id, { processAfter: iso }));
  }
}

beforeEach(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  await setupDb();
  await createAgentGroup({ id: G, name: 't', folder: 't', agent_provider: null, created_at: new Date().toISOString() });
  await createSession({
    id: 's-t',
    agent_group_id: G,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  });
  initSessionFolder(G, 's-t');
});
afterEach(closeDb);
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('humanSchedule', () => {
  it('reads common cron shapes in Russian', () => {
    const h = (c: string): string => humanSchedule(c, null, 'UTC');
    expect(h('0 9 * * *')).toBe('Каждый день в 09:00');
    expect(h('0 9 * * 1-5')).toBe('По будням в 09:00');
    expect(h('30 10 * * 0,6')).toBe('По выходным в 10:30');
    expect(h('0 8 * * 1,3')).toBe('Пн, ср в 08:00');
    expect(h('0 9 * * 1')).toContain('понедельник');
    expect(h('0 9 1 * *')).toBe('Каждое 1-е число в 09:00');
    expect(h('0 */2 * * *')).toBe('Каждые 2 ч');
    expect(h('*/15 * * * *')).toBe('Каждые 15 мин');
    expect(h('0 0 1 1 *')).toContain('По расписанию');
  });
});

describe('task names', () => {
  it('a Russian --name survives (the id slug drops it) and is what the lists show', async () => {
    const id = await mk('Дайджест новостей', { recurrence: '0 9 * * 1-5' });
    expect(id).toMatch(/^t-|^[a-z0-9-]+$/);
    const [t] = await listTasks(G);
    expect(t.name).toBe('Дайджест новостей');
    expect(t.scheduleHuman).toBe('По будням в 09:00');
  });
  it('without a name the first line of the prompt is used', async () => {
    await createScheduledTask(
      G,
      prepareScheduledTask({ prompt: 'Проверить ленту\nвторая строка', recurrence: '0 9 * * *' }),
    );
    expect((await listTasks(G))[0].name).toBe('Проверить ленту');
  });
});

describe('system pause / resume', () => {
  it('resumes only what the system paused: a task the user paused herself stays paused', async () => {
    const a = await mk('digest', { recurrence: '0 9 * * *' });
    const b = await mk('mine', { recurrence: '0 10 * * *' });
    await pauseTask(G, b); // the user paused «mine»
    expect(await pauseAllTasks(G, TG)).toBe(1); // only «digest» was running
    expect(await hasSystemPaused(TG)).toBe(true);
    const out = await resumeAllTasks(G, TG);
    expect(out.resumed).toBe(1);
    const byId = Object.fromEntries((await listTasks(G)).map((t) => [t.id, t.status]));
    expect(byId[a]).toBe('active');
    expect(byId[b]).toBe('paused');
    expect(await kvGet(`sys-paused:${TG}`)).toBeUndefined();
    expect(await hasSystemPaused(TG)).toBe(false);
  });

  it('a recurring task that came due during the pause moves to its next occurrence instead of firing at once', async () => {
    const id = await mk('digest', { recurrence: '0 9 * * *' });
    await pauseAllTasks(G, TG);
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await setProcessAfter(id, past);
    await resumeAllTasks(G, TG);
    const t = (await listTasks(G))[0];
    expect(t.status).toBe('active');
    expect(Date.parse(t.nextRunAt!)).toBeGreaterThan(Date.now());
  });

  it('an overdue one-shot reminder stays paused on a system resume and is reported once', async () => {
    const id = await mk('Позвонить маме', { processAfter: new Date(Date.now() + 3_600_000).toISOString() });
    await pauseAllTasks(G, TG);
    await setProcessAfter(id, new Date(Date.now() - 3_600_000).toISOString());
    const out = await resumeAllTasks(G, TG);
    expect(out.resumed).toBe(0);
    expect(out.skipped).toEqual(['Позвонить маме']);
    expect((await listTasks(G))[0].status).toBe('paused');
  });

  it('an explicit user resume of an overdue one-shot does fire it (the user asked)', async () => {
    const id = await mk('once', { processAfter: new Date(Date.now() + 3_600_000).toISOString() });
    await pauseTask(G, id);
    await setProcessAfter(id, new Date(Date.now() - 3_600_000).toISOString());
    expect(await resumeTask(G, id)).toBe(1);
    expect((await listTasks(G))[0].status).toBe('active');
  });
});

describe('re-arming', () => {
  it('rearmRecurring moves the next occurrence into the new timezone', async () => {
    await mk('digest', { recurrence: '0 9 * * *' });
    const { rearmRecurring } = await import('./tasks.js');
    expect(await rearmRecurring(G, 'Asia/Tbilisi')).toBe(1);
    const next = new Date((await listTasks(G))[0].nextRunAt!);
    expect(next.getUTCHours()).toBe(5); // 09:00 in Tbilisi (UTC+4) is 05:00 UTC
  });
});

void path;
