/**
 * Smooth keyframe interpolation for fuselage section parameters (monotone cubic Hermite,
 * Fritsch–Carlson) — smooth silhouettes without overshoot between keyframes.
 */

export type Curve = (x: number) => number;

export function monotoneCubic(xs: number[], ys: number[]): Curve {
  const n = xs.length;
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1]
    );
  };
}

/** Build one curve per column of a keyframe table: rows [x, p0, p1, ...]. */
export function tableCurves(rows: number[][]): Curve[] {
  const xs = rows.map((r) => r[0]);
  const out: Curve[] = [];
  for (let c = 1; c < rows[0].length; c++) out.push(monotoneCubic(xs, rows.map((r) => r[c])));
  return out;
}

/** Evenly spaced samples in [a, b] plus any extra breakpoints, sorted & deduplicated. */
export function samples(a: number, b: number, count: number, extra: number[] = []): number[] {
  const s = new Set<number>();
  for (let i = 0; i <= count; i++) s.add(+(a + ((b - a) * i) / count).toFixed(4));
  extra.forEach((e) => e >= a && e <= b && s.add(+e.toFixed(4)));
  return [...s].sort((x, y) => x - y);
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
