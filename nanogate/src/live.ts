// Registry of live tunnels / in-flight proxied requests, so pause/revoke/session-end can kill them.

export type LiveKind = 'tunnel' | 'request';

export interface LiveEntry {
  tenantId: string;
  tokenHash: string;
  kind: LiveKind;
  /** 'connector' for tunnels carried by a SOCKS connector. */
  via?: 'direct' | 'connector';
  /** Tenant whose connector carries the tunnel (may differ from tenantId for shared residential egress). */
  connectorOwner?: string;
  destroy(): void;
}

export class LiveRegistry {
  private readonly entries = new Set<LiveEntry>();

  add(e: LiveEntry): () => void {
    this.entries.add(e);
    return () => {
      this.entries.delete(e);
    };
  }

  count(tenantId: string, kind: LiveKind): number {
    let n = 0;
    for (const e of this.entries) if (e.tenantId === tenantId && e.kind === kind) n++;
    return n;
  }

  total(kind: LiveKind): number {
    let n = 0;
    for (const e of this.entries) if (e.kind === kind) n++;
    return n;
  }

  private kill(pred: (e: LiveEntry) => boolean): number {
    let n = 0;
    for (const e of [...this.entries]) {
      if (!pred(e)) continue;
      this.entries.delete(e);
      try {
        e.destroy();
      } catch {
        // already gone
      }
      n++;
    }
    return n;
  }

  killTenant(tenantId: string, kinds?: LiveKind[]): number {
    return this.kill((e) => e.tenantId === tenantId && (!kinds || kinds.includes(e.kind)));
  }
  killToken(tokenHash: string): number {
    return this.kill((e) => e.tokenHash === tokenHash);
  }
  killConnectorTunnels(tenantId: string): number {
    return this.kill((e) => e.kind === 'tunnel' && e.via === 'connector' && e.connectorOwner === tenantId);
  }
}
