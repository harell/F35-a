/**
 * F35-A UI art — stylised F-35A planform (top view), used by the logo, the hangar store diagrams and
 * tools/gen-icons.mjs (which imports this file directly with Node's type stripping — keep it
 * dependency-free and erasable-syntax only).
 *
 * Half-planform points in metres: x = right of the centreline, y = aft of the nose (length 15.7 m,
 * span 10.7 m). Hand-traced proportions: chined radome, caret inlets, 35° wing leading edge,
 * forward-swept trailing edge, close-coupled tailplanes and a single round nozzle.
 */

export const F35_LENGTH = 15.67;
export const F35_HALF_SPAN = 5.35;

/** Outline from the nose tip down the right side to the nozzle centre (mirrored for the left). */
export const F35_HALF: [number, number][] = [
  [0, 0],
  [0.3, 0.8],
  [0.6, 1.8],
  [0.86, 2.8],
  [1.04, 3.7],
  [1.26, 4.62],
  [1.55, 5.45],
  [1.62, 6.3],
  [1.78, 7.05],
  [5.35, 9.65],
  [5.35, 10.9],
  [2.05, 11.75],
  [1.95, 12.15],
  [3.45, 13.55],
  [3.45, 14.4],
  [1.3, 14.95],
  [0.74, 15.08],
  [0.64, 15.67],
  [0, 15.67],
];

/** Canted vertical tails as seen from above (right side). */
export const F35_FIN: [number, number][] = [
  [1.22, 11.75],
  [1.98, 13.35],
  [2.1, 14.3],
  [1.5, 14.62],
];

/** Weapon stations (right side, metres) for the store diagrams. */
export const F35_STATIONS = {
  /** Internal bays (two per side: inboard A/G + outboard A/A). */
  bayOuter: [0.95, 9.6] as [number, number],
  bayInner: [0.55, 9.1] as [number, number],
  /** Wing pylons: inboard heavy, mid, outboard (AIM-9X). */
  pylonIn: [2.55, 10.35] as [number, number],
  pylonMid: [3.45, 10.4] as [number, number],
  pylonOut: [4.55, 10.3] as [number, number],
};

export interface PlanformFrame {
  /** Scale (SVG units per metre). */
  k: number;
  /** SVG x of the centreline. */
  cx: number;
  /** SVG y of the nose. */
  top: number;
}

export function frameFor(width: number, height: number, margin = 0.04): PlanformFrame {
  const k = Math.min((width * (1 - 2 * margin)) / (2 * F35_HALF_SPAN), (height * (1 - 2 * margin)) / F35_LENGTH);
  return { k, cx: width / 2, top: (height - F35_LENGTH * k) / 2 };
}

function pt(f: PlanformFrame, x: number, y: number): string {
  return `${(f.cx + x * f.k).toFixed(2)},${(f.top + y * f.k).toFixed(2)}`;
}

/** Closed SVG path of the full outline. */
export function outlinePath(f: PlanformFrame): string {
  const right = F35_HALF.map(([x, y]) => pt(f, x, y));
  const left = F35_HALF.slice(1, -1)
    .reverse()
    .map(([x, y]) => pt(f, -x, y));
  return `M${right.join(' L')} L${left.join(' L')} Z`;
}

/** Two fin quads as one path. */
export function finPath(f: PlanformFrame): string {
  const r = F35_FIN.map(([x, y]) => pt(f, x, y));
  const l = F35_FIN.map(([x, y]) => pt(f, -x, y));
  return `M${r.join(' L')} Z M${l.join(' L')} Z`;
}

/** Canopy (ellipse) as an SVG element attribute set. */
export function canopy(f: PlanformFrame): { cx: number; cy: number; rx: number; ry: number } {
  return { cx: f.cx, cy: f.top + 3.75 * f.k, rx: 0.42 * f.k, ry: 1.35 * f.k };
}

/** Full silhouette SVG markup (inline). */
export function silhouetteSvg(width: number, height: number, opts: { fill: string; stroke?: string; strokeWidth?: number; canopy?: string; fins?: string; cls?: string }): string {
  const f = frameFor(width, height);
  const c = canopy(f);
  const sw = opts.strokeWidth ?? 0;
  return (
    `<svg class="${opts.cls ?? ''}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<path d="${outlinePath(f)}" fill="${opts.fill}" ${opts.stroke ? `stroke="${opts.stroke}" stroke-width="${sw}" stroke-linejoin="round"` : ''}/>` +
    `<path d="${finPath(f)}" fill="${opts.fins ?? 'none'}" ${opts.stroke ? `stroke="${opts.stroke}" stroke-width="${sw * 0.8}" stroke-linejoin="round"` : ''}/>` +
    (opts.canopy ? `<ellipse cx="${c.cx.toFixed(2)}" cy="${c.cy.toFixed(2)}" rx="${c.rx.toFixed(2)}" ry="${c.ry.toFixed(2)}" fill="${opts.canopy}"/>` : '') +
    `</svg>`
  );
}
