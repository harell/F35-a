/**
 * Ship rat (Rattus rattus), the rat of New Zealand's forests: 0.18 m of head and body and a scaly tail
 * longer than that (0.22 m), big thin near-hairless ears, large dark eyes, a pointed muzzle with long
 * whiskers. Grey-brown agouti back (ticked tips), paler grey-cream belly, pink feet.
 * Metres; front = -Z, up = +Y, origin on the ground under the body.
 */
import { Color, Group, Mesh, MeshStandardMaterial, type Vector3 } from 'three';
import { furred } from './fur';
import { claws, eye, whiskers } from './parts';
import { chain, cone, ell, fbm, hex, mix, sculpt, smooth, tube, type Paint, type Prim, type V3 } from './sdf';
import { tailScales } from './textures';

const BACK = hex(0x3f352d);
const SIDE = hex(0x625547);
const BELLY = hex(0xbfb3a1);
const EAR = hex(0x9a776d);
const NOSE = hex(0xc78f88);
const FOOT = hex(0xc7a39a);

function prims(): Prim[] {
  const p: Prim[] = [
    ell('body', [0, 0.04, -0.045], [0.029, 0.03, 0.04], 0),
    ell('body', [0, 0.046, 0.0], [0.035, 0.035, 0.06], 0.02),
    ell('body', [0, 0.049, 0.045], [0.039, 0.038, 0.047], 0.02),
    cone('neck', [0, 0.045, -0.07], [0, 0.05, -0.09], 0.025, 0.021, 0.015),
    ell('head', [0, 0.053, -0.1], [0.02, 0.019, 0.027], 0.012),
    ell('cheek', [0.012, 0.047, -0.108], [0.012, 0.012, 0.017], 0.008),
    ell('cheek', [-0.012, 0.047, -0.108], [0.012, 0.012, 0.017], 0.008),
    cone('muzzle', [0, 0.051, -0.114], [0, 0.043, -0.146], 0.015, 0.0052, 0.009),
    ell('nose', [0, 0.0428, -0.1495], [0.0048, 0.0038, 0.0033], 0.002),
    ell('chin', [0, 0.039, -0.124], [0.007, 0.005, 0.012], 0.005),
    // ears: big, round and thin, tilted out
    ell('ear', [0.017, 0.074, -0.091], [0.0115, 0.0125, 0.0022], 0.004, [-0.15, -0.55, -0.35]),
    ell('ear', [-0.017, 0.074, -0.091], [0.0115, 0.0125, 0.0022], 0.004, [-0.15, 0.55, 0.35]),
    ell('socket', [0.0135, 0.0585, -0.113], [0.0048, 0.004, 0.0048], 0.002, undefined, true),
    ell('socket', [-0.0135, 0.0585, -0.113], [0.0048, 0.004, 0.0048], 0.002, undefined, true),
  ];
  for (const s of [1, -1]) {
    p.push(...chain('arm', [[0.02 * s, 0.035, -0.045], [0.022 * s, 0.016, -0.05], [0.02 * s, 0.005, -0.058]], [0.011, 0.0055, 0.0035], 0.008));
    p.push(ell('foot', [0.02 * s, 0.003, -0.063], [0.0055, 0.0028, 0.0065], 0.003));
    for (let t = 0; t < 4; t++) {
      const a = (t - 1.5) * 0.38;
      p.push(cone('toe', [0.02 * s, 0.003, -0.064], [0.02 * s + Math.sin(a) * 0.007, 0.0018, -0.064 - Math.cos(a) * 0.0065], 0.0016, 0.0011, 0.001));
    }
    p.push(ell('thigh', [0.024 * s, 0.038, 0.048], [0.015, 0.022, 0.023], 0.02));
    p.push(...chain('shank', [[0.027 * s, 0.026, 0.058], [0.027 * s, 0.01, 0.064], [0.026 * s, 0.004, 0.055]], [0.009, 0.005, 0.0035], 0.006));
    p.push(ell('foot', [0.026 * s, 0.003, 0.04], [0.0065, 0.0028, 0.016], 0.003));
    for (let t = 0; t < 5; t++) {
      const a = (t - 2) * 0.3;
      p.push(cone('toe', [0.026 * s, 0.003, 0.03], [0.026 * s + Math.sin(a) * 0.0075, 0.0018, 0.03 - Math.cos(a) * 0.009], 0.0016, 0.0011, 0.001));
    }
  }
  p.push(cone('tailroot', [0, 0.045, 0.08], [0, 0.04, 0.095], 0.008, 0.005, 0.01));
  return p;
}

function paint(p: Vector3, n: Vector3, part: string): Paint {
  const mott = fbm(p, 120) - 0.5;
  const up = n.y;
  switch (part) {
    case 'nose':
      return { c: NOSE, fur: 0 };
    case 'ear':
      return { c: mix(EAR, hex(0x6d5048), smooth(0.07, 0.085, p.y) * 0.6), fur: 0.04, comb: [0, 1, 0] };
    case 'foot':
    case 'toe':
      return { c: FOOT, fur: up > 0.5 ? 0.12 : 0, comb: [0, 0, -1] };
    case 'tailroot':
      return { c: mix(SIDE, BACK, 0.5), fur: 0.5 };
    case 'head':
    case 'cheek':
    case 'muzzle':
    case 'chin':
    case 'neck':
    case 'socket': {
      let c = mix(SIDE, BACK, smooth(0.2, 0.9, up));
      c = mix(c, BELLY, smooth(-0.2, -0.7, up));
      return { c: mix(c, hex(0x2a231e), 0.1 + mott * 0.3), fur: part === 'muzzle' ? 0.3 : 0.5, comb: [0, 0.1 * Math.sign(up), 1] };
    }
    default: {
      let c = mix(SIDE, BACK, smooth(0.0, 0.8, up));
      c = mix(c, BELLY, smooth(-0.25, -0.7, up));
      c = mix(c, hex(0x2c241f), Math.max(0, mott * 0.7));
      const leg = part === 'arm' || part === 'shank';
      return { c, fur: leg ? 0.45 : 1, comb: leg ? [0, -1, 0.2] : [0, -0.2, 1] };
    }
  }
}

/** The tail: a tapering scaly tube lying in a loose curve on the ground. */
function tail(): Mesh {
  const pts: V3[] = [
    [0, 0.042, 0.088],
    [0, 0.033, 0.115],
    [0.004, 0.016, 0.152],
    [0.016, 0.006, 0.2],
    [0.04, 0.004, 0.243],
    [0.068, 0.004, 0.272],
    [0.094, 0.005, 0.286],
  ];
  const geo = tube(pts, 0.0048, (u) => 0.0048 - 0.0036 * Math.pow(u, 0.8), {
    seg: 140,
    radial: 14,
    // darker on top, pinker underneath
    color: (u, a) => new Color().lerpColors(new Color(0x7c6a63), new Color(0xb39087), 0.5 - 0.5 * Math.cos(a * Math.PI * 2) * 0.9 + u * 0.15).getHex(),
  });
  const map = tailScales().clone();
  map.needsUpdate = true;
  map.repeat.set(170, 1);
  map.userData.own = true;
  const bump = map;
  const mesh = new Mesh(geo, new MeshStandardMaterial({ vertexColors: true, map, bumpMap: bump, bumpScale: 0.6, roughness: 0.55 }));
  mesh.name = 'tail';
  return mesh;
}

export function ratModel(detail = 1): Group {
  const root = new Group();
  root.name = 'pest:rat';
  const body = prims();
  const h = 0.0011 / detail;
  const fur = { shells: Math.round(22 * detail), length: 0.0085, spacing: 0.00055, comb: 0.85, thickness: 0.5, tip: 0x8f7a5e, tipMix: 0.4, occlusion: 0.6 };
  root.add(furred(sculpt(body, paint, h), fur, {}, sculpt(body, paint, h * 1.8)));
  root.add(tail());
  root.add(eye([0.0137, 0.059, -0.114], 0.0047), eye([-0.0137, 0.059, -0.114], 0.0047));
  root.add(whiskers([0.0045, 0.044, -0.141], 0.05, 7, 0x1d1815, 0.00018));
  const tips: V3[] = [];
  for (const s of [1, -1])
    for (let t = 0; t < 4; t++) {
      const a = (t - 1.5) * 0.38;
      tips.push([0.02 * s + Math.sin(a) * 0.0078, 0.0018, -0.064 - Math.cos(a) * 0.0072]);
    }
  root.add(claws(tips, 0.003, 0.0006, 0xd8c8bc));
  return root;
}
