// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import { houseDefaults } from '@robyrew/web-config/astro';

// A static site: every conversion runs in the visitor's browser (a module Web Worker),
// so there is no server code and nothing to upload to.
export default defineConfig({
  ...houseDefaults,
  site: process.env.PUBLIC_SITE_URL || 'https://chat-converter.robyrew.com',
  output: 'static',
  server: { port: 4325 },
  vite: {
    plugins: [tailwindcss()],
    worker: { format: 'es' },
    build: { target: 'safari16', cssTarget: 'safari16' },
    // The library is linked from the repo root ("file:..") and exports TypeScript source, so the dev
    // server must be allowed to serve files from there (the worker module included).
    optimizeDeps: { exclude: ['@robyrew/chat-converter'] },
    server: { fs: { allow: ['..'] } },
  },
});
