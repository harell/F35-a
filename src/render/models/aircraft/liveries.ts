/**
 * Procedural liveries painted in model space onto the planar-by-facing atlas (see geom/atlas.ts):
 *  - F-35A: low-vis "Have Glass" grey RAM with panel lines, sawtooth doors, tile/RAM edge tones,
 *    RNZAF low-visibility kiwi roundels, 'NZ' tail code and NZ serial (No. 75 Squadron style).
 *  - Russian types: grey-blue Flanker camouflage, two-tone MiG-29 greys, dark Su-57 splinter,
 *    light bombers; red stars and bort numbers.
 */
import { MeshStandardMaterial } from 'three';
import { AtlasPainter, createCanvas, rng, type AtlasBounds, type Ctx2D } from '../geom/atlas';
import { canvasTexture, getEnvCube, modelQuality, registerMaterial } from '../materials';

const poly = AtlasPainter.poly;
const line = AtlasPainter.line;

function makeSkin(
  key: string,
  bounds: AtlasBounds,
  size: number,
  paint: (p: AtlasPainter) => void,
  mat: { roughness: number; metalness: number; env: number; fallback: number },
): void {
  registerMaterial(key, () => {
    const c = createCanvas(size, size);
    let map = null;
    if (c) {
      const ctx = c.getContext('2d') as Ctx2D;
      paint(new AtlasPainter(ctx, bounds));
      map = canvasTexture(c, true, false);
    }
    const m = new MeshStandardMaterial({
      color: map ? 0xffffff : mat.fallback,
      map,
      roughness: mat.roughness,
      metalness: mat.metalness,
      envMapIntensity: mat.env,
      envMap: getEnvCube(),
    });
    return m;
  });
}

/* ───────────────────────── F-35A ───────────────────────── */

export function registerF35Materials(b: AtlasBounds): void {
  makeSkin('f35.skin', b, Math.min(2048, modelQuality.textureSize), paintF35, {
    roughness: 0.6,
    metalness: 0.1,
    env: 0.4,
    fallback: 0x5d6267,
  });
}

function paintF35(p: AtlasPainter): void {
  const Z0 = -8.3;
  const S = (s: number) => Z0 + s;
  const LINE = 'rgba(30,34,38,0.55)';
  const LINE_SOFT = 'rgba(30,34,38,0.3)';
  const LIGHT = 'rgba(255,255,255,0.055)';
  const DARKT = 'rgba(0,0,0,0.05)';
  p.fillAll('#5f6468');
  p.mottle(11, 220, 0.045, 0.01, 0.05);
  p.grain(12, 0.05, 0.035);

  const wing = (x: number) => {
    const t = (x - 1.2) / 4.15;
    return { le: -1.1 + 2.84 * t, te: 4.3 - 0.96 * t };
  };

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
      // wing leading edge band + hinge lines
      poly(ctx, [
        [1.2, wing(1.2).le],
        [5.35, wing(5.35).le],
        [5.35, wing(5.35).le + 0.18],
        [1.2, wing(1.2).le + 0.32],
      ], 'rgba(255,255,255,0.07)');
      const hinge = (f: number, x0: number, x1: number) =>
        line(ctx, [
          [x0, wing(x0).le + f * (wing(x0).te - wing(x0).le)],
          [x1, wing(x1).le + f * (wing(x1).te - wing(x1).le)],
        ], LINE, 0.025);
      hinge(0.12, 1.3, 5.35);
      hinge(0.8, 1.65, 4.8);
      line(ctx, [[1.65, wing(1.65).le + 0.8 * (wing(1.65).te - wing(1.65).le)], [1.65, wing(1.65).te]], LINE, 0.025);
      line(ctx, [[4.8, wing(4.8).le + 0.8 * (wing(4.8).te - wing(4.8).le)], [4.8, wing(4.8).te]], LINE, 0.025);
      // wing access panels
      for (const x of [2.3, 3.2, 4.1]) {
        const w0 = wing(x);
        const w1 = wing(x + 0.6);
        AtlasPainter.sawRect(ctx, x, x + 0.6, w0.le + 0.9, Math.min(w1.te - 1.1, w0.le + 1.9), 2, 0.07, LINE_SOFT, 0.018);
      }
      // stabilator
      line(ctx, [[1.0, 4.55], [3.35, 6.1]], 'rgba(255,255,255,0.08)', 0.1);
      // fuselage longitudinal + frame lines
      for (const x of [0.35, 0.78]) line(ctx, [[x, S(3)], [x, S(14)]], LINE_SOFT, 0.018);
      for (const s of [1.6, 2.8, 6.9, 8.2, 9.7, 11.1, 12.4, 13.5]) line(ctx, [[0, S(s)], [1.4, S(s)]], LINE_SOFT, 0.016);
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
    // chine edge highlight
    line(ctx, [[0.3, S(1)], [0.74, S(3.6)], [1.16, S(5.4)], [1.48, S(7.4)]], 'rgba(255,255,255,0.12)', 0.05);
    // dorsal lights / markings: walk-way hint near the spine
    line(ctx, [[0.12, S(9)], [0.12, S(12.5)]], 'rgba(20,22,24,0.25)', 0.02);
    // RNZAF low-vis kiwi roundel on the upper wing (both wings share this region), beak to the nose
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(3.7, 2.2, 0.42, 0, Math.PI * 2);
    ctx.strokeStyle = '#3f4448';
    ctx.lineWidth = 0.045;
    ctx.stroke();
    ctx.translate(3.7, 2.2);
    ctx.rotate(Math.PI / 2);
    kiwi(ctx, 0, 0, 0.33, '#454b50');
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
      for (const s of [1.55, 2.8, 4.1, 6.9, 8.2, 9.7, 11.1, 12.4, 13.5]) line(ctx, [[S(s), -0.8], [S(s), 0.95]], LINE_SOFT, 0.014);
      // chine line
      line(ctx, [[S(0), -0.02], [S(3), 0.03], [S(7.4), 0.07], [S(14), 0.05]], 'rgba(255,255,255,0.10)', 0.03);
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
      ctx.strokeStyle = '#3f4448';
      ctx.lineWidth = 0.035;
      ctx.stroke();
      kiwi(ctx, cx, cy, 0.24, '#454b50');
      ctx.restore();
      // "RNZAF" small below the canopy (dark grey)
      AtlasPainter.text(ctx, 'RNZAF', S(4.2), -0.3, 0.12, 'rgba(55,60,64,0.8)', mirror);
      // No. 75 Squadron style tail marking: 'NZ' tail code, small kiwi, serial on the canted fins
      AtlasPainter.text(ctx, 'NZ', mirror ? 4.55 : 4.35, 1.42, 0.36, 'rgba(58,62,66,0.85)', mirror);
      ctx.save();
      ctx.globalAlpha = 0.7;
      kiwi(ctx, mirror ? 4.95 : 4.8, 1.8, 0.2, '#4a5055');
      ctx.restore();
      AtlasPainter.text(ctx, 'NZ3501', mirror ? 4.6 : 4.4, 1.05, 0.1, 'rgba(58,62,66,0.8)', mirror);
      // rudder hinge
      line(ctx, [[4.75, 0.55], [5.05, 2.05]], LINE, 0.02);
      // fin leading edge band
      line(ctx, [[2.95, 0.35], [4.75, 2.4]], 'rgba(255,255,255,0.08)', 0.08);
    });
  }

  p.with('front', (ctx) => {
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    ctx.fillRect(0, -1, 5.6, 3.6);
  });
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
 * Air New Zealand style A320neo: white fuselage, black fin that sweeps down over the rear fuselage
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

const AIRLINE_TITLE = 'AIR NEW ZEALAND';
const AIRLINE_REG = 'ZK-NHA';
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
      AtlasPainter.text(ctx, AIRLINE_TITLE, S(12.5), 0.7, 0.44, TAIL_BLACK, mirror);
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
