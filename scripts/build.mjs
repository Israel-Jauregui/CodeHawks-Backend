import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist', { recursive: true });

const buildTargets = [
  { entryPoint: 'src/handler.ts', outfile: 'dist/handler.mjs' },
  { entryPoint: 'src/auth/cognito-trigger.ts', outfile: 'dist/cognito-trigger.mjs' },
  {
    entryPoint: 'src/email/newsletter-worker-handler.ts',
    outfile: 'dist/newsletter-worker.mjs',
  },
];

await Promise.all(
  buildTargets.map(({ entryPoint, outfile }) =>
    build({
      bundle: true,
      entryPoints: [entryPoint],
      format: 'esm',
      legalComments: 'none',
      // Prefer dependencies' ESM entry points. Choosing their CommonJS builds
      // leaves dynamic require("node:...") calls that cannot run in Lambda ESM.
      mainFields: ['module', 'main'],
      minify: true,
      outfile,
      platform: 'node',
      sourcemap: true,
      target: 'node22',
    }),
  ),
);

for (const { outfile } of buildTargets) {
  const bundle = await readFile(outfile, 'utf8');
  if (bundle.includes('Dynamic require of "')) {
    throw new Error(`${outfile} contains a CommonJS dynamic require in an ESM Lambda bundle.`);
  }
}
