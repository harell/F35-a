/**
 * The stoat (g03, #200): a low-poly model at true scale, 0.28 m of body and a 0.10 m tail with the
 * black tip that marks the species; brown back, cream belly. Front = -Z, origin on the ground between
 * its feet. Its parts are separate nodes the renderer poses every frame (render/visuals/stoatPose.ts):
 *  'stoat:hips'   pivot over the hind feet: the whole body (it rears up on it into the periscope stance)
 *  'stoat:head'   pivot at the neck (it looks up at the jet)
 *  'stoat:tail'   pivot at the root of the tail (bottle-brush: it puffs out)
 *  'stoat:legF' / 'stoat:legH'  front / hind leg pairs (the bounding gait)
 * A few hundred triangles; never the target of a close-up beyond the pod's ZOOM step.
 */
import { BufferGeometry, Group, Object3D } from 'three';
import { cylinder, cylinderZ, ellipsoid, place } from './geom/core';
import { meshFrom } from './vehicles';

const BROWN = 0x7a4a26;
const CREAM = 0xeadcc0;
const BLACK = 0x15110e;

/** Body length (m, nose to the root of the tail) and the tail's length. */
export const STOAT_DIMS = { body: 0.28, tail: 0.1, height: 0.09 } as const;

function node(name: string, geos: BufferGeometry[], pos: [number, number, number]): Object3D {
  const o = new Object3D();
  o.name = name;
  o.position.set(...pos);
  if (geos.length) o.add(meshFrom(geos, 'vehicle'));
  return o;
}

/** The stoat's prototype root (posable nodes, see the header). */
export function stoatModel(): Group {
  const root = new Group();
  // the hips pivot sits over the hind feet, 0.045 m up and 0.10 m behind the middle
  const hips = node('stoat:hips', [], [0, 0.045, 0.1]);
  // body: a long, slim ellipsoid (back brown, belly cream), from 0.24 m ahead of the hips to the tail root
  hips.add(
    node(
      'stoat:body',
      [place(ellipsoid(0.034, 0.03, 0.15, 10, 6, BROWN), [0, 0.012, -0.1]), place(ellipsoid(0.026, 0.018, 0.13, 8, 4, CREAM), [0, -0.006, -0.11])],
      [0, 0, 0],
    ),
  );
  // head on a short neck, ears, the dark nose and eyes
  const head = node(
    'stoat:head',
    [
      place(ellipsoid(0.026, 0.024, 0.036, 8, 6, BROWN), [0, 0.006, -0.026]),
      place(ellipsoid(0.016, 0.012, 0.02, 6, 4, CREAM), [0, -0.008, -0.034]),
      place(ellipsoid(0.006, 0.006, 0.006, 4, 3, BLACK), [0, 0.006, -0.06]),
      place(ellipsoid(0.004, 0.004, 0.004, 4, 3, BLACK), [0.012, 0.016, -0.04]),
      place(ellipsoid(0.004, 0.004, 0.004, 4, 3, BLACK), [-0.012, 0.016, -0.04]),
      place(ellipsoid(0.008, 0.009, 0.004, 5, 3, BROWN), [0.016, 0.028, -0.014]),
      place(ellipsoid(0.008, 0.009, 0.004, 5, 3, BROWN), [-0.016, 0.028, -0.014]),
    ],
    [0, 0.024, -0.235],
  );
  hips.add(head);
  // tail: brown, then the black tip
  const tail = node('stoat:tail', [cylinderZ(0.011, 0.012, 0, 0.065, 6, BROWN), place(ellipsoid(0.014, 0.014, 0.024, 6, 4, BLACK), [0, 0, 0.08])], [0, 0.018, 0.035]);
  tail.rotation.x = 0.35; // carried slightly up
  hips.add(tail);
  // legs: short, two pairs
  const legs = (name: string, z: number) =>
    node(name, [place(cylinder(0.007, 0.006, 0.045, 5, BROWN), [0.018, -0.0225, 0]), place(cylinder(0.007, 0.006, 0.045, 5, BROWN), [-0.018, -0.0225, 0])], [0, 0, z]);
  hips.add(legs('stoat:legH', 0));
  hips.add(legs('stoat:legF', -0.19));
  root.add(hips);
  return root;
}
