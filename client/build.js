// Client build: bundles src/main.js (+ three.js) into dist/game.js and copies index.html.
// Optional: STRIKEZONE_SERVER_URL env var bakes the production WebSocket URL into the build.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const SERVER_URL = process.env.STRIKEZONE_SERVER_URL || '';
const watch = process.argv.includes('--watch');

fs.mkdirSync(DIST, { recursive: true });

let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
html = html.replaceAll('__SERVER_URL__', SERVER_URL);
// cache-bust the bundle so browsers pick up new builds immediately
html = html.replaceAll('src="game.js"', `src="game.js?v=${Date.now()}"`);
fs.writeFileSync(path.join(DIST, 'index.html'), html);

const opts = {
  entryPoints: [path.join(__dirname, 'src/main.js')],
  bundle: true,
  minify: !watch,
  sourcemap: watch,
  format: 'iife',
  target: ['es2020'],
  outfile: path.join(DIST, 'game.js'),
  logLevel: 'info',
  define: { STRIKEZONE_SERVER_URL: JSON.stringify(SERVER_URL) },
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('watching client sources…');
} else {
  await esbuild.build(opts);
  const kb = (fs.statSync(path.join(DIST, 'game.js')).size / 1024).toFixed(0);
  console.log(`built dist/game.js (${kb} KB) + dist/index.html`);
}
