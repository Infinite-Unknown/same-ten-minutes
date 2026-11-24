import { defineConfig } from 'vite';

export default defineConfig({
  // relative base: the built site works from any GitHub Pages path
  base: './',
  build: { target: 'es2022' },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'] },
} as never);
