/**
 * Owner connector (phase 1b): the userspace tailscaled SOCKS address comes from
 * the environment (set by Nix); we only tell nanogate about it. Tailscale
 * LocalAPI is out of scope for the host.
 */
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

export type ConnectorStatus = 'ok' | 'down' | 'not_configured';

let lastProbe: { at: number; up: boolean } | null = null;

/** Real state of the owner's home connector (cached 30 s). */
export async function ownerConnectorStatus(fresh = false): Promise<ConnectorStatus> {
  const socksAddr = nc.ownerConnectorSocks();
  if (!socksAddr) return 'not_configured';
  if (!fresh && lastProbe && Date.now() - lastProbe.at < 30_000) return lastProbe.up ? 'ok' : 'down';
  // The address is a container alias on the connector network: probe it from nanogate, which sits on that network.
  const up = await nanogateAdmin.probeConnector(socksAddr).catch(() => false);
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
