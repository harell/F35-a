/**
 * Procedural liveries painted in model space onto the planar-by-facing atlas (see geom/atlas.ts):
 *  - F-35A: low-vis "Have Glass" grey RAM with panel lines, sawtooth doors, tile/RAM edge tones, a
 *    roughness atlas (sheen variation, matte edge tapes), heat/soot/edge-wear weathering,
 *    RNZAF low-visibility kiwi roundels, 'NZ' tail code and NZ serial (No. 75 Squadron style).
 *  - Russian types: grey-blue Flanker camouflage, two-tone MiG-29 greys, dark Su-57 splinter,
 *    light bombers; red stars and bort numbers.
 */
import { MeshStandardMaterial } from 'three';
import { AtlasPainter, createCanvas, rng, type AtlasBounds, type Ctx2D } from '../geom/atlas';
import { canvasTexture, getEnvCube, modelQuality, registerMaterial } from '../materials';

const poly = AtlasPainter.poly;
const line = AtlasPainter.line;

/** Optional single-channel roughness atlas painted with the same AtlasPainter as the colour map. */
interface RoughSpec {
  size: number;
  paint: (p: AtlasPainter) => void;
}

function makeSkin(
  key: string,
  bounds: AtlasBounds,
  size: number,
  paint: (p: AtlasPainter) => void,
  mat: { roughness: number; metalness: number; env: number; fallback: number; vertexColors?: boolean },
  rough?: RoughSpec,
): void {
  registerMaterial(key, () => {
    const c = createCanvas(size, size);
    let map = null;
    if (c) {
      const ctx = c.getContext('2d') as Ctx2D;
      paint(new AtlasPainter(ctx, bounds));
      map = canvasTexture(c, true, false);
    }
    // roughness atlas: linear data (three.js samples its green channel and multiplies by `roughness`)
    let roughnessMap = null;
    const rc = rough ? createCanvas(rough.size, rough.size) : null;
    if (rough && rc) {
      rough.paint(new AtlasPainter(rc.getContext('2d') as Ctx2D, bounds));
      roughnessMap = canvasTexture(rc, false, false);
    }
    const m = new MeshStandardMaterial({
      color: map ? 0xffffff : mat.fallback,
      map,
      // the map holds absolute roughness; without a canvas (node) fall back to the scalar
      roughness: roughnessMap ? 1 : mat.roughness,
      roughnessMap,
      metalness: mat.metalness,
      envMapIntensity: mat.env,
      envMap: getEnvCube(),
      // baked AO lives in the vertex colours (white where unoccluded)
      vertexColors: mat.vertexColors ?? false,
    });
    return m;
  });
}

/* ───────────────────────── F-35A ───────────────────────── */

/**
 * Have Glass grey, calibrated in game lighting (ACES, sky env map) against USAF photos: a dark,
 * near-monochrome grey with a hint of warmth so the blue sky reflection doesn't turn it blue-grey.
 */
export const F35_PAINT = {
  base: '#4e4e4d',
  fallback: 0x4e4e4d,
  /** Mean roughness of the RAM coating (the scalar used when no canvas exists). */
  roughness: 0.55,
  metalness: 0.1,
  env: 0.35,
} as const;

/** Roughness atlas edge (px): one extra ≤1024² texture, half the colour map at high quality. */
export function f35RoughSize(textureSize: number): number {
  return Math.min(1024, Math.max(256, textureSize / 2));
}

export function registerF35Materials(b: AtlasBounds): void {
  makeSkin(
    'f35.skin',
    b,
    Math.min(2048, modelQuality.textureSize),
    paintF35,
    { roughness: F35_PAINT.roughness, metalness: F35_PAINT.metalness, env: F35_PAINT.env, fallback: F35_PAINT.fallback, vertexColors: true },
    { size: f35RoughSize(modelQuality.textureSize), paint: paintF35Roughness },
  );
}

/* shared F-35A layout (model metres; `s` = metres aft of the nose tip) */
const F35_Z0 = -8.3;
const S = (s: number) => F35_Z0 + s;
/** Wing leading/trailing edge z at half-span x. */
const wing = (x: number) => {
  const t = (x - 1.2) / 4.15;
  return { le: -1.1 + 2.84 * t, te: 4.3 - 0.96 * t };
};
const WING_ROOT = 1.2;
const WING_TIP = 5.35;
/** Fuselage frame stations (planform / side). */
const FRAMES_TOP = [1.6, 2.8, 6.9, 8.2, 9.7, 11.1, 12.4, 13.5];
const FRAMES_SIDE = [1.55, 2.8, 4.1, 6.9, 8.2, 9.7, 11.1, 12.4, 13.5];
/** Chine in planform and in side view. */
const CHINE_TOP: [number, number][] = [[0.3, S(1)], [0.74, S(3.6)], [1.16, S(5.4)], [1.48, S(7.4)]];
const CHINE_SIDE: [number, number][] = [[S(0), -0.02], [S(3), 0.03], [S(7.4), 0.07], [S(14), 0.05]];
/** Leading edges of the stabilator (planform) and the canted fin (side view). */
const STAB_LE: [number, number][] = [[1.0, 4.55], [3.35, 6.1]];
const FIN_LE: [number, number][] = [[2.95, 0.35], [4.75, 2.4]];
/** Aft heat zone: from the engine bay frames back to the nozzle (nozzle itself is 'metal', s ≈ 13.6). */
const HEAT_S0 = 11.1;
const HEAT_S1 = 15.8;
const NOZZLE_S = 13.6;

function wingLE(x0: number, x1: number): [number, number][] {
  return [[x0, wing(x0).le], [x1, wing(x1).le]];
}

/** Grey level for the roughness canvas (roughness 0..1 → rgb). */
function rv(v: number, a = 1): string {
  const g = Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgba(${g},${g},${g},${a})`;
}

function paintF35(p: AtlasPainter): void {
  const LINE = 'rgba(24,26,28,0.5)';
  const LINE_SOFT = 'rgba(24,26,28,0.28)';
  // panel tone patches: very low contrast (most panel-to-panel difference is in the sheen, see roughness)
  const LIGHT = 'rgba(255,255,255,0.03)';
  const DARKT = 'rgba(0,0,0,0.04)';
  // edge-treatment tones: a barely lighter grey, never a white stripe
  const EDGE = 'rgba(200,200,200,0.035)';
  p.fillAll(F35_PAINT.base);
  p.mottle(11, 220, 0.035, 0.01, 0.05);
  p.grain(12, 0.05, 0.03);

  for (const region of ['top', 'bottom'] as const) {
    p.with(region, (ctx) => {
      // RAM "tile" tone patches (subtle checkerboard of slightly different greys)
      const r = rng(region === 'top' ? 3 : 4);
      for (let i = 0; i < 26; i++) {
        const x = r() * 4.5;
        const z = -6 + r() * 12;
        const w = 0.3 + r() * 0.9;
        const h = 0.4 + r() * 1.2;
        ctx.fillStyle = r() > 0.5 ? LIGHT : DARKT;
        ctx.fillRect(x, z, w, h);
      }
      // wing leading edge treatment + hinge lines
      poly(ctx, [
        [WING_ROOT, wing(WING_ROOT).le],
        [WING_TIP, wing(WING_TIP).le],
        [WING_TIP, wing(WING_TIP).le + 0.18],
        [WING_ROOT, wing(WING_ROOT).le + 0.32],
      ], EDGE);
      const hinge = (f: number, x0: number, x1: number) =>
        line(ctx, [
          [x0, wing(x0).le + f * (wing(x0).te - wing(x0).le)],
          [x1, wing(x1).le + f * (wing(x1).te - wing(x1).le)],
        ], LINE, 0.025);
      hinge(0.12, 1.3, WING_TIP);
      hinge(0.8, 1.65, 4.8);
      line(ctx, [[1.65, wing(1.65).le + 0.8 * (wing(1.65).te - wing(1.65).le)], [1.65, wing(1.65).te]], LINE, 0.025);
      line(ctx, [[4.8, wing(4.8).le + 0.8 * (wing(4.8).te - wing(4.8).le)], [4.8, wing(4.8).te]], LINE, 0.025);
      // wing access panels
      for (const x of [2.3, 3.2, 4.1]) {
        const w0 = wing(x);
        const w1 = wing(x + 0.6);
        AtlasPainter.sawRect(ctx, x, x + 0.6, w0.le + 0.9, Math.min(w1.te - 1.1, w0.le + 1.9), 2, 0.07, LINE_SOFT, 0.018);
      }
      // stabilator leading edge treatment
      line(ctx, STAB_LE, EDGE, 0.1);
      // fuselage longitudinal + frame lines
      for (const x of [0.35, 0.78]) line(ctx, [[x, S(3)], [x, S(14)]], LINE_SOFT, 0.018);
      for (const s of FRAMES_TOP) line(ctx, [[0, S(s)], [1.4, S(s)]], LINE_SOFT, 0.016);
      // radome joint
      line(ctx, [[0, S(1.55)], [0.5, S(1.62)]], LINE, 0.02);
    });
  }

  p.with('top', (ctx) => {
    // canopy sill + frame
    line(ctx, [[0.46, S(3.6)], [0.47, S(5.4)], [0.42, S(7.2)], [0, S(7.25)]], LINE, 0.03);
    // air refuelling door (spine, sawtooth)
    AtlasPainter.sawRect(ctx, 0, 0.3, S(7.9), S(8.8), 2, 0.1, LINE, 0.022);
    // engine access sawtooth doors
    AtlasPainter.sawRect(ctx, 0.22, 0.9, S(10.4), S(12.6), 3, 0.12, LINE, 0.02);
    AtlasPainter.sawRect(ctx, 0.95, 1.35, S(8.6), S(10.2), 2, 0.1, LINE_SOFT, 0.02);
    // chine edge treatment (tone only; its matte tape lives in the roughness map)
    line(ctx, CHINE_TOP, EDGE, 0.05);
    // dorsal lights / markings: walk-way hint near the spine
    line(ctx, [[0.12, S(9)], [0.12, S(12.5)]], 'rgba(20,22,24,0.25)', 0.02);
    // RNZAF low-vis kiwi roundel on the upper wing (both wings share this region), beak to the nose
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(3.7, 2.2, 0.42, 0, Math.PI * 2);
    ctx.strokeStyle = '#37393b';
    ctx.lineWidth = 0.045;
    ctx.stroke();
    ctx.translate(3.7, 2.2);
    ctx.rotate(Math.PI / 2);
    kiwi(ctx, 0, 0, 0.33, '#3c3e40');
    ctx.restore();
  });

  p.with('bottom', (ctx) => {
    // weapons bay doors: inner/outer with sawtooth ends
    AtlasPainter.sawRect(ctx, 0.08, 0.47, S(7.62), S(11.78), 2, 0.14, LINE, 0.026);
    AtlasPainter.sawRect(ctx, 0.47, 0.95, S(7.62), S(11.78), 3, 0.14, LINE, 0.026);
    // nose gear door, main gear doors
    AtlasPainter.sawRect(ctx, 0, 0.22, S(2.9), S(4.7), 1, 0.12, LINE, 0.022);
    AtlasPainter.sawRect(ctx, 1.0, 1.45, S(8.4), S(10.6), 2, 0.12, LINE, 0.022);
    // centreline
    line(ctx, [[0.01, S(0.6)], [0.01, S(14)]], LINE_SOFT, 0.02);
  });

  // sides
  for (const region of ['left', 'right'] as const) {
    const mirror = region === 'right';
    p.with(region, (ctx) => {
      const r = rng(region === 'left' ? 21 : 22);
      for (let i = 0; i < 18; i++) {
        ctx.fillStyle = r() > 0.5 ? LIGHT : DARKT;
        ctx.fillRect(-7 + r() * 13, -0.8 + r() * 1.5, 0.4 + r() * 1.1, 0.25 + r() * 0.5);
      }
      // frame lines
      for (const s of FRAMES_SIDE) line(ctx, [[S(s), -0.8], [S(s), 0.95]], LINE_SOFT, 0.014);
      // chine edge treatment
      line(ctx, CHINE_SIDE, EDGE, 0.03);
      // gun port door (left) / avionics bay (right)
      if (!mirror) AtlasPainter.sawRect(ctx, S(7.3), S(8.5), 0.15, 0.4, 3, 0.05, LINE, 0.018);
      else AtlasPainter.sawRect(ctx, S(6.8), S(7.9), 0.1, 0.45, 3, 0.05, LINE, 0.018);
      // RNZAF low-visibility kiwi roundel on the intake side (grey ring + kiwi facing the nose)
      const cx = S(6.35);
      const cy = -0.34;
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.arc(cx, cy, 0.3, 0, Math.PI * 2);
      ctx.strokeStyle = '#37393b';
      ctx.lineWidth = 0.035;
      ctx.stroke();
      kiwi(ctx, cx, cy, 0.24, '#3c3e40');
      ctx.restore();
      // "RNZAF" small below the canopy (dark grey)
      AtlasPainter.text(ctx, 'RNZAF', S(4.2), -0.3, 0.12, 'rgba(46,48,50,0.85)', mirror);
      // No. 75 Squadron style tail marking: 'NZ' tail code, small kiwi, serial on the canted fins
      AtlasPainter.text(ctx, 'NZ', mirror ? 4.55 : 4.35, 1.42, 0.36, 'rgba(48,50,52,0.85)', mirror);
      ctx.save();
      ctx.globalAlpha = 0.7;
      kiwi(ctx, mirror ? 4.95 : 4.8, 1.8, 0.2, '#404244');
      ctx.restore();
      AtlasPainter.text(ctx, 'NZ3501', mirror ? 4.6 : 4.4, 1.05, 0.1, 'rgba(48,50,52,0.8)', mirror);
      // rudder hinge
      line(ctx, [[4.75, 0.55], [5.05, 2.05]], LINE, 0.02);
      // fin leading edge treatment
      line(ctx, FIN_LE, EDGE, 0.08);
    });
  }

  p.with('front', (ctx) => {
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    ctx.fillRect(0, -1, 5.6, 3.6);
  });

  paintF35Weathering(p);
}

/**
 * A4: heat staining toward the nozzle and over the aft deck, soot right at the nozzle, and light,
 * broken leading-edge wear. Low alpha everywhere: it should read as use, not as paint.
 */
function paintF35Weathering(p: AtlasPainter): void {
  // heat bands: warm tan → bronze → slate, stepping up at the aft frames (panels heat unevenly)
  const bands: [number, number, string][] = [
    [HEAT_S0, 12.4, 'rgba(92,78,58,0.07)'],
    [12.4, 13.5, 'rgba(88,70,50,0.12)'],
    [13.5, HEAT_S1, 'rgba(70,62,64,0.16)'],
  ];
  const soot = (ctx: Ctx2D, a0: number, a1: number, z0: number, z1: number, alpha: number) => {
    const g = ctx.createLinearGradient(0, z0, 0, z1);
    g.addColorStop(0, 'rgba(14,13,12,0)');
    g.addColorStop(1, `rgba(14,13,12,${alpha})`);
    ctx.fillStyle = g;
    ctx.fillRect(a0, z0, a1 - a0, z1 - z0);
  };
  for (const region of ['top', 'bottom'] as const) {
    p.with(region, (ctx) => {
      // only the fuselage strip around the engine (|x| < 1.5); the wings and stabs stay clean
      for (const [s0, s1, c] of bands) {
        ctx.fillStyle = c;
        ctx.fillRect(0, S(s0), 1.5, s1 - s0);
      }
      soot(ctx, 0, 1.25, S(12.6), S(HEAT_S1), region === 'top' ? 0.3 : 0.35);
      // exhaust-wash streaks running aft along the deck
      const r = rng(region === 'top' ? 51 : 52);
      for (let i = 0; i < 26; i++) {
        const x = 0.1 + r() * 1.2;
        const z0 = S(HEAT_S0 + r() * 2);
        line(ctx, [[x, z0], [x + (r() - 0.5) * 0.05, S(HEAT_S1)]], `rgba(20,18,16,${0.04 + r() * 0.06})`, 0.02 + r() * 0.05);
      }
    });
  }
  for (const region of ['left', 'right'] as const) {
    p.with(region, (ctx) => {
      for (const [s0, s1, c] of bands) {
        ctx.fillStyle = c;
        ctx.fillRect(S(s0), -0.85, s1 - s0, 1.4);
      }
      const g = ctx.createLinearGradient(S(12.4), 0, S(NOZZLE_S + 0.2), 0);
      g.addColorStop(0, 'rgba(14,13,12,0)');
      g.addColorStop(1, 'rgba(14,13,12,0.3)');
      ctx.fillStyle = g;
      ctx.fillRect(S(12.4), -0.85, HEAT_S1 - 12.4, 1.4);
    });
  }
  // leading-edge wear: short, broken scuffs right on the edge (lighter where the coating is worn)
  const scuffs = (ctx: Ctx2D, pts: [number, number][], seed: number, n: number, w: number) => {
    const r = rng(seed);
    const [[a0, c0], [a1, c1]] = pts;
    for (let i = 0; i < n; i++) {
      const t = r();
      const len = 0.03 + r() * 0.12;
      const a = a0 + (a1 - a0) * t;
      const c = c0 + (c1 - c0) * t;
      const da = ((a1 - a0) / Math.hypot(a1 - a0, c1 - c0)) * len;
      const dc = ((c1 - c0) / Math.hypot(a1 - a0, c1 - c0)) * len;
      line(ctx, [[a, c], [a + da, c + dc]], `rgba(150,150,148,${0.05 + r() * 0.08})`, w * (0.5 + r()));
    }
  };
  for (const region of ['top', 'bottom'] as const) {
    p.with(region, (ctx) => {
      scuffs(ctx, wingLE(WING_ROOT, WING_TIP), region === 'top' ? 61 : 62, 70, 0.035);
      scuffs(ctx, STAB_LE, region === 'top' ? 63 : 64, 24, 0.03);
    });
  }
  for (const region of ['left', 'right'] as const) {
    p.with(region, (ctx) => scuffs(ctx, FIN_LE, region === 'left' ? 65 : 66, 26, 0.03));
  }
}

/**
 * A2: roughness atlas (grey = roughness). Panel-to-panel sheen variation, glossier RAM tiles and
 * markings, matte edge-treatment tapes along the edges and doors, heat-dulled aft deck, slightly
 * burnished leading-edge wear.
 */
function paintF35Roughness(p: AtlasPainter): void {
  const BASE = F35_PAINT.roughness;
  const TAPE = rv(0.68);
  p.fillAll(rv(BASE));
  // broad, low-contrast mottle only: per-pixel grain in this channel gets smeared along the steep,
  // planar-projected nose faces and turns the horizon reflection into streaks
  p.mottle(13, 120, 0.03, 0.03, 0.08);

  // panel-to-panel sheen: each fuselage bay between frames gets its own roughness
  for (const region of ['top', 'bottom'] as const) {
    p.with(region, (ctx) => {
      const r = rng(region === 'top' ? 71 : 72);
      for (let i = 0; i < FRAMES_TOP.length - 1; i++) {
        for (const [x0, x1] of [[0, 0.35], [0.35, 0.78], [0.78, 1.4]]) {
          ctx.fillStyle = rv(BASE + (r() - 0.5) * 0.12);
          ctx.fillRect(x0, S(FRAMES_TOP[i]), x1 - x0, FRAMES_TOP[i + 1] - FRAMES_TOP[i]);
        }
      }
      // wing skin panels (spanwise strips) + RAM tiles
      for (let x = WING_ROOT + 0.2; x < WING_TIP; x += 0.75) {
        ctx.fillStyle = rv(BASE + (r() - 0.5) * 0.12);
        poly(ctx, [
          [x, wing(x).le],
          [x + 0.75, wing(x + 0.75).le],
          [x + 0.75, wing(x + 0.75).te],
          [x, wing(x).te],
        ]);
        ctx.fill();
      }
      for (let i = 0; i < 30; i++) {
        ctx.fillStyle = rv(BASE + (r() > 0.5 ? -0.05 : 0.05), 0.6);
        ctx.fillRect(r() * 4.5, -6 + r() * 12, 0.3 + r() * 0.8, 0.3 + r() * 1.0);
      }
      // matte edge-treatment tapes: wing and stab leading edges, control-surface hinges, doors
      poly(ctx, [
        [WING_ROOT, wing(WING_ROOT).le],
        [WING_TIP, wing(WING_TIP).le],
        [WING_TIP, wing(WING_TIP).le + 0.14],
        [WING_ROOT, wing(WING_ROOT).le + 0.22],
      ], TAPE);
      line(ctx, STAB_LE, TAPE, 0.09);
      for (const f of [0.12, 0.8]) {
        line(ctx, [
          [1.3, wing(1.3).le + f * (wing(1.3).te - wing(1.3).le)],
          [WING_TIP, wing(WING_TIP).le + f * (wing(WING_TIP).te - wing(WING_TIP).le)],
        ], rv(0.64), 0.05);
      }
      line(ctx, [[0, S(1.55)], [0.5, S(1.62)]], TAPE, 0.06);
    });
  }
  p.with('top', (ctx) => {
    // (no chine tape in planform: the steep nose faces project it into a wide streak; the side
    // region carries the chine tape)
    line(ctx, [[0.46, S(3.6)], [0.47, S(5.4)], [0.42, S(7.2)], [0, S(7.25)]], TAPE, 0.07);
    AtlasPainter.sawRect(ctx, 0, 0.3, S(7.9), S(8.8), 2, 0.1, TAPE, 0.06);
    AtlasPainter.sawRect(ctx, 0.22, 0.9, S(10.4), S(12.6), 3, 0.12, TAPE, 0.06);
    AtlasPainter.sawRect(ctx, 0.95, 1.35, S(8.6), S(10.2), 2, 0.1, TAPE, 0.05);
    // markings are paint over RAM: a touch glossier
    ctx.save();
    ctx.translate(3.7, 2.2);
    ctx.rotate(Math.PI / 2);
    kiwi(ctx, 0, 0, 0.33, rv(BASE - 0.12));
    ctx.restore();
  });
  p.with('bottom', (ctx) => {
    AtlasPainter.sawRect(ctx, 0.08, 0.47, S(7.62), S(11.78), 2, 0.14, TAPE, 0.07);
    AtlasPainter.sawRect(ctx, 0.47, 0.95, S(7.62), S(11.78), 3, 0.14, TAPE, 0.07);
    AtlasPainter.sawRect(ctx, 0, 0.22, S(2.9), S(4.7), 1, 0.12, TAPE, 0.06);
    AtlasPainter.sawRect(ctx, 1.0, 1.45, S(8.4), S(10.6), 2, 0.12, TAPE, 0.06);
  });
  for (const region of ['left', 'right'] as const) {
    const mirror = region === 'right';
    p.with(region, (ctx) => {
      const r = rng(region === 'left' ? 73 : 74);
      for (let i = 0; i < FRAMES_SIDE.length - 1; i++) {
        ctx.fillStyle = rv(BASE + (r() - 0.5) * 0.12);
        ctx.fillRect(S(FRAMES_SIDE[i]), -0.85, FRAMES_SIDE[i + 1] - FRAMES_SIDE[i], 1.8);
      }
      line(ctx, CHINE_SIDE, TAPE, 0.04);
      line(ctx, FIN_LE, TAPE, 0.08);
      line(ctx, [[4.75, 0.55], [5.05, 2.05]], rv(0.64), 0.04);
      if (!mirror) AtlasPainter.sawRect(ctx, S(7.3), S(8.5), 0.15, 0.4, 3, 0.05, TAPE, 0.05);
      else AtlasPainter.sawRect(ctx, S(6.8), S(7.9), 0.1, 0.45, 3, 0.05, TAPE, 0.05);
      kiwi(ctx, S(6.35), -0.34, 0.24, rv(BASE - 0.12));
      AtlasPainter.text(ctx, 'NZ', mirror ? 4.55 : 4.35, 1.42, 0.36, rv(BASE - 0.12), mirror);
    });
  }

  // heat-dulled aft deck and soot (rough), burnished leading-edge wear (smoother)
  for (const region of ['top', 'bottom'] as const) {
    p.with(region, (ctx) => {
      const g = ctx.createLinearGradient(0, S(HEAT_S0), 0, S(HEAT_S1));
      g.addColorStop(0, rv(0.7, 0));
      g.addColorStop(0.45, rv(0.7, 0.7));
      g.addColorStop(1, rv(0.86, 1));
      ctx.fillStyle = g;
      ctx.fillRect(0, S(HEAT_S0), 1.5, HEAT_S1 - HEAT_S0);
      const r = rng(region === 'top' ? 81 : 82);
      for (let i = 0; i < 40; i++) {
        const t = r();
        const x = WING_ROOT + t * (WING_TIP - WING_ROOT);
        line(ctx, [[x, wing(x).le], [x + 0.05 + r() * 0.1, wing(x + 0.1).le]], rv(0.4, 0.8), 0.03);
      }
    });
  }
  for (const region of ['left', 'right'] as const) {
    p.with(region, (ctx) => {
      const g = ctx.createLinearGradient(S(HEAT_S0), 0, S(HEAT_S1), 0);
      g.addColorStop(0, rv(0.7, 0));
      g.addColorStop(0.45, rv(0.7, 0.7));
      g.addColorStop(1, rv(0.86, 1));
      ctx.fillStyle = g;
      ctx.fillRect(S(HEAT_S0), -0.85, HEAT_S1 - HEAT_S0, 1.4);
    });
  }
}

/**
 * Kiwi silhouette (RNZAF roundel centre) at (a, c), body length ~2r, beak pointing to -a (the nose
 * in the side regions). Drawn in model units in the current region transform (y up).
 */
function kiwi(ctx: Ctx2D, a: number, c: number, r: number, fill: string): void {
  ctx.fillStyle = fill;
  // body (pear shaped: big rear, smaller front)
  ctx.beginPath();
  ctx.ellipse(a + r * 0.18, c + r * 0.02, r * 0.62, r * 0.46, 0.12, 0, Math.PI * 2);
  ctx.fill();
  // head
  ctx.beginPath();
  ctx.ellipse(a - r * 0.45, c + r * 0.22, r * 0.2, r * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  // long, slightly down-curved beak
  ctx.beginPath();
  ctx.moveTo(a - r * 0.6, c + r * 0.27);
  ctx.quadraticCurveTo(a - r * 0.9, c + r * 0.12, a - r * 1.08, c - r * 0.2);
  ctx.lineTo(a - r * 1.03, c - r * 0.21);
  ctx.quadraticCurveTo(a - r * 0.85, c + r * 0.05, a - r * 0.58, c + r * 0.15);
  ctx.closePath();
  ctx.fill();
  // legs
  ctx.strokeStyle = fill;
  ctx.lineWidth = r * 0.07;
  ctx.beginPath();
  ctx.moveTo(a + r * 0.05, c - r * 0.35);
  ctx.lineTo(a - r * 0.02, c - r * 0.72);
  ctx.lineTo(a - r * 0.18, c - r * 0.74);
  ctx.moveTo(a + r * 0.3, c - r * 0.35);
  ctx.lineTo(a + r * 0.26, c - r * 0.72);
  ctx.lineTo(a + r * 0.1, c - r * 0.74);
  ctx.stroke();
}

/* ───────────────────────── enemy liveries ───────────────────────── */

export interface CamoSpec {
  base: string;
  colors: string[];
  blobs: number;
  blobSize: number;
  belly: string;
  radome: string;
  radomeZ: number;
  star: { z: number; y: number; r: number }[];
  number: { text: string; z: number; y: number; h: number; color: string } | null;
  splinter?: boolean;
  roughness?: number;
  metalness?: number;
}

export function registerCamoMaterial(key: string, b: AtlasBounds, spec: CamoSpec): void {
  const size = Math.min(1024, Math.max(512, modelQuality.textureSize / 2));
  makeSkin(key, b, size, (p) => paintCamo(p, spec), {
    roughness: spec.roughness ?? 0.6,
    metalness: spec.metalness ?? 0.2,
    env: 0.6,
    fallback: 0x8a98a6,
  });
}

function paintCamo(p: AtlasPainter, c: CamoSpec): void {
  const b = p.b;
  p.fillAll(c.base);
  // camouflage on top + sides
  const L: [number, number, number, number] = [0, b.zMin, b.xMax, b.zMax];
  const S: [number, number, number, number] = [b.zMin, b.yMin, b.zMax, b.yMax];
  if (c.splinter) {
    for (const region of ['top', 'left', 'right'] as const) {
      const r = rng(region.length * 7 + 3);
      p.with(region, (ctx) => {
        const bounds = region === 'top' ? L : S;
        for (let i = 0; i < c.blobs; i++) {
          ctx.fillStyle = c.colors[i % c.colors.length];
          const cx = bounds[0] + r() * (bounds[2] - bounds[0]);
          const cy = bounds[1] + r() * (bounds[3] - bounds[1]);
          const s = c.blobSize * (0.6 + r());
          poly(ctx, [
            [cx - s, cy - s * 0.3],
            [cx + s * 0.2, cy - s * 0.6],
            [cx + s, cy + s * 0.25],
            [cx - s * 0.3, cy + s * 0.55],
          ], c.colors[i % c.colors.length]);
        }
      });
    }
  } else {
    p.camo('top', 5, c.colors, c.blobs, c.blobSize, L);
    p.camo('left', 6, c.colors, Math.round(c.blobs * 0.7), c.blobSize * 0.8, S);
    p.camo('right', 6, c.colors, Math.round(c.blobs * 0.7), c.blobSize * 0.8, S);
  }
  // light belly
  p.with('bottom', (ctx) => {
    ctx.fillStyle = c.belly;
    ctx.fillRect(0, b.zMin, b.xMax, b.zMax - b.zMin);
  });
  p.mottle(31, 140, 0.04, 0.01, 0.05);
  p.grain(32, 0.04, 0.035);
  // panel lines
  for (const region of ['top', 'bottom'] as const) {
    p.with(region, (ctx) => {
      for (let z = b.zMin + 1.5; z < b.zMax; z += 1.3) line(ctx, [[0, z], [1.3, z]], 'rgba(20,25,30,0.25)', 0.018);
      line(ctx, [[0.4, b.zMin + 2], [0.4, b.zMax - 1]], 'rgba(20,25,30,0.2)', 0.018);
    });
  }
  // dielectric radome
  for (const region of ['top', 'bottom'] as const) {
    p.with(region, (ctx) => {
      ctx.fillStyle = c.radome;
      ctx.fillRect(0, b.zMin, 2, c.radomeZ - b.zMin);
    });
  }
  for (const region of ['left', 'right', 'front'] as const) {
    p.with(region, (ctx) => {
      ctx.fillStyle = c.radome;
      if (region === 'front') return;
      ctx.fillRect(b.zMin, b.yMin, c.radomeZ - b.zMin, b.yMax - b.yMin);
    });
  }
  // stars + bort number on both sides
  for (const region of ['left', 'right'] as const) {
    const mirror = region === 'right';
    p.with(region, (ctx) => {
      for (const s of c.star) AtlasPainter.star(ctx, s.z, s.y, s.r, '#c8201c', '#f0f0f0', s.r * 0.22);
      if (c.number) AtlasPainter.text(ctx, c.number.text, c.number.z, c.number.y, c.number.h, c.number.color, mirror);
    });
  }
}

/* ───────────────────────── civil airliner ───────────────────────── */

/**
 * AeroFlop A320neo (fictional airline in Air NZ-inspired colours): white fuselage, black fin that sweeps down over the rear fuselage
 * with a white koru (unfurling fern frond) on it, black titles, grey wings, dark window row.
 * `z0` is the model z of the nose tip.
 */
export function registerAirlinerMaterials(key: string, b: AtlasBounds, z0: number): void {
  makeSkin(key, b, Math.min(2048, modelQuality.textureSize), (p) => paintAirliner(p, z0), {
    roughness: 0.4,
    metalness: 0.05,
    env: 0.55,
    fallback: 0xe9ecee,
  });
}

const AIRLINE_TITLE = 'AeroFlop';
const AIRLINE_REG = 'ZK-FLP';
const TAIL_BLACK = '#101113';

function paintAirliner(p: AtlasPainter, z0: number): void {
  const b = p.b;
  const S = (s: number) => z0 + s;
  p.fillAll('#f3f4f5');
  p.mottle(41, 80, 0.025, 0.01, 0.05);
  // wings / tailplane: Airbus light grey; fuselage strip stays white
  for (const region of ['top', 'bottom'] as const) {
    p.with(region, (ctx) => {
      ctx.fillStyle = region === 'top' ? '#cfd3d7' : '#c3c8cc';
      ctx.fillRect(2.0, b.zMin, b.xMax, b.zMax - b.zMin);
      // wing panel lines
      for (let x = 3; x < b.xMax; x += 1.6) line(ctx, [[x, S(13)], [x, S(23)]], 'rgba(40,45,50,0.18)', 0.02);
    });
  }
  // black rear fuselage top + belly fairing grey
  p.with('top', (ctx) => {
    ctx.fillStyle = TAIL_BLACK;
    ctx.fillRect(0, S(29.5), 1.9, b.zMax - S(29.5));
    // windscreen seen from above
    ctx.fillStyle = '#15191e';
    ctx.fillRect(0, S(1.8), 0.85, 0.8);
  });
  p.with('bottom', (ctx) => {
    ctx.fillStyle = '#dfe2e5';
    ctx.fillRect(0, S(11), 2.0, 11);
  });

  for (const region of ['left', 'right'] as const) {
    const mirror = region === 'right';
    p.with(region, (ctx) => {
      // tail: black fin sweeping down over the rear fuselage
      ctx.fillStyle = TAIL_BLACK;
      ctx.beginPath();
      ctx.moveTo(S(27.2), b.yMax);
      ctx.lineTo(S(27.2), 2.2);
      ctx.quadraticCurveTo(S(29.5), 1.6, S(31.5), -0.4);
      ctx.quadraticCurveTo(S(33.0), -1.6, S(35.0), -1.4);
      ctx.lineTo(b.zMax, -1.0);
      ctx.lineTo(b.zMax, b.yMax);
      ctx.closePath();
      ctx.fill();
      // koru on the fin
      koru(ctx, S(34.0), 4.75, 1.55, '#f5f6f7', !mirror);
      // titles, registration
      // (side faces only reach ~y 1.05 on the 1.95 m fuselage; above that the atlas maps to 'top')
      AtlasPainter.text(ctx, AIRLINE_TITLE, S(12.0), 0.68, 0.62, TAIL_BLACK, mirror);
      AtlasPainter.text(ctx, AIRLINE_REG, S(29.0), -0.55, 0.28, 'rgba(60,64,68,0.9)', mirror);
      // cockpit windscreen + side windows
      poly(ctx, [
        [S(1.55), 0.3],
        [S(2.35), 0.95],
        [S(3.75), 1.05],
        [S(3.85), 0.42],
      ], '#15191e');
      // passenger windows (gaps at the doors and overwing exits)
      ctx.fillStyle = '#1b2026';
      for (let s = 6.4; s < 31.2; s += 0.53) {
        if (Math.abs(s - 14.3) < 0.45 || Math.abs(s - 15.0) < 0.2) continue;
        ctx.fillRect(S(s), 0.05, 0.22, 0.3);
      }
      // doors (outline)
      for (const s of [4.4, 32.8]) {
        ctx.strokeStyle = 'rgba(60,66,72,0.55)';
        ctx.lineWidth = 0.035;
        ctx.strokeRect(S(s), -0.75, 0.82, 1.9);
      }
      for (const s of [14.2, 14.95]) {
        ctx.strokeStyle = 'rgba(60,66,72,0.45)';
        ctx.lineWidth = 0.03;
        ctx.strokeRect(S(s), -0.35, 0.5, 0.95);
      }
      // cheat line of panel seams
      line(ctx, [[S(4), -0.95], [S(30), -0.95]], 'rgba(60,66,72,0.12)', 0.02);
    });
  }
  p.grain(42, 0.03, 0.02);
}

/**
 * Koru: an unfurling fern frond — a tapering spiral ending in a round bud — centred at (a, c) with
 * outer radius r. `forward` makes the frond curl towards the nose (-a).
 */
function koru(ctx: Ctx2D, a: number, c: number, r: number, fill: string, forward: boolean): void {
  ctx.save();
  ctx.translate(a, c);
  if (!forward) ctx.scale(-1, 1);
  ctx.fillStyle = fill;
  ctx.strokeStyle = fill;
  ctx.lineCap = 'round';
  // stem rising from the lower aft corner into the spiral
  const turns = 1.35;
  const steps = 60;
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const pt = (t: number): [number, number] => {
      const ang = -Math.PI * 0.25 + t * turns * Math.PI * 2;
      const rad = r * (1 - 0.78 * t);
      return [-Math.cos(ang) * rad * 0.82, Math.sin(ang) * rad];
    };
    const [x0, y0] = pt(t0);
    const [x1, y1] = pt(t1);
    ctx.lineWidth = r * (0.34 - 0.2 * t0);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  // bud at the heart of the spiral
  ctx.beginPath();
  ctx.ellipse(-r * 0.05, r * 0.02, r * 0.2, r * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
