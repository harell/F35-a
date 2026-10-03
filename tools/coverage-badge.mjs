// Coverage badge: turns Vitest's json-summary (coverage/coverage-summary.json, `npm run coverage`) into a shields.io
// endpoint file. The deploy workflow writes it into dist/ so GitHub Pages serves it next to the game, and the README
// badge reads it: https://img.shields.io/endpoint?url=https://harell.github.io/F35-a/badges/coverage.json
//
//   node tools/coverage-badge.mjs [out=dist/badges/coverage.json]
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? 'dist/badges/coverage.json';
const summary = JSON.parse(fs.readFileSync('coverage/coverage-summary.json', 'utf8'));
const pct = summary.total.lines.pct;
const color = pct >= 80 ? 'brightgreen' : pct >= 70 ? 'green' : pct >= 60 ? 'yellowgreen' : pct >= 50 ? 'yellow' : pct >= 40 ? 'orange' : 'red';
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ schemaVersion: 1, label: 'coverage', message: `${pct.toFixed(1)}%`, color }) + '\n');
console.log(`coverage badge: ${pct.toFixed(1)}% lines (${color}) → ${out}`);
