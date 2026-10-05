/**
 * Common brushtail possum (Trichosurus vulpecula), grey morph, on all fours: 0.40 m nose to rump and a
 * 0.32 m bushy tail with the bare strip under its grasping tip. Silver-grey back with pale tips, cream
 * throat and belly, dark muzzle bridge, long oval ears, pink nose, big dark eyes.
 * Metres; front = -Z, up = +Y, origin on the ground under the body.
 */
import { Group, type Vector3 } from 'three';
import { furred } from './fur';
import { claws, eye, whiskers } from './parts';
import { chain, cone, ell, fbm, hex, mix, sculpt, smooth, type Paint, type Prim, type V3 } from './sdf';

const BACK = hex(0x4e4945);
const SIDE = hex(0x77716b);
const BELLY = hex(0xe6dccb);
const THROAT = hex(0xf0e8da);
const MUZZLE = hex(0x3d3633);
const EAR_OUT = hex(0x3b3533);
const EAR_IN = hex(0xb9928a);
const NOSE = hex(0xd99a9a);
const TAIL = hex(0x1f1a18);
const SKIN = hex(0x6e5853);
const PAW = hex(0x463a37);

const TAIL_PTS: V3[] = [
  [0, 0.15, 0.13],
  [0, 0.135, 0.2],
  [0, 0.1, 0.265],
  [0, 0.065, 0.32],
  [0.01, 0.035, 0.38],
  [0.03, 0.022, 0.435],
  [0.062, 0.024, 0.47],
  [0.088, 0.04, 0.47],
];

function prims(): Prim[] {
  const p: Prim[] = [
    // body: chest, barrel, broad rump, the back arched up to the hips
    ell('body', [0, 0.125, -0.075], [0.072, 0.075, 0.085], 0),
    ell('body', [0, 0.14, 0.01], [0.088, 0.09, 0.11], 0.05),
    ell('body', [0, 0.15, 0.085], [0.09, 0.092, 0.085], 0.05),
    // thick neck into a big, fox-like head
    cone('neck', [0, 0.14, -0.12], [0, 0.163, -0.165], 0.062, 0.052, 0.04),
    ell('head', [0, 0.175, -0.19], [0.054, 0.05, 0.058], 0.03),
    ell('cheek', [0.031, 0.16, -0.2], [0.031, 0.031, 0.04], 0.02),
    ell('cheek', [-0.031, 0.16, -0.2], [0.031, 0.031, 0.04], 0.02),
    cone('muzzle', [0, 0.17, -0.218], [0, 0.152, -0.278], 0.031, 0.012, 0.022),
    ell('nose', [0, 0.153, -0.284], [0.0105, 0.0085, 0.007], 0.005),
    ell('chin', [0, 0.137, -0.236], [0.02, 0.014, 0.032], 0.014),
    // ears: big upright ovals, tilted out and back
    ell('ear', [0.036, 0.232, -0.178], [0.021, 0.04, 0.0065], 0.01, [-0.2, -0.4, -0.32]),
    ell('ear', [-0.036, 0.232, -0.178], [0.021, 0.04, 0.0065], 0.01, [-0.2, 0.4, 0.32]),
    // eye sockets
    ell('socket', [0.033, 0.186, -0.232], [0.0125, 0.0105, 0.0125], 0.006, undefined, true),
    ell('socket', [-0.033, 0.186, -0.232], [0.0125, 0.0105, 0.0125], 0.006, undefined, true),
  ];
  for (const s of [1, -1]) {
    // forelegs: shoulder → elbow → wrist → paw with five toes
    p.push(...chain('arm', [[0.05 * s, 0.11, -0.08], [0.055 * s, 0.055, -0.095], [0.05 * s, 0.018, -0.115]], [0.034, 0.021, 0.014], 0.025));
    p.push(ell('paw', [0.05 * s, 0.009, -0.128], [0.019, 0.008, 0.02], 0.008));
    for (let t = 0; t < 5; t++) {
      const a = (t - 2) * 0.32;
      p.push(cone('toe', [0.05 * s, 0.008, -0.13], [0.05 * s + Math.sin(a) * 0.022, 0.005, -0.13 - Math.cos(a) * 0.02], 0.005, 0.0035, 0.003));
    }
    // hind legs: thigh blended into the rump, hock, long foot
    p.push(ell('thigh', [0.06 * s, 0.11, 0.08], [0.036, 0.052, 0.05], 0.05));
    p.push(...chain('shank', [[0.066 * s, 0.075, 0.1], [0.068 * s, 0.035, 0.12], [0.064 * s, 0.016, 0.1]], [0.028, 0.017, 0.012], 0.02));
    p.push(ell('foot', [0.064 * s, 0.009, 0.075], [0.021, 0.008, 0.036], 0.008));
    for (let t = 0; t < 5; t++) {
      const a = (t - 2) * 0.28;
      p.push(cone('toe', [0.064 * s, 0.008, 0.06], [0.064 * s + Math.sin(a) * 0.022, 0.005, 0.06 - Math.cos(a) * 0.028], 0.005, 0.0035, 0.003));
    }
  }
  // tail: thick and bushy at the root, tapering, the tip curled
  const R = [0.046, 0.041, 0.034, 0.028, 0.022, 0.017, 0.013, 0.01];
  p.push(...chain('tail', TAIL_PTS, R, 0.03));
  return p;
}

function paint(p: Vector3, n: Vector3, part: string): Paint {
  const P = p;
  const mott = fbm(P, 60) - 0.5;
  const fine = fbm(P, 400) - 0.5;
  const up = n.y;
  switch (part) {
    case 'nose':
      return { c: NOSE, fur: 0 };
    case 'ear': {
      const inner = n.z < -0.2 ? 1 : 0; // the open face points forward
      const tip = smooth(0.225, 0.245, p.y);
      return { c: mix(mix(EAR_OUT, EAR_IN, inner * (1 - tip)), hex(0x1e1a19), tip * 0.7), fur: inner ? 0.12 : 0.25, comb: [0, 1, 0] };
    }
    case 'paw':
    case 'foot':
    case 'toe':
      return { c: mix(PAW, SKIN, -up), fur: up > 0.3 ? 0.18 : 0, comb: [0, 0, -1] };
    case 'tail': {
      const u = smooth(0.16, 0.44, p.z); // 0 at the root, 1 at the tip
      const bare = u > 0.55 && up < -0.15 ? 1 : 0; // the bare grasping strip under the tip
      const col = mix(mix(BACK, TAIL, smooth(0, 0.3, u)), hex(0x0e0b0a), 0.3 + mott);
      return { c: bare ? SKIN : col, fur: bare ? 0 : 1.4 - u * 0.3, tip: 1 - smooth(0, 0.3, u), comb: [0.15, -0.4, 1] };
    }
    case 'head':
    case 'cheek':
    case 'muzzle':
    case 'chin':
    case 'neck':
    case 'socket': {
      const underside = smooth(-0.1, -0.6, up);
      const bridge = part === 'muzzle' || part === 'head' ? smooth(0.1, 0.7, up) * smooth(-0.225, -0.26, p.z) : 0;
      const eyeRing = Math.max(0, 1 - Math.hypot(Math.abs(p.x) - 0.033, p.y - 0.186, p.z + 0.232) / 0.022);
      let c = mix(SIDE, BACK, smooth(0.3, 0.9, up));
      c = mix(c, THROAT, underside);
      c = mix(c, MUZZLE, Math.max(bridge * 0.85, eyeRing * 0.75));
      const furLen = part === 'muzzle' ? 0.25 : part === 'neck' ? 0.9 : 0.42;
      return { c: mix(c, hex(0x2a2523), 0.15 + fine * 0.3), fur: furLen, comb: [0, 0.15 * Math.sign(up), 1] };
    }
    default: {
      // body and legs: dark back, grey sides, cream belly
      const belly = smooth(-0.2, -0.65, up) * (part === 'body' ? 1 : 0.6);
      let c = mix(SIDE, BACK, smooth(0.1, 0.85, up));
      c = mix(c, BELLY, belly);
      c = mix(c, hex(0x403c39), Math.max(0, mott * 0.9));
      const leg = part === 'arm' || part === 'shank';
      return { c: mix(c, hex(0x302b29), fine * 0.4 + 0.08), fur: leg ? 0.55 : 1, comb: leg ? [0, -1, 0.2] : [0, -0.25, 1] };
    }
  }
}

export function possumModel(detail = 1): Group {
  const root = new Group();
  root.name = 'pest:possum';
  const body = prims();
  const h = 0.0026 / detail;
  const fur = { shells: Math.round(24 * detail), length: 0.019, spacing: 0.0012, comb: 0.8, thickness: 0.5, tip: 0xb3ada5, tipMix: 0.3, occlusion: 0.65 };
  root.add(furred(sculpt(body, paint, h), fur, {}, sculpt(body, paint, h * 1.8)));
  root.add(eye([0.033, 0.186, -0.232], 0.0122, [1, 0.92, 1]), eye([-0.033, 0.186, -0.232], 0.0122, [1, 0.92, 1]));
  root.add(whiskers([0.011, 0.153, -0.27], 0.08, 6, 0x1a1614, 0.0004));
  const toeTips: V3[] = [];
  for (const s of [1, -1])
    for (let t = 0; t < 5; t++) {
      const a = (t - 2) * 0.32;
      toeTips.push([0.05 * s + Math.sin(a) * 0.024, 0.005, -0.13 - Math.cos(a) * 0.022]);
    }
  root.add(claws(toeTips, 0.008, 0.0018));
  return root;
}
