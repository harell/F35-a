/**
 * Build the pests review page (src/render/dev/pestsReview.ts in tools/pests-artifact.html) as one
 * self-contained HTML file for a claude.ai Artifact: three.js and the models bundled inline.
 * Usage: node tools/pests-artifact.mjs [out.html]   (default dist-artifact/pests.html)
 */
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const out = process.argv[2] ?? 'dist-artifact/pests.html';
const res = await build({
  entryPoints: ['src/render/dev/pestsReview.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  legalComments: 'none',
});
const js = res.outputFiles[0].text.replace(/<\/script/g, '<\\/script');
const page = fs.readFileSync('tools/pests-artifact.html', 'utf8');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${page}\n<script>${js}</script>\n`);
console.log(`${out}: ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
