import { rm } from 'node:fs/promises';

await Promise.all([
  rm('coverage', { force: true, recursive: true }),
  rm('dist', { force: true, recursive: true }),
]);
