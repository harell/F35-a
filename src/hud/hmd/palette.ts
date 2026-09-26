/**
 * HMD colours. The symbology colour follows settings.hudColor; warnings/threats use fixed red/amber and
 * friendlies blue so they read instantly. Every colour string is precomputed (no per-frame string
 * building); `alpha(c, a)` variants come from a small cache.
 */
import type { Settings } from '../../core/types';

export interface Palette {
  id: Settings['hudColor'];
  /** Main symbology colour. */
  main: string;
  /** Dimmed symbology (secondary marks, stale tracks). */
  dim: string;
  /** Highlight (locked target, SHOOT). */
  bright: string;
  /** Dark outline / glow drawn under every stroke and glyph. */
  outline: string;
  /** Translucent dark fill behind text boxes. */
  back: string;
  /** Caution (amber). */
  warn: string;
  /** Warning (red). */
  danger: string;
  /** Friendly (blue). */
  friend: string;
  /** Neutral white. */
  white: string;
  /** Positive feedback ("TARGET DESTROYED"). */
  good: string;
  /** IR-guided threat colour (orange). */
  ir: string;
  /** rgb components of `main` for gradients / alpha variants. */
  rgb: [number, number, number];
}

const MAIN: Record<Settings['hudColor'], [number, number, number]> = {
  green: [70, 255, 120],
  amber: [255, 196, 64],
  cyan: [80, 232, 255],
};

const cache = new Map<string, Palette>();

function rgba(c: [number, number, number], a: number): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

export function paletteFor(color: Settings['hudColor']): Palette {
  let p = cache.get(color);
  if (p) return p;
  const m = MAIN[color] ?? MAIN.green;
  const bright: [number, number, number] = [Math.min(255, m[0] + 90), Math.min(255, m[1] + 30), Math.min(255, m[2] + 90)];
  p = {
    id: color,
    main: rgba(m, 1),
    dim: rgba(m, 0.55),
    bright: rgba(bright, 1),
    outline: 'rgba(0,8,4,0.62)',
    back: 'rgba(0,10,6,0.42)',
    warn: color === 'amber' ? '#ff8c2a' : '#ffc02e',
    danger: '#ff3b30',
    friend: '#58b4ff',
    white: '#f2fff6',
    good: color === 'green' ? '#b4ffc8' : '#7dff9c',
    ir: '#ff8a1c',
    rgb: m,
  };
  cache.set(color, p);
  return p;
}

/** color → 21 quantised alpha variants (index = round(a * 20)). No per-call string building. */
const alphaCache = new Map<string, string[]>();

/** `color` (#rrggbb or rgba(...)) with a quantised alpha (cached string). */
export function withAlpha(color: string, a: number): string {
  const q = Math.max(0, Math.min(20, Math.round(a * 20)));
  let arr = alphaCache.get(color);
  if (!arr) {
    let r = 255;
    let g = 255;
    let b = 255;
    if (color.startsWith('#') && color.length === 7) {
      r = parseInt(color.slice(1, 3), 16);
      g = parseInt(color.slice(3, 5), 16);
      b = parseInt(color.slice(5, 7), 16);
    } else {
      const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        r = +m[1];
        g = +m[2];
        b = +m[3];
      }
    }
    arr = [];
    for (let i = 0; i <= 20; i++) arr.push(`rgba(${r},${g},${b},${i / 20})`);
    alphaCache.set(color, arr);
  }
  return arr[q];
}
