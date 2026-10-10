/**
 * Owner connector (phase 1b): the userspace tailscaled SOCKS address comes from
 * the environment (set by Nix); we only tell nanogate about it. Tailscale
 * LocalAPI is out of scope for the host.
 */
import net from 'node:net';

import { log } from '../log.js';
import { nanogateAdmin } from '../gateway-providers/nanogate/index.js';
import { nc, ownerTgId, userIdOf } from './config.js';

export function ownerConnectorConfigured(): boolean {
  return nc.ownerConnectorSocks() !== '';
}

/**
 * Whether the home connector has an exit node. `NC_OWNER_EXIT_NODE` unset (an older module that does not
 * emit it) keeps the previous behaviour (true); set-but-empty means «no exit node configured».
 */
export function ownerHasExitNode(): boolean {
  const v = process.env.NC_OWNER_EXIT_NODE;
  return v === undefined ? true : v.trim() !== '';
}

/** Is something listening on the SOCKS address of the userspace tailscaled? (A TCP connect, nothing more.) */
export function probeSocks(addr: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const i = addr.lastIndexOf(':');
    const host = i > 0 ? addr.slice(0, i) : '';
    const port = Number(addr.slice(i + 1));
    if (!host || !Number.isInteger(port) || port <= 0) return resolve(false);
    const sock = net.connect({ host, port });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export type ConnectorStatus = 'ok' | 'down' | 'not_configured';

let lastProbe: { at: number; up: boolean } | null = null;

/** Real state of the owner's home connector (cached 30 s). */
export async function ownerConnectorStatus(fresh = false): Promise<ConnectorStatus> {
  const socksAddr = nc.ownerConnectorSocks();
  if (!socksAddr) return 'not_configured';
  if (!fresh && lastProbe && Date.now() - lastProbe.at < 30_000) return lastProbe.up ? 'ok' : 'down';
  const up = await probeSocks(socksAddr);
  lastProbe = { at: Date.now(), up };
  return up ? 'ok' : 'down';
}

/** PUT /connectors/<owner> with the probed status and the tailnet CIDRs from env. */
export async function syncOwnerConnector(): Promise<boolean> {
  const owner = ownerTgId();
  const socksAddr = nc.ownerConnectorSocks();
  if (owner === null || !socksAddr) return false;
  try {
    const status = await ownerConnectorStatus(true);
    await nanogateAdmin.putConnector(userIdOf(owner), {
      socksAddr,
      status: status === 'ok' ? 'up' : 'down',
      routes: { cidrs: nc.ownerTailnetCidrs(), exitNode: ownerHasExitNode() },
    });
    return true;
  } catch (err) {
    log.warn('nc: owner connector sync failed', { err });
    return false;
  }
}
