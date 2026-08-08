import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist', { recursive: true });

await Promise.all([
  build({
    bundle: true,
    entryPoints: ['src/handler.ts'],
    format: 'esm',
    legalComments: 'none',
    minify: true,
    outfile: 'dist/handler.mjs',
    platform: 'node',
    sourcemap: true,
    target: 'node22',
  }),
  build({
    bundle: true,
    entryPoints: ['src/auth/cognito-trigger.ts'],
    format: 'esm',
    legalComments: 'none',
    minify: true,
    outfile: 'dist/cognito-trigger.mjs',
    platform: 'node',
    sourcemap: true,
    target: 'node22',
  }),
  build({
    bundle: true,
    entryPoints: ['src/email/newsletter-worker-handler.ts'],
    format: 'esm',
    legalComments: 'none',
    minify: true,
    outfile: 'dist/newsletter-worker.mjs',
    platform: 'node',
    sourcemap: true,
    target: 'node22',
  }),
]);
