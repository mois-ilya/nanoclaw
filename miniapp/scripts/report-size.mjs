// Prints gzip size of everything in dist/ (excluding the vendored Telegram script) and fails over 200 KB.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const LIMIT = 200 * 1024;
let total = 0;
function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|css|html)$/.test(f)) {
      const gz = gzipSync(readFileSync(p)).length;
      const vendored = f === 'telegram-web-app.js';
      console.log(`${vendored ? '(vendored) ' : ''}${p}  ${(gz / 1024).toFixed(1)} KB gzip`);
      if (!vendored) total += gz;
    }
  }
}
walk('dist');
console.log(`TOTAL (app, gzip): ${(total / 1024).toFixed(1)} KB / limit ${LIMIT / 1024} KB`);
if (total > LIMIT) {
  console.error('Bundle exceeds 200 KB gzip');
  process.exit(1);
}
