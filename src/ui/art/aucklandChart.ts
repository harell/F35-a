/**
 * F35-A UI art — draws the stylised Auckland chart (coastline, harbours, islands, relief, urban areas)
 * onto a 2D canvas. Used by the animated menu background and the briefing intel map.
 *
 * The geometry is read (never modified) from the WORLD module's hand-traced map data. It is accessed
 * defensively so a renamed export there can never break the menus — the chart simply falls back
 * to a plain grid.
 */
import * as aklMap from '../../world/terrain/theaters/aucklandMap';

interface ChartData {
  water: { label: number; pts: number[] }[];
  islands: ({ pts: number[] } | { ellipse: [number, number, number, number, number] })[];
  lakes: [number, number, number][];
  relief: { e: [number, number, number, number, number]; h: number; rough: number }[];
  urban: number[][];
}

let data: ChartData | null | undefined;

export function chartData(): ChartData | null {
  if (data !== undefined) return data;
  const m = aklMap as unknown as {
    AKL_WATER?: ChartData['water'];
    AKL_ISLANDS?: ChartData['islands'];
    AKL_LAKES?: ChartData['lakes'];
    AKL_RELIEF?: ChartData['relief'];
    AKL_URBAN?: ChartData['urban'];
  };
  data = Array.isArray(m.AKL_WATER)
    ? { water: m.AKL_WATER, islands: m.AKL_ISLANDS ?? [], lakes: m.AKL_LAKES ?? [], relief: m.AKL_RELIEF ?? [], urban: m.AKL_URBAN ?? [] }
    : null;
  return data;
}

/** Maps world km (x east, z south) to canvas px. */
export interface ChartView {
  /** Canvas px per km. */
  scale: number;
  /** World km at the canvas origin (top-left). */
  x0: number;
  z0: number;
}

export interface ChartStyle {
  land: string;
  water: string;
  coast: string;
  coastWidth: number;
  relief?: string;
  urban?: string;
}

function polyPath(g: CanvasRenderingContext2D, pts: number[], v: ChartView): void {
  g.moveTo((pts[0] - v.x0) * v.scale, (pts[1] - v.z0) * v.scale);
  for (let i = 2; i < pts.length; i += 2) g.lineTo((pts[i] - v.x0) * v.scale, (pts[i + 1] - v.z0) * v.scale);
  g.closePath();
}

function islandPath(g: CanvasRenderingContext2D, isl: ChartData['islands'][number], v: ChartView): void {
  if ('pts' in isl) polyPath(g, isl.pts, v);
  else {
    const [cx, cz, rx, rz, rot] = isl.ellipse;
    g.moveTo((cx - v.x0) * v.scale + rx * v.scale * Math.cos(rot), (cz - v.z0) * v.scale + rx * v.scale * Math.sin(rot));
    g.ellipse((cx - v.x0) * v.scale, (cz - v.z0) * v.scale, rx * v.scale, rz * v.scale, rot, 0, Math.PI * 2);
  }
}

/**
 * Draw the chart into the rectangle [0,0,w,h]. Returns false if no map data is available
 * (caller draws a generic background instead).
 *
 * Coastline trick: stroke every outline at 2× width first, then fill water over it (and land for
 * islands) — shared water/water edges disappear and each coast keeps exactly one crisp line.
 */
export function drawAucklandChart(g: CanvasRenderingContext2D, w: number, h: number, v: ChartView, st: ChartStyle): boolean {
  const d = chartData();
  if (!d) return false;
  g.save();
  g.fillStyle = st.land;
  g.fillRect(0, 0, w, h);

  // relief (hills) and urban footprint: drawn on land before the water covers the coast
  if (st.relief) {
    for (const r of d.relief) {
      const [cx, cz, rx, rz, rot] = r.e;
      const px = (cx - v.x0) * v.scale;
      const pz = (cz - v.z0) * v.scale;
      const k = Math.min(1, r.h / 450);
      const grad = g.createRadialGradient(px, pz, 0, px, pz, Math.max(rx, rz) * v.scale);
      grad.addColorStop(0, st.relief);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = 0.25 + 0.75 * k;
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(px, pz, rx * v.scale, rz * v.scale, rot, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }
  if (st.urban) {
    g.fillStyle = st.urban;
    g.beginPath();
    for (const u of d.urban) polyPath(g, u, v);
    g.fill();
  }

  g.lineJoin = 'round';
  g.strokeStyle = st.coast;
  g.lineWidth = st.coastWidth * 2;
  g.beginPath();
  for (const wtr of d.water) polyPath(g, wtr.pts, v);
  g.stroke();
  g.fillStyle = st.water;
  g.fill();

  g.beginPath();
  for (const isl of d.islands) islandPath(g, isl, v);
  g.stroke();
  g.fillStyle = st.land;
  g.fill();

  g.beginPath();
  for (const [x, z, r] of d.lakes) {
    g.moveTo((x - v.x0 + r) * v.scale, (z - v.z0) * v.scale);
    g.arc((x - v.x0) * v.scale, (z - v.z0) * v.scale, r * v.scale, 0, Math.PI * 2);
  }
  g.stroke();
  g.fillStyle = st.water;
  g.fill();
  g.restore();
  return true;
}

/** Named places for chart labels (world km). */
export const CHART_LABELS: { text: string; x: number; z: number; kind: 'sea' | 'land' | 'island' }[] = [
  { text: 'HAURAKI GULF', x: 22, z: -18, kind: 'sea' },
  { text: 'TASMAN SEA', x: -36, z: 4, kind: 'sea' },
  { text: 'WAITEMATĀ', x: -6.5, z: -1.2, kind: 'sea' },
  { text: 'MANUKAU', x: -9, z: 15, kind: 'sea' },
  { text: 'AUCKLAND', x: 1.5, z: 2.4, kind: 'land' },
  { text: 'RANGITOTO', x: 8.7, z: -10.4, kind: 'island' },
  { text: 'WAIHEKE', x: 28, z: -9.8, kind: 'island' },
  { text: 'WHENUAPAI', x: -11.6, z: -5.6, kind: 'land' },
  { text: 'WAITĀKERE RANGES', x: -20, z: 6, kind: 'land' },
];
