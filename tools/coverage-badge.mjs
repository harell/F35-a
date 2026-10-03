// Coverage badge: turns Vitest's json-summary (coverage/coverage-summary.json, `npm run coverage`) into a shields.io
// endpoint file. The coverage workflow (.github/workflows/coverage.yml) publishes it on the `badges` branch, and the
// README badge reads it: https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/harell/F35-a/badges/coverage.json
//
//   node tools/coverage-badge.mjs [out=badges/coverage.json]
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? 'badges/coverage.json';
const summary = JSON.parse(fs.readFileSync('coverage/coverage-summary.json', 'utf8'));
const pct = summary.total.lines.pct;
const color = pct >= 80 ? 'brightgreen' : pct >= 70 ? 'green' : pct >= 60 ? 'yellowgreen' : pct >= 50 ? 'yellow' : pct >= 40 ? 'orange' : 'red';
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ schemaVersion: 1, label: 'coverage', message: `${pct.toFixed(1)}%`, color }) + '\n');
console.log(`coverage badge: ${pct.toFixed(1)}% lines (${color}) → ${out}`);
