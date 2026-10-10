// Minimal IPv4/IPv6 parsing and CIDR matching on BigInt. No dependencies.

export interface Ip {
  v: 4 | 6;
  n: bigint;
}

export interface Cidr extends Ip {
  bits: number;
}

function parseV4(s: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0n;
  for (let i = 1; i <= 4; i++) {
    const part = m[i]!;
    if (part.length > 1 && part.startsWith('0')) return null; // no octal-looking forms
    const o = Number(part);
    if (o > 255) return null;
    n = (n << 8n) | BigInt(o);
  }
  return n;
}

function parseV6(input: string): bigint | null {
  let s = input;
  if (s.includes('%')) return null;
  const lastColon = s.lastIndexOf(':');
  if (lastColon < 0) return null;
  const last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseV4(last);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  let groups: string[];
  if (parts.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    if (head.length + tail.length > 7) return null;
    groups = [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  }
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** Parse an IP literal (brackets tolerated). IPv4-mapped IPv6 (::ffff:a.b.c.d) is returned as IPv4. */
export function parseIp(input: string): Ip | null {
  const s = input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input;
  const v4 = parseV4(s);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = parseV6(s);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { v: 4, n: v6 & 0xffffffffn };
  return { v: 6, n: v6 };
}

/** Parse "a.b.c.d/len", "x::/len" or a bare IP (full-length prefix). */
export function parseCidr(input: string): Cidr | null {
  const [addr, len, ...rest] = input.split('/');
  if (rest.length > 0 || !addr) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const width = ip.v === 4 ? 32 : 128;
  let bits = width;
  if (len !== undefined) {
    if (!/^\d{1,3}$/.test(len)) return null;
    bits = Number(len);
    // An IPv4-mapped IPv6 prefix (::ffff:a.b.c.d/N) was folded to v4 by parseIp; ::ffff:0:0/96 would fold to
    // 0.0.0.0/0 and match everything. Mapped prefixes are invalid input: write the IPv4 CIDR instead.
    if (ip.v === 4 && addr.includes(':')) return null;
    if (bits < 0 || bits > width) return null;
  }
  return { ...ip, bits };
}

/**
 * A connector route is a tailnet subnet: no IPv4-mapped forms, nothing broader than /8 (v4) or /16 (v6),
 * so 0.0.0.0/0 or ::/0 (an exit node's default routes) can never widen the allowed set to "every IP".
 */
export function validConnectorCidr(input: string): boolean {
  const c = parseCidr(input);
  if (!c) return false;
  if (c.v === 4 && input.includes(':')) return false;
  return c.bits >= (c.v === 4 ? 8 : 16);
}

export function cidrContains(c: Cidr, ip: Ip): boolean {
  if (c.v !== ip.v) return false;
  const shift = BigInt((c.v === 4 ? 32 : 128) - c.bits);
  return c.n >> shift === ip.n >> shift;
}

export class CidrSet {
  private readonly items: Cidr[] = [];

  constructor(cidrs: Iterable<string> = []) {
    for (const c of cidrs) this.add(c);
  }

  add(cidr: string): void {
    const p = parseCidr(cidr);
    if (!p) throw new Error(`invalid CIDR: ${cidr}`);
    this.items.push(p);
  }

  matches(ip: Ip | string): boolean {
    const parsed = typeof ip === 'string' ? parseIp(ip) : ip;
    if (!parsed) return false;
    return this.items.some((c) => cidrContains(c, parsed));
  }
}
