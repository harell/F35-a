/**
 * Stoat (Mustela erminea), the Codex close-up (the in-game target is render/models/stoat.ts): a long,
 * low, sinuous body (0.28 m) on short legs, flat wedge head with small rounded ears, chestnut back with a
 * sharp straight line to the cream belly, chin and inner legs, and the black-tipped tail that tells it
 * from a weasel. Metres; front = -Z, up = +Y, origin on the ground under the body.
 */
import { Group, type Vector3 } from 'three';
import { furred } from './fur';
import { claws, eye, whiskers } from './parts';
import { chain, cone, ell, fbm, hex, mix, sculpt, smooth, type Paint, type Prim, type V3 } from './sdf';

const BROWN = hex(0x7a4824);
const DARK = hex(0x5a3519);
const CREAM = hex(0xf0e3c4);
const BLACK = hex(0x14100d);
const NOSE = hex(0x2a1d18);

function prims(): Prim[] {
  const p: Prim[] = [
    // the long body: chest, a slightly arched middle, hips
    ell('body', [0, 0.05, -0.075], [0.025, 0.027, 0.05], 0),
    ell('body', [0, 0.056, 0.0], [0.027, 0.029, 0.07], 0.025),
    ell('body', [0, 0.056, 0.075], [0.028, 0.03, 0.045], 0.025),
    cone('neck', [0, 0.054, -0.115], [0, 0.064, -0.148], 0.022, 0.02, 0.015),
    ell('head', [0, 0.068, -0.163], [0.021, 0.017, 0.025], 0.012),
    ell('cheek', [0.012, 0.062, -0.17], [0.012, 0.011, 0.016], 0.008),
    ell('cheek', [-0.012, 0.062, -0.17], [0.012, 0.011, 0.016], 0.008),
    cone('muzzle', [0, 0.066, -0.178], [0, 0.0605, -0.203], 0.013, 0.0062, 0.008),
    ell('nose', [0, 0.0607, -0.2065], [0.0042, 0.0034, 0.003], 0.002),
    ell('chin', [0, 0.056, -0.184], [0.007, 0.004, 0.012], 0.005),
    // small rounded ears, set low and wide
    ell('ear', [0.017, 0.081, -0.155], [0.0085, 0.0078, 0.0026], 0.004, [-0.2, -0.7, -0.5]),
    ell('ear', [-0.017, 0.081, -0.155], [0.0085, 0.0078, 0.0026], 0.004, [-0.2, 0.7, 0.5]),
    ell('socket', [0.0125, 0.0728, -0.181], [0.0042, 0.0034, 0.0042], 0.002, undefined, true),
    ell('socket', [-0.0125, 0.0728, -0.181], [0.0042, 0.0034, 0.0042], 0.002, undefined, true),
  ];
  for (const s of [1, -1]) {
    p.push(...chain('arm', [[0.017 * s, 0.045, -0.085], [0.02 * s, 0.022, -0.09], [0.018 * s, 0.006, -0.097]], [0.01, 0.0065, 0.0045], 0.008));
    p.push(ell('foot', [0.018 * s, 0.0035, -0.102], [0.0065, 0.0032, 0.008], 0.003));
    p.push(ell('thigh', [0.02 * s, 0.046, 0.08], [0.014, 0.021, 0.022], 0.018));
    p.push(...chain('shank', [[0.022 * s, 0.03, 0.09], [0.022 * s, 0.012, 0.096], [0.021 * s, 0.005, 0.085]], [0.009, 0.0055, 0.004], 0.006));
    p.push(ell('foot', [0.021 * s, 0.0035, 0.07], [0.007, 0.0032, 0.015], 0.003));
  }
  // tail: slim, carried up a little, bushier at the black tip
  p.push(...chain('tail', [[0, 0.062, 0.11], [0, 0.07, 0.15], [0, 0.077, 0.185], [0, 0.077, 0.215], [0, 0.072, 0.232]], [0.0085, 0.008, 0.0085, 0.009, 0.004], 0.01));
  return p;
}

function paint(p: Vector3, n: Vector3, part: string): Paint {
  const mott = fbm(p, 150) - 0.5;
  const up = n.y;
  // the belly line: a sharp, straight boundary along the flanks
  const cream = smooth(0.05, -0.12, up + (p.y - 0.05) * 1.5);
  switch (part) {
    case 'nose':
      return { c: NOSE, fur: 0 };
    case 'ear':
      return { c: mix(BROWN, CREAM, n.z < -0.3 ? 0.35 : 0), fur: 0.35, comb: [0, 1, 0] };
    case 'tail': {
      const tip = smooth(0.19, 0.2, p.z);
      return { c: mix(BROWN, BLACK, tip), fur: 0.7 + tip * 1.1, tip: 0, comb: [0, 0.1, 1] };
    }
    case 'foot':
      return { c: mix(BROWN, CREAM, 0.3), fur: up > 0.3 ? 0.35 : 0.1, comb: [0, 0, -1] };
    case 'head':
    case 'cheek':
    case 'muzzle':
    case 'chin':
    case 'neck':
    case 'socket': {
      // cream upper lip, chin and throat
      const lip = part === 'chin' || (part === 'muzzle' && up < 0.1) ? 1 : 0;
      const throat = smooth(-0.05, -0.4, up);
      const c = mix(mix(BROWN, DARK, smooth(0.5, 1, up) * 0.4), CREAM, Math.max(lip, throat));
      return { c: mix(c, hex(0x3a2412), 0.05 + mott * 0.2), fur: part === 'muzzle' ? 0.3 : 0.5, comb: [0, 0.1 * Math.sign(up), 1] };
    }
    default: {
      const leg = part === 'arm' || part === 'shank' || part === 'thigh';
      const inner = leg && n.x * Math.sign(p.x) < -0.2 ? 1 : 0;
      const c = mix(mix(BROWN, DARK, smooth(0.6, 1, up) * 0.35 + mott * 0.4), CREAM, Math.max(cream * (part === 'body' ? 1 : 0.8), inner));
      return { c, fur: leg ? 0.55 : 1, comb: leg ? [0, -1, 0.2] : [0, -0.15, 1] };
    }
  }
}

export function stoatHeroModel(detail = 1): Group {
  const root = new Group();
  root.name = 'pest:stoat';
  const body = prims();
  const h = 0.0013 / detail;
  const fur = { shells: Math.round(20 * detail), length: 0.0075, spacing: 0.0005, comb: 0.85, thickness: 0.5, occlusion: 0.55 };
  root.add(furred(sculpt(body, paint, h), fur, {}, sculpt(body, paint, h * 1.8)));
  root.add(eye([0.0128, 0.0733, -0.182], 0.0042), eye([-0.0128, 0.0733, -0.182], 0.0042));
  root.add(whiskers([0.0045, 0.0615, -0.198], 0.042, 6, 0xe8e0d4, 0.00016));
  const tips: V3[] = [];
  for (const s of [1, -1]) for (const dx of [-0.004, -0.0013, 0.0013, 0.004]) tips.push([0.018 * s + dx, 0.002, -0.109]);
  root.add(claws(tips, 0.0028, 0.0006, 0xd9cfc2));
  return root;
}
