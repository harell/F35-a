/**
 * F35-A UI — briefing intel map (Canvas 2D): Auckland chart (or a generic grid for other theatres),
 * SAM threat rings, enemy air groups, targets, friendlies, airbases, the player start with heading,
 * the waypoint route, a north arrow and a scale bar.
 *
 * `intelBounds` / `fitIntelView` are pure (tested in tests/ui-intel.test.ts).
 */
import type { IntelMarker, MissionDef } from '../../core/contracts';
import { drawAucklandChart } from '../art/aucklandChart';
import { niceScaleLength } from '../format';

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface IntelView {
  /** px per metre. */
  scale: number;
  /** World metres at canvas (0,0). */
  x0: number;
  z0: number;
}

interface RoutePoint {
  x: number;
  z: number;
  label: string;
  kind: string;
}

export function routeOf(m: MissionDef): RoutePoint[] {
  const wps = (m.script as unknown as { waypoints?: { x: number; z: number; label: string; kind: string }[] })?.waypoints ?? [];
  return wps.filter((w) => Number.isFinite(w.x) && Number.isFinite(w.z)).map((w) => ({ x: w.x, z: w.z, label: w.label, kind: w.kind }));
}

/** Bounding box (m) of everything worth showing: start, waypoints, markers incl. SAM rings. */
export function intelBounds(m: MissionDef, minSpan = 24_000): Bounds {
  const b: Bounds = { minX: m.player.x, maxX: m.player.x, minZ: m.player.z, maxZ: m.player.z };
  const add = (x: number, z: number, r = 0) => {
    b.minX = Math.min(b.minX, x - r);
    b.maxX = Math.max(b.maxX, x + r);
    b.minZ = Math.min(b.minZ, z - r);
    b.maxZ = Math.max(b.maxZ, z + r);
  };
  for (const w of routeOf(m)) add(w.x, w.z, 1500);
  for (const i of m.intel) add(i.x, i.z, i.kind === 'sam' ? Math.min(i.radius ?? 0, 30_000) : 2500);
  // enforce a minimum span, centred
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const sx = Math.max(minSpan, b.maxX - b.minX);
  const sz = Math.max(minSpan, b.maxZ - b.minZ);
  return { minX: cx - sx / 2, maxX: cx + sx / 2, minZ: cz - sz / 2, maxZ: cz + sz / 2 };
}

/** Fit bounds into a w×h canvas with padding (fraction of each side), keeping aspect ratio. */
export function fitIntelView(b: Bounds, w: number, h: number, pad = 0.08): IntelView {
  const spanX = (b.maxX - b.minX) * (1 + pad * 2);
  const spanZ = (b.maxZ - b.minZ) * (1 + pad * 2);
  const scale = Math.min(w / spanX, h / spanZ);
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  return { scale, x0: cx - w / 2 / scale, z0: cz - h / 2 / scale };
}

const COL = {
  sam: '#ff5a4a',
  air: '#ff7a5a',
  target: '#ffb13d',
  friendly: '#5fe3ff',
  airbase: '#9fe8c8',
  route: '#5fe3ff',
  player: '#8dffcf',
};

function diamond(g: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  g.beginPath();
  g.moveTo(x, y - s);
  g.lineTo(x + s, y);
  g.lineTo(x, y + s);
  g.lineTo(x - s, y);
  g.closePath();
}

function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, size: number, align: CanvasTextAlign = 'left'): void {
  g.font = `700 ${size}px ui-monospace, 'SF Mono', Menlo, Consolas, monospace`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(2,6,10,0.9)';
  g.strokeText(text, x, y);
  g.fillStyle = color;
  g.fillText(text, x, y);
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Greedy label decluttering: each label tries a few anchor offsets (right, left, below, above) and
 * takes the first that stays on the canvas and doesn't hit an already placed label or icon.
 * Labels that can't be placed are dropped unless `force` (then clamped onto the canvas).
 */
class LabelPlacer {
  private readonly boxes: Box[] = [];

  constructor(
    private readonly g: CanvasRenderingContext2D,
    private readonly w: number,
    private readonly h: number,
    private readonly size: number,
  ) {}

  /** Reserve an area (marker icons, north arrow, legend…). */
  block(x: number, y: number, w: number, h: number): void {
    this.boxes.push({ x, y, w, h });
  }

  private hits(b: Box): boolean {
    if (b.x < 2 || b.y < 2 || b.x + b.w > this.w - 2 || b.y + b.h > this.h - 2) return true;
    for (const o of this.boxes) if (b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h) return true;
    return false;
  }

  place(text: string, x: number, y: number, r: number, color: string, force = false): void {
    const g = this.g;
    g.font = `700 ${this.size}px ui-monospace, 'SF Mono', Menlo, Consolas, monospace`;
    const tw = g.measureText(text).width + 4;
    const th = this.size + 4;
    const cands: [number, number][] = [
      [x + r + 3, y - th / 2],
      [x - r - 3 - tw, y - th / 2],
      [x - tw / 2, y + r + 2],
      [x - tw / 2, y - r - 2 - th],
      [x + r + 3, y + r * 0.6],
      [x - r - 3 - tw, y - r * 0.6 - th],
    ];
    let pick: Box | null = null;
    for (const [cx, cy] of cands) {
      const b = { x: cx, y: cy, w: tw, h: th };
      if (!this.hits(b)) {
        pick = b;
        break;
      }
    }
    if (!pick) {
      if (!force) return;
      const [cx, cy] = cands[0];
      pick = { x: Math.max(2, Math.min(this.w - tw - 2, cx)), y: Math.max(2, Math.min(this.h - th - 2, cy)), w: tw, h: th };
    }
    this.boxes.push(pick);
    label(g, text, pick.x + 2, pick.y + th / 2, color, this.size, 'left');
  }
}

/**
 * Render the intel map for a mission into a canvas sized w×h CSS px at the given DPR.
 */
export function drawIntelMap(canvas: HTMLCanvasElement, m: MissionDef, w: number, h: number, dpr: number): void {
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const v = fitIntelView(intelBounds(m), w, h);
  const X = (x: number) => (x - v.x0) * v.scale;
  const Y = (z: number) => (z - v.z0) * v.scale;
  const u = Math.max(0.85, Math.min(1.4, Math.min(w, h) / 300));

  // ── base chart ──
  let charted = false;
  if (m.theater === 'auckland') {
    charted = drawAucklandChart(g, w, h, { scale: v.scale * 1000, x0: v.x0 / 1000, z0: v.z0 / 1000 }, {
      land: '#10222b',
      water: '#050d14',
      coast: 'rgba(120,220,245,0.7)',
      coastWidth: 1,
      relief: 'rgba(150,220,200,0.12)',
      urban: 'rgba(255,220,150,0.07)',
    });
  }
  if (!charted) {
    const grd = g.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, '#0c1a20');
    grd.addColorStop(1, '#081217');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    // procedural "contours" so non-Auckland theatres don't look empty
    g.strokeStyle = 'rgba(120,200,220,0.07)';
    g.lineWidth = 1;
    const seed = m.seed || 1;
    for (let k = 0; k < 9; k++) {
      g.beginPath();
      for (let i = 0; i <= 64; i++) {
        const t = (i / 64) * Math.PI * 2;
        const r = (0.12 + k * 0.05) * Math.min(w, h) * (1 + 0.18 * Math.sin(t * 3 + seed * 0.7 + k) + 0.1 * Math.cos(t * 5 + seed));
        const px = w * (0.5 + 0.15 * Math.sin(seed)) + Math.cos(t) * r * 1.3;
        const py = h * 0.5 + Math.sin(t) * r;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
    }
  }

  // ── grid (5 km) ──
  g.strokeStyle = 'rgba(95,227,255,0.08)';
  g.lineWidth = 1;
  g.beginPath();
  const step = 5000;
  for (let x = Math.ceil(v.x0 / step) * step; X(x) < w; x += step) {
    const px = Math.round(X(x)) + 0.5;
    g.moveTo(px, 0);
    g.lineTo(px, h);
  }
  for (let z = Math.ceil(v.z0 / step) * step; Y(z) < h; z += step) {
    const pz = Math.round(Y(z)) + 0.5;
    g.moveTo(0, pz);
    g.lineTo(w, pz);
  }
  g.stroke();

  // ── SAM threat rings (drawn first, under everything) ──
  const sams = m.intel.filter((i) => i.kind === 'sam');
  for (const s of sams) {
    const r = (s.radius ?? 5000) * v.scale;
    const x = X(s.x);
    const y = Y(s.z);
    const grad = g.createRadialGradient(x, y, r * 0.2, x, y, r);
    grad.addColorStop(0, 'rgba(255,90,74,0.02)');
    grad.addColorStop(1, 'rgba(255,90,74,0.13)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.setLineDash([6 * u, 5 * u]);
    g.strokeStyle = 'rgba(255,90,74,0.75)';
    g.lineWidth = 1.4;
    g.stroke();
    g.setLineDash([]);
  }

  const placer = new LabelPlacer(g, w, h, Math.round(9 * u));
  placer.block(w - 44 * u, 0, 44 * u, 50 * u); // north arrow
  placer.block(0, h - 26 * u, Math.min(w * 0.6, 200 * u), 26 * u); // scale bar
  placer.block(0, 0, Math.min(w * 0.7, 190 * u), 44 * u); // legend chips
  const later: (() => void)[] = [];

  // ── route ──
  const route = routeOf(m);
  if (route.length) {
    g.strokeStyle = 'rgba(95,227,255,0.85)';
    g.lineWidth = 1.6 * u;
    g.setLineDash([8 * u, 6 * u]);
    g.beginPath();
    g.moveTo(X(m.player.x), Y(m.player.z));
    for (const p of route) g.lineTo(X(p.x), Y(p.z));
    g.stroke();
    g.setLineDash([]);
    route.forEach((p, i) => {
      const x = X(p.x);
      const y = Y(p.z);
      const r = 8 * u;
      g.fillStyle = 'rgba(4,14,20,0.9)';
      g.strokeStyle = p.kind === 'target' ? COL.target : COL.route;
      g.lineWidth = 1.6;
      g.beginPath();
      if (p.kind === 'rtb') {
        g.rect(x - r, y - r, r * 2, r * 2);
      } else g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      label(g, String(i + 1), x, y + 0.5, p.kind === 'target' ? COL.target : COL.route, Math.round(9 * u), 'center');
      placer.block(x - r, y - r, r * 2, r * 2);
      later.push(() => placer.place(p.label.toUpperCase(), x, y, r, 'rgba(210,245,255,0.95)', true));
    });
  }

  // ── markers: icons first, then decluttered labels (co-located markers share one label) ──
  const drawIcon = (i: IntelMarker, x: number, y: number, s: number) => {
    g.lineWidth = 1.8;
    switch (i.kind) {
      case 'sam':
        g.strokeStyle = COL.sam;
        g.fillStyle = 'rgba(255,90,74,0.25)';
        g.beginPath();
        g.moveTo(x, y - s * 1.1);
        g.lineTo(x + s, y + s * 0.8);
        g.lineTo(x - s, y + s * 0.8);
        g.closePath();
        g.fill();
        g.stroke();
        break;
      case 'air':
        g.strokeStyle = COL.air;
        g.fillStyle = 'rgba(255,122,90,0.28)';
        diamond(g, x, y, s);
        g.fill();
        g.stroke();
        break;
      case 'target':
        g.strokeStyle = COL.target;
        g.beginPath();
        g.rect(x - s * 0.8, y - s * 0.8, s * 1.6, s * 1.6);
        g.moveTo(x - s * 1.4, y);
        g.lineTo(x + s * 1.4, y);
        g.moveTo(x, y - s * 1.4);
        g.lineTo(x, y + s * 1.4);
        g.stroke();
        break;
      case 'friendly':
        g.strokeStyle = COL.friendly;
        g.fillStyle = 'rgba(95,227,255,0.25)';
        g.beginPath();
        g.arc(x, y, s * 0.85, Math.PI, 0);
        g.lineTo(x + s * 0.85, y + s * 0.5);
        g.lineTo(x - s * 0.85, y + s * 0.5);
        g.closePath();
        g.fill();
        g.stroke();
        break;
      case 'airbase':
        g.strokeStyle = COL.airbase;
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(x - s * 1.2, y + s * 0.7);
        g.lineTo(x + s * 1.2, y - s * 0.7);
        g.stroke();
        g.lineWidth = 1.4;
        g.beginPath();
        g.arc(x, y, s * 1.5, 0, Math.PI * 2);
        g.stroke();
        break;
    }
  };
  const s0 = 7 * u;
  const order: IntelMarker['kind'][] = ['airbase', 'friendly', 'target', 'air', 'sam'];
  const markers = [...m.intel].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const groups: { kind: IntelMarker['kind']; x: number; y: number; names: string[] }[] = [];
  for (const i of markers) {
    const x = X(i.x);
    const y = Y(i.z);
    drawIcon(i, x, y, s0);
    placer.block(x - s0, y - s0, s0 * 2, s0 * 2);
    const near = groups.find((gr) => gr.kind === i.kind && Math.hypot(gr.x - x, gr.y - y) < 16 * u);
    if (near) {
      if (!near.names.includes(i.label)) near.names.push(i.label);
      else near.names.push('');
    } else groups.push({ kind: i.kind, x, y, names: [i.label] });
  }
  // labels: SAMs & air threats first (most important), then targets, friendlies, bases
  const prio: IntelMarker['kind'][] = ['sam', 'air', 'target', 'friendly', 'airbase'];
  groups.sort((a, b) => prio.indexOf(a.kind) - prio.indexOf(b.kind));
  const labelFns = groups.map((gr) => () => {
    const named = gr.names.filter(Boolean);
    const extra = gr.names.length - Math.min(2, named.length);
    const text = named.slice(0, 2).join(' · ') + (extra > 0 ? ` +${extra}` : '');
    placer.place(text, gr.x, gr.y, gr.kind === 'airbase' ? s0 * 1.6 : s0 * 1.2, COL[gr.kind]);
  });

  // ── player start (triangle along heading) ──
  {
    const x = X(m.player.x);
    const y = Y(m.player.z);
    const hd = (m.player.heading * Math.PI) / 180;
    const fx = Math.sin(hd);
    const fy = -Math.cos(hd);
    const s = 11 * u;
    g.save();
    g.shadowColor = 'rgba(141,255,207,0.8)';
    g.shadowBlur = 10;
    g.fillStyle = COL.player;
    g.beginPath();
    g.moveTo(x + fx * s, y + fy * s);
    g.lineTo(x - fx * s * 0.6 - fy * s * 0.6, y - fy * s * 0.6 + fx * s * 0.6);
    g.lineTo(x - fx * s * 0.25, y - fy * s * 0.25);
    g.lineTo(x - fx * s * 0.6 + fy * s * 0.6, y - fy * s * 0.6 - fx * s * 0.6);
    g.closePath();
    g.fill();
    g.restore();
    placer.block(x - s, y - s, s * 2, s * 2);
    placer.place('START', x, y, s, COL.player, true);
  }
  for (const f of later) f();
  for (const f of labelFns) f();

  // ── north arrow ──
  {
    const x = w - 22 * u;
    const y = 26 * u;
    g.fillStyle = 'rgba(4,12,18,0.75)';
    g.beginPath();
    g.arc(x, y, 15 * u, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(95,227,255,0.5)';
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = '#e8fbff';
    g.beginPath();
    g.moveTo(x, y - 10 * u);
    g.lineTo(x + 5 * u, y + 5 * u);
    g.lineTo(x, y + 2 * u);
    g.lineTo(x - 5 * u, y + 5 * u);
    g.closePath();
    g.fill();
    label(g, 'N', x, y - 19 * u - 2, '#e8fbff', Math.round(9 * u), 'center');
  }

  // ── scale bar ──
  {
    const len = niceScaleLength(1 / v.scale, Math.min(120, w * 0.25));
    const px = len * v.scale;
    const x = 12 * u;
    const y = h - 14 * u;
    g.strokeStyle = '#e8fbff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x, y - 5);
    g.lineTo(x, y);
    g.lineTo(x + px, y);
    g.lineTo(x + px, y - 5);
    g.stroke();
    const nm = len / 1852;
    label(g, `${len >= 1000 ? `${len / 1000} km` : `${len} m`} · ${nm.toFixed(nm < 10 ? 1 : 0)} nm`, x + px + 6, y - 2, '#e8fbff', Math.round(9 * u));
  }
}
