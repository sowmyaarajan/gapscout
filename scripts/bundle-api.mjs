// Bundles src/app.ts into a single self-contained api/bundle.js for Vercel deployment.
// This avoids all module resolution issues since everything is in one file.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/app.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'api/_lib/bundle.js',
  minify: false,
  treeShaking: true,
  // dotenv is not needed on Vercel (env vars injected by platform)
  external: ['dotenv'],
});

console.log('Bundled src/app.ts → api/_lib/bundle.js');
