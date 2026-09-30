/**
 * F35-A UI art — the game logo: F-35A top-view silhouette in a targeting reticle + "F35-A" wordmark.
 * Pure CSS/SVG (animated in theme.css: reticle spin-in, sweep, glint).
 */
import { canopy, finPath, frameFor, outlinePath } from './planform';

let cachedMark = '';

/** The emblem (reticle + jet) as inline SVG. */
export function logoMark(): string {
  if (cachedMark) return cachedMark;
  const W = 200;
  const f = frameFor(110, 110);
  // centre the 110×110 jet inside the 200×200 reticle
  const jet = { ...f, cx: f.cx + 45, top: f.top + 45 };
  const c = canopy(jet);
  const ticks: string[] = [];
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const long = i % 9 === 0;
    const r1 = long ? 84 : 88;
    const r2 = 92;
    ticks.push(
      `<line x1="${(100 + Math.cos(a) * r1).toFixed(1)}" y1="${(100 + Math.sin(a) * r1).toFixed(1)}" x2="${(100 + Math.cos(a) * r2).toFixed(1)}" y2="${(100 + Math.sin(a) * r2).toFixed(1)}"/>`,
    );
  }
  cachedMark =
    `<svg class="logo-mark" viewBox="0 0 ${W} ${W}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<defs>` +
    `<linearGradient id="lgJet" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9ff0ff"/><stop offset=".55" stop-color="#3fb7d6"/><stop offset="1" stop-color="#1a5a70"/></linearGradient>` +
    `<radialGradient id="lgGlow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#5fe3ff" stop-opacity=".28"/><stop offset="1" stop-color="#5fe3ff" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="lgSweep" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5fe3ff" stop-opacity="0"/><stop offset="1" stop-color="#5fe3ff" stop-opacity=".55"/></linearGradient>` +
    `</defs>` +
    `<circle cx="100" cy="100" r="96" fill="url(#lgGlow)"/>` +
    `<g class="logo-ring" stroke="#5fe3ff" stroke-width="1.4" opacity=".75">${ticks.join('')}</g>` +
    `<circle class="logo-ring2" cx="100" cy="100" r="74" fill="none" stroke="#5fe3ff" stroke-opacity=".35" stroke-width="1" stroke-dasharray="3 5"/>` +
    `<g class="logo-sweep"><path d="M100 100 L100 8 A92 92 0 0 1 165 35 Z" fill="url(#lgSweep)" opacity=".5"/></g>` +
    `<g class="logo-brackets" fill="none" stroke="#b8f6ff" stroke-width="2.2">` +
    `<path d="M40 60 V40 H60"/><path d="M140 40 H160 V60"/><path d="M160 140 V160 H140"/><path d="M60 160 H40 V140"/></g>` +
    `<g class="logo-jet">` +
    `<path d="${outlinePath(jet)}" fill="url(#lgJet)" stroke="#dffaff" stroke-width="1" stroke-linejoin="round"/>` +
    `<path d="${finPath(jet)}" fill="#1d4f62" stroke="#bff4ff" stroke-width=".8" stroke-linejoin="round"/>` +
    `<ellipse cx="${c.cx.toFixed(1)}" cy="${c.cy.toFixed(1)}" rx="${c.rx.toFixed(1)}" ry="${c.ry.toFixed(1)}" fill="#ffd27a" opacity=".9"/>` +
    `</g></svg>`;
  return cachedMark;
}

/** Full logo block: emblem + wordmark + tagline. */
export function logoBlock(tagline = 'RATITES'): string {
  return (
    `<div class="logo">` +
    `<div class="logo-emblem">${logoMark()}</div>` +
    `<div class="logo-text">` +
    `<div class="logo-word"><span class="lw-f">F35</span><span class="lw-dash">-</span><span class="lw-a">A</span></div>` +
    `<div class="logo-tag">${tagline}</div>` +
    `</div></div>`
  );
}
