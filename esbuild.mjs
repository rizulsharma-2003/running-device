import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions[]} */
const builds = [
  {
    // Extension host (Node)
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    // Webview (browser, runs inside VS Code's Chromium)
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
  },
];

const contexts = await Promise.all(
  builds.map((options) =>
    esbuild.context({
      ...options,
      sourcemap: !production,
      minify: production,
      logLevel: 'info',
    }),
  ),
);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
