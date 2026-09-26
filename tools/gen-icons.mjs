#!/usr/bin/env node
/**
 * F35-A — PWA icon generator.
 *
 *   node tools/gen-icons.mjs
 *
 * Renders an SVG (stylised F-35A top-view silhouette in a targeting reticle + "F35-A") to PNG with
 * headless Chromium (playwright-core; the browser is auto-detected from PLAYWRIGHT_BROWSERS_PATH):
 *   public/icons/icon-192.png            purpose "any"
 *   public/icons/icon-512.png            purpose "any"
 *   public/icons/icon-maskable-512.png   purpose "maskable" (content inside the 80 % safe circle)
 *   public/icons/icon-180.png            apple-touch-icon (opaque, iOS rounds the corners)
 * The silhouette geometry is shared with the in-game logo (src/ui/art/planform.ts, imported directly
 * thanks to Node's built-in TypeScript type stripping).
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

let planform;
try {
  planform = await import(path.join(root, 'src/ui/art/planform.ts'));
} catch (err) {
  console.error('Could not import src/ui/art/planform.ts (needs Node ≥ 22.18 or --experimental-strip-types):', err.message);
  process.exit(1);
}
const { frameFor, outlinePath, finPath, canopy } = planform;

/**
 * @param {number} S      canvas size (px)
 * @param {object} o
 * @param {number} o.safe fraction of the size the artwork may use (maskable: 0.72)
 * @param {boolean} o.text draw the "F35-A" wordmark
 */
function iconSvg(S, { safe, text }) {
  const c = S / 2;
  const R = (S * safe) / 2; // artwork radius
  const jetBox = R * (text ? 1.1 : 1.34);
  const f0 = frameFor(jetBox, jetBox, 0.02);
  const jetCy = text ? c - R * 0.16 : c;
  const f = { ...f0, cx: c, top: jetCy - jetBox / 2 + f0.top };
  const cp = canopy(f);
  const ticks = [];
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const long = i % 5 === 0;
    const r1 = R * (long ? 0.86 : 0.9);
    const r2 = R * 0.95;
    ticks.push(`<line x1="${(c + Math.cos(a) * r1).toFixed(2)}" y1="${(c + Math.sin(a) * r1).toFixed(2)}" x2="${(c + Math.cos(a) * r2).toFixed(2)}" y2="${(c + Math.sin(a) * r2).toFixed(2)}"/>`);
  }
  const b = R * (text ? 0.56 : 0.62); // bracket offset
  const bl = R * 0.2; // bracket length
  const br = (sx, sy) => `<path d="M${c + sx * b} ${c + sy * (b - bl)} V${c + sy * b} H${c + sx * (b - bl)}"/>`;
  const sw = Math.max(1.5, S / 110);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="70%">
      <stop offset="0" stop-color="#113246"/><stop offset=".55" stop-color="#081a26"/><stop offset="1" stop-color="#03080d"/>
    </radialGradient>
    <linearGradient id="jet" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#c8f7ff"/><stop offset=".5" stop-color="#4cc6e4"/><stop offset="1" stop-color="#1b6b85"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#5fe3ff" stop-opacity=".35"/><stop offset="1" stop-color="#5fe3ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#5fe3ff" stop-opacity="0"/><stop offset="1" stop-color="#5fe3ff" stop-opacity=".45"/>
    </linearGradient>
  </defs>
  <rect width="${S}" height="${S}" fill="url(#bg)"/>
  <g stroke="#5fe3ff" stroke-opacity=".08" stroke-width="${S / 512}">
    ${Array.from({ length: 9 }, (_, i) => `<line x1="${(S * (i + 1)) / 10}" y1="0" x2="${(S * (i + 1)) / 10}" y2="${S}"/><line x1="0" y1="${(S * (i + 1)) / 10}" x2="${S}" y2="${(S * (i + 1)) / 10}"/>`).join('')}
  </g>
  <circle cx="${c}" cy="${c}" r="${R}" fill="url(#glow)"/>
  <path d="M${c} ${c} L${c} ${c - R * 0.95} A${R * 0.95} ${R * 0.95} 0 0 1 ${c + R * 0.95 * Math.sin(1.1)} ${c - R * 0.95 * Math.cos(1.1)} Z" fill="url(#sweep)" opacity=".6"/>
  <g stroke="#5fe3ff" stroke-width="${sw * 0.8}" stroke-opacity=".8">${ticks.join('')}</g>
  <circle cx="${c}" cy="${c}" r="${R * 0.76}" fill="none" stroke="#5fe3ff" stroke-opacity=".3" stroke-width="${sw * 0.6}" stroke-dasharray="${sw * 2} ${sw * 3}"/>
  <g fill="none" stroke="#bff6ff" stroke-width="${sw * 1.3}" stroke-linecap="square">${br(-1, -1)}${br(1, -1)}${br(1, 1)}${br(-1, 1)}</g>
  <path d="${outlinePath(f)}" fill="url(#jet)" stroke="#e6fcff" stroke-width="${sw * 0.6}" stroke-linejoin="round"/>
  <path d="${finPath(f)}" fill="#1c4d60" stroke="#c6f5ff" stroke-width="${sw * 0.5}" stroke-linejoin="round"/>
  <ellipse cx="${cp.cx}" cy="${cp.cy}" rx="${cp.rx}" ry="${cp.ry}" fill="#ffd27a"/>
  ${
    text
      ? `<text x="${c}" y="${c + R * 0.94}" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-weight="900" font-size="${R * 0.34}" letter-spacing="${R * 0.02}" fill="#ffffff" stroke="#03080d" stroke-width="${R * 0.03}" paint-order="stroke">F35<tspan fill="#5fe3ff">-</tspan>A</text>`
      : ''
  }
</svg>`;
}

const TARGETS = [
  { file: 'icon-192.png', size: 192, safe: 0.92, text: true },
  { file: 'icon-512.png', size: 512, safe: 0.92, text: true },
  { file: 'icon-maskable-512.png', size: 512, safe: 0.72, text: true },
  { file: 'icon-180.png', size: 180, safe: 0.86, text: true },
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const t of TARGETS) {
  const svg = iconSvg(t.size, t);
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#03080d">${svg}</body></html>`);
  const file = path.join(outDir, t.file);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: t.size, height: t.size }, omitBackground: false });
  console.log('wrote', path.relative(root, file));
}
// keep the vector master too (handy for stores / social cards)
fs.writeFileSync(path.join(outDir, 'icon.svg'), iconSvg(512, { safe: 0.92, text: true }));
console.log('wrote public/icons/icon.svg');
await browser.close();
