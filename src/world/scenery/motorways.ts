/**
 * Auckland's motorway network as road ribbons: SH1 over the Harbour Bridge, along the western edge
 * of the CBD into the Central Motorway Junction ("Spaghetti Junction") and south through Newmarket
 * to Manukau; SH16 west along the harbour (Waterview, the Te Atatū causeway, Westgate) and east down
 * Grafton Gully to the port; SH20 from Waterview over the Māngere Bridge; SH18 over the upper
 * harbour; SH1 up the North Shore to Albany. Hand-traced from memory at ~100–200 m accuracy.
 *
 * `RoadNetwork` smooths the polylines, answers "is this point on a road?" (so houses, trees and
 * towers keep off the carriageway) and builds one textured ribbon mesh (terrain-following, raised
 * onto causeways / bridge decks over water) plus lamp posts for the night lights.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { geoToWorld } from '../../core/auckland';
import { frameFromHeading, type GeometryBuilder } from './GeometryBuilder';
import type { HeightFn, LightList } from './builders';

interface MotorwayDef {
  name: string;
  /** Carriageway width (m, both directions). */
  width: number;
  /** [lat, lon] points; a negative lat marks a tunnel portal-to-portal stretch start with `tunnel`. */
  ll: [number, number][];
  /** Indices of points after which the road runs in a tunnel until the next point. */
  tunnels?: number[];
}

const MOTORWAYS: MotorwayDef[] = [
  {
    name: 'SH1 North Shore',
    width: 30,
    ll: [
      [-36.8262, 174.7481], [-36.8215, 174.7476], [-36.8160, 174.7462], [-36.8105, 174.7452], [-36.8045, 174.7468], [-36.7985, 174.7515],
      [-36.7935, 174.7545], [-36.7875, 174.7525], [-36.7800, 174.7478], [-36.7715, 174.7425], [-36.7630, 174.7380], [-36.7530, 174.7320],
      [-36.7430, 174.7255], [-36.7330, 174.7185], [-36.7220, 174.7110], [-36.7090, 174.7060], [-36.6950, 174.7040],
    ],
  },
  {
    name: 'SH1 CBD',
    width: 34,
    ll: [
      [-36.8372, 174.7447], [-36.8398, 174.7462], [-36.8425, 174.7488], [-36.8452, 174.7508], [-36.8482, 174.7524], [-36.8515, 174.7538],
      [-36.8545, 174.7555], [-36.8570, 174.7580], [-36.8590, 174.7608],
    ],
  },
  {
    name: 'SH1 Southern',
    width: 32,
    ll: [
      [-36.8590, 174.7608], [-36.8612, 174.7650], [-36.8640, 174.7700], [-36.8672, 174.7752], [-36.8712, 174.7790], [-36.8765, 174.7815],
      [-36.8830, 174.7862], [-36.8895, 174.7935], [-36.8955, 174.8015], [-36.9025, 174.8090], [-36.9110, 174.8170], [-36.9215, 174.8255],
      [-36.9320, 174.8310], [-36.9430, 174.8360], [-36.9555, 174.8420], [-36.9690, 174.8500], [-36.9830, 174.8605], [-36.9960, 174.8720],
      [-37.0100, 174.8860], [-37.0260, 174.8980],
    ],
  },
  {
    name: 'SH16 Northwestern',
    width: 30,
    ll: [
      [-36.8590, 174.7608], [-36.8605, 174.7560], [-36.8622, 174.7505], [-36.8638, 174.7440], [-36.8650, 174.7370], [-36.8662, 174.7290],
      [-36.8672, 174.7215], [-36.8685, 174.7140], [-36.8700, 174.7060], [-36.8712, 174.6985], [-36.8672, 174.6920], [-36.8620, 174.6860],
      [-36.8575, 174.6790], [-36.8538, 174.6715], [-36.8502, 174.6640], [-36.8468, 174.6560], [-36.8438, 174.6470], [-36.8412, 174.6380],
      [-36.8390, 174.6290], [-36.8360, 174.6200], [-36.8300, 174.6120], [-36.8220, 174.6065], [-36.8120, 174.6030], [-36.8010, 174.6000],
      [-36.7880, 174.5960], [-36.7750, 174.5920],
    ],
  },
  {
    name: 'SH16 Grafton Gully',
    width: 24,
    ll: [[-36.8590, 174.7608], [-36.8578, 174.7650], [-36.8560, 174.7690], [-36.8535, 174.7722], [-36.8505, 174.7748], [-36.8478, 174.7772], [-36.8462, 174.7805]],
  },
  {
    name: 'SH20 Southwestern',
    width: 28,
    ll: [
      [-36.8712, 174.6985], [-36.8760, 174.7000], [-36.8830, 174.7030], [-36.8900, 174.7070], [-36.8975, 174.7120], [-36.9045, 174.7180],
      [-36.9110, 174.7260], [-36.9160, 174.7360], [-36.9195, 174.7470], [-36.9220, 174.7580], [-36.9245, 174.7680], [-36.9290, 174.7780],
      [-36.9350, 174.7840], [-36.9420, 174.7880], [-36.9500, 174.7920], [-36.9590, 174.7980], [-36.9680, 174.8060], [-36.9770, 174.8160],
      [-36.9850, 174.8290], [-36.9920, 174.8440], [-36.9980, 174.8600], [-37.0060, 174.8750],
    ],
    tunnels: [0, 1, 2],
  },
  {
    name: 'SH18 Upper Harbour',
    width: 24,
    ll: [
      [-36.7430, 174.7255], [-36.7470, 174.7140], [-36.7530, 174.7020], [-36.7610, 174.6900], [-36.7690, 174.6780], [-36.7760, 174.6660],
      [-36.7830, 174.6550], [-36.7900, 174.6440], [-36.7960, 174.6320], [-36.8010, 174.6200], [-36.8050, 174.6080], [-36.8080, 174.6020],
    ],
  },
];

export interface RoadPath {
  name: string;
  width: number;
  /** Resampled points (world m), with per-point tunnel flag. */
  x: Float32Array;
  z: Float32Array;
  tunnel: Uint8Array;
}

const SAMPLE = 30;

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Smooth (Catmull-Rom) and resample a polyline every ~SAMPLE m. */
export function resamplePath(pts: { x: number; z: number }[], tunnels: number[] = []): { x: number[]; z: number[]; tunnel: number[] } {
  const xs: number[] = [];
  const zs: number[] = [];
  const tn: number[] = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    const len = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const steps = Math.max(1, Math.round(len / SAMPLE));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      xs.push(catmull(p0.x, p1.x, p2.x, p3.x, t));
      zs.push(catmull(p0.z, p1.z, p2.z, p3.z, t));
      tn.push(tunnels.includes(i) ? 1 : 0);
    }
  }
  xs.push(pts[n - 1].x);
  zs.push(pts[n - 1].z);
  tn.push(0);
  return { x: xs, z: zs, tunnel: tn };
}

export function aucklandRoadPaths(): RoadPath[] {
  return MOTORWAYS.map((m) => {
    const r = resamplePath(
      m.ll.map(([lat, lon]) => geoToWorld(lat, lon)),
      m.tunnels,
    );
    return { name: m.name, width: m.width, x: Float32Array.from(r.x), z: Float32Array.from(r.z), tunnel: Uint8Array.from(r.tunnel) };
  });
}

/** Spatially hashed road segments for "is this point on / next to a motorway?" queries. */
export class RoadNetwork {
  private readonly cell = 200;
  private readonly buckets = new Map<number, number[]>();
  /** Flat [ax, az, bx, bz, halfWidth] records. */
  private readonly segs: number[] = [];

  constructor(readonly paths: RoadPath[]) {
    for (const p of paths) {
      for (let i = 0; i + 1 < p.x.length; i++) {
        if (p.tunnel[i]) continue;
        const k = this.segs.length / 5;
        this.segs.push(p.x[i], p.z[i], p.x[i + 1], p.z[i + 1], p.width / 2);
        const r = p.width / 2 + 60;
        const i0 = Math.floor((Math.min(p.x[i], p.x[i + 1]) - r) / this.cell);
        const i1 = Math.floor((Math.max(p.x[i], p.x[i + 1]) + r) / this.cell);
        const j0 = Math.floor((Math.min(p.z[i], p.z[i + 1]) - r) / this.cell);
        const j1 = Math.floor((Math.max(p.z[i], p.z[i + 1]) + r) / this.cell);
        for (let j = j0; j <= j1; j++)
          for (let ii = i0; ii <= i1; ii++) {
            const key = (ii + 2048) * 4096 + (j + 2048);
            let b = this.buckets.get(key);
            if (!b) this.buckets.set(key, (b = []));
            b.push(k);
          }
      }
    }
  }

  /** Distance (m) from (x, z) to the nearest carriageway edge (negative on the road); ≤ 60 m range. */
  edgeDistance(x: number, z: number): number {
    const key = (Math.floor(x / this.cell) + 2048) * 4096 + (Math.floor(z / this.cell) + 2048);
    const b = this.buckets.get(key);
    if (!b) return Infinity;
    let best = Infinity;
    const s = this.segs;
    for (const k of b) {
      const o = k * 5;
      const ax = s[o];
      const az = s[o + 1];
      const dx = s[o + 2] - ax;
      const dz = s[o + 3] - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z) - s[o + 4];
      if (d < best) best = d;
    }
    return best;
  }

  near(x: number, z: number, margin: number): boolean {
    return this.edgeDistance(x, z) < margin;
  }

  /**
   * Ribbon geometry (position + uv: u across 0..1, v along in 40 m units) following the terrain,
   * raised onto causeways / bridges over water; bridge decks, piers and barriers go into `B`,
   * lamp posts into `lights`.
   */
  buildRibbons(height: HeightFn, B: GeometryBuilder, lights: LightList, lamps: boolean): BufferGeometry {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const deckCol = 0x8c8b86;
    for (const p of this.paths) {
      const n = p.x.length;
      // Water under the centre line → deck height profile (smoothed ramps).
      const wet = new Float32Array(n);
      for (let i = 0; i < n; i++) wet[i] = height(p.x[i], p.z[i]) < 0.6 ? 1 : 0;
      const deck = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let w = 0;
        for (let k = -4; k <= 4; k++) {
          const j = i + k;
          if (j < 0 || j >= n || !wet[j]) continue;
          w = Math.max(w, 1 - Math.abs(k) / 5);
        }
        deck[i] = w;
      }
      let s = 0;
      let run = -1;
      for (let i = 0; i < n; i++) {
        const i0 = Math.max(0, i - 1);
        const i1 = Math.min(n - 1, i + 1);
        let tx = p.x[i1] - p.x[i0];
        let tz = p.z[i1] - p.z[i0];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        const nx = -tz;
        const nz = tx;
        if (i > 0) s += Math.hypot(p.x[i] - p.x[i - 1], p.z[i] - p.z[i - 1]);
        if (p.tunnel[i] && (i === 0 || p.tunnel[i - 1])) {
          run = -1;
          continue;
        }
        const hw = p.width / 2;
        const deckY = 7 + 5 * Math.min(1, deck[i] * 1.2);
        const base = pos.length / 3;
        for (let k = 0; k < 3; k++) {
          const off = (k - 1) * hw;
          const x = p.x[i] + nx * off;
          const z = p.z[i] + nz * off;
          const g = height(x, z) + 0.45;
          const y = deck[i] > 0 ? Math.max(g, g * (1 - deck[i]) + deckY * deck[i]) : g;
          pos.push(x, y, z);
          uv.push(k / 2, s / 40);
        }
        if (run >= 0) {
          for (let k = 0; k < 2; k++) {
            const a = run + k;
            const b = base + k;
            idx.push(a, b, a + 1, a + 1, b, b + 1);
          }
        }
        run = base;
        // Bridge / causeway: side barriers and piers every ~60 m over the water
        if (deck[i] > 0.5 && i + 1 < n) {
          const x2 = p.x[i + 1];
          const z2 = p.z[i + 1];
          const y = deckY;
          for (const side of [-1, 1]) {
            const ox = nx * hw * side;
            const oz = nz * hw * side;
            B.beam(frameFromHeading(0, 0, 0, 0), p.x[i] + ox, y - 1.8, p.z[i] + oz, x2 + ox, y - 1.8, z2 + oz, 1.6, deckCol);
          }
          if (i % 2 === 0 && wet[i]) {
            const f = frameFromHeading(p.x[i], Math.min(0, height(p.x[i], p.z[i])) - 2, p.z[i], Math.atan2(tx, -tz));
            B.box(f, 0, 0, 0, p.width * 0.8, y - 2 - (Math.min(0, height(p.x[i], p.z[i])) - 2), 3, 0xa8a59c, 0xa8a59c);
          }
        }
        // Lamp posts (alternating sides, every 60 m)
        if (lamps && i % 2 === 0) {
          const side = (i >> 1) % 2 === 0 ? 1 : -1;
          const x = p.x[i] + nx * (hw + 1) * side;
          const z = p.z[i] + nz * (hw + 1) * side;
          lights.add(x, height(x, z) * (1 - deck[i]) + deckY * deck[i] + 11, z, 0xffd9a8, 4.5);
        }
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(pos.length / 3 > 65535 ? new BufferAttribute(new Uint32Array(idx), 1) : new BufferAttribute(new Uint16Array(idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}
