import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// CSP only in the production build: the dev server needs inline HMR scripts.
const csp: Plugin = {
  name: 'nanoclaw-csp',
  apply: 'build',
  transformIndexHtml() {
    return [
      {
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content:
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
        },
        injectTo: 'head-prepend',
      },
    ];
  },
};

export default defineConfig({
  plugins: [preact(), csp],
  build: { target: 'es2020', cssCodeSplit: false, sourcemap: false, modulePreload: { polyfill: false } },
  server: { port: 5173 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
