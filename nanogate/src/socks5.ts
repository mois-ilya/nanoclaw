import net from 'node:net';

export interface SocksTarget {
  /** hostname (ATYP domain) or IP literal (ATYP 1/4) */
  host: string;
  port: number;
}

/** Minimal SOCKS5 client: no-auth, CONNECT only. Resolves with the connected, paused socket. */
export function socks5Connect(socksAddr: string, target: SocksTarget, timeoutMs: number, signal?: AbortSignal): Promise<net.Socket> {
  const idx = socksAddr.lastIndexOf(':');
  const sHost = socksAddr.slice(0, idx).replace(/^\[|\]$/g, '');
  const sPort = Number(socksAddr.slice(idx + 1));
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: sHost, port: sPort });
    let buf = Buffer.alloc(0);
    let stage: 'greet' | 'reply' = 'greet';
    const fail = (e: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      sock.destroy();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('socks5 timeout')), timeoutMs);
    const onAbort = () => fail(new Error('aborted'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    sock.on('error', fail);
    sock.on('close', () => fail(new Error('socks5 closed')));
    sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));

    const request = (): Buffer => {
      const ip = net.isIP(target.host);
      let addr: Buffer;
      if (ip === 4) addr = Buffer.concat([Buffer.from([1]), Buffer.from(target.host.split('.').map(Number))]);
      else if (ip === 6) addr = Buffer.concat([Buffer.from([4]), ipv6Bytes(target.host)]);
      else {
        const name = Buffer.from(target.host, 'ascii');
        if (name.length === 0 || name.length > 255) throw new Error('bad socks host');
        addr = Buffer.concat([Buffer.from([3, name.length]), name]);
      }
      const port = Buffer.alloc(2);
      port.writeUInt16BE(target.port);
      return Buffer.concat([Buffer.from([5, 1, 0]), addr, port]);
    };

    sock.on('data', function onData(d: Buffer) {
      buf = Buffer.concat([buf, d]);
      try {
        if (stage === 'greet') {
          if (buf.length < 2) return;
          if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error('socks5 auth method refused'));
          buf = buf.subarray(2);
          stage = 'reply';
          sock.write(request());
        }
        if (stage === 'reply') {
          if (buf.length < 5) return;
          if (buf[0] !== 5) return fail(new Error('socks5 bad reply'));
          if (buf[1] !== 0) return fail(new Error(`socks5 connect failed (code ${buf[1]})`));
          const atyp = buf[3];
          const len = atyp === 1 ? 10 : atyp === 4 ? 22 : atyp === 3 ? 7 + buf[4]! : -1;
          if (len < 0) return fail(new Error('socks5 bad atyp'));
          if (buf.length < len) return;
          const rest = buf.subarray(len);
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          sock.removeListener('data', onData);
          sock.removeAllListeners('close');
          sock.removeAllListeners('error');
          sock.pause();
          if (rest.length) sock.unshift(rest);
          resolve(sock);
        }
      } catch (e) {
        fail(e as Error);
      }
    });
  });
}

function ipv6Bytes(ip: string): Buffer {
  // Expand via URL-free manual parse (input already validated by net.isIP).
  let s = ip;
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const o = m[1]!.split('.').map(Number);
    s = s.slice(0, -m[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ':' + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const [h, t] = s.split('::');
  const head = h ? h.split(':') : [];
  const tail = t ? t.split(':') : [];
  const groups = s.includes('::') ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g, 16), i * 2));
  return b;
}
