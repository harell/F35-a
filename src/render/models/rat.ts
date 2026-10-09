/**
 * The sewer rat (t07 "Small Targets"): a low-poly Norway rat at true scale, 0.22 m of head and
 * body and a 0.20 m scaly tail, grey-brown back, paler belly, pink ears, feet and tail. Front = -Z,
 * origin on the ground between its feet. Like the stoat (models/stoat.ts) its parts are separate
 * nodes the renderer poses every frame (render/visuals/ratPose.ts):
 *  'rat:hips'   pivot over the hind feet: the whole body (it sits up on it; it sinks on it to swim)
 *  'rat:head'   pivot at the neck (sniffing, looking up at the jet)
 *  'rat:tail'   pivot at the root of the tail (it sways, and trails behind it in the water)
 *  'rat:legF' / 'rat:legH'  front / hind leg pairs (the scurry, the paddle)
 * A few hundred triangles; never the target of a close-up beyond the pod's ZOOM step.
 */
import { BufferGeometry, Group, Object3D } from 'three';
import { cylinder, cylinderZ, ellipsoid, place } from './geom/core';
import { meshFrom } from './vehicles';

const BACK = 0x5a4c3e;
const BELLY = 0xa89a86;
const PINK = 0xc9928a;
const BLACK = 0x120f0d;

/** Body length (m, nose to the root of the tail), the tail's length and the back's height. */
export const RAT_DIMS = { body: 0.22, tail: 0.2, height: 0.08 } as const;

function node(name: string, geos: BufferGeometry[], pos: [number, number, number]): Object3D {
  const o = new Object3D();
  o.name = name;
  o.position.set(...pos);
  if (geos.length) o.add(meshFrom(geos, 'vehicle'));
  return o;
}

/** The rat's prototype root (posable nodes, see the header). */
export function ratModel(): Group {
  const root = new Group();
  // the hips pivot sits over the hind feet, 0.04 m up and 0.06 m behind the middle
  const hips = node('rat:hips', [], [0, 0.04, 0.06]);
  // body: a stout pear, broad at the haunches (back grey-brown, belly paler)
  hips.add(
    node(
      'rat:body',
      [
        place(ellipsoid(0.042, 0.036, 0.075, 10, 6, BACK), [0, 0.006, -0.03]),
        place(ellipsoid(0.034, 0.03, 0.06, 10, 6, BACK), [0, 0.004, -0.1]),
        place(ellipsoid(0.03, 0.02, 0.09, 8, 4, BELLY), [0, -0.012, -0.06]),
      ],
      [0, 0, 0],
    ),
  );
  // head: a blunt wedge with the pink nose, dark eyes and round pink ears
  const head = node(
    'rat:head',
    [
      place(ellipsoid(0.022, 0.02, 0.04, 8, 6, BACK), [0, 0, -0.03]),
      place(ellipsoid(0.005, 0.005, 0.005, 4, 3, PINK), [0, -0.004, -0.07]),
      place(ellipsoid(0.004, 0.004, 0.004, 4, 3, BLACK), [0.013, 0.008, -0.04]),
      place(ellipsoid(0.004, 0.004, 0.004, 4, 3, BLACK), [-0.013, 0.008, -0.04]),
      place(ellipsoid(0.01, 0.011, 0.003, 6, 3, PINK), [0.015, 0.02, -0.018]),
      place(ellipsoid(0.01, 0.011, 0.003, 6, 3, PINK), [-0.015, 0.02, -0.018]),
    ],
    [0, 0.012, -0.155],
  );
  hips.add(head);
  // tail: long, thick at the root, tapering, pinkish-grey
  const tail = node('rat:tail', [cylinderZ(0.009, 0.003, 0, RAT_DIMS.tail, 6, PINK)], [0, 0.0, 0.04]);
  tail.rotation.x = -0.12; // carried just off the ground
  hips.add(tail);
  // legs: short, two pairs, pink feet
  const legs = (name: string, z: number) =>
    node(
      name,
      [
        place(cylinder(0.008, 0.006, 0.038, 5, BACK), [0.022, -0.019, 0]),
        place(cylinder(0.008, 0.006, 0.038, 5, BACK), [-0.022, -0.019, 0]),
        place(ellipsoid(0.006, 0.003, 0.009, 4, 3, PINK), [0.022, -0.038, -0.004]),
        place(ellipsoid(0.006, 0.003, 0.009, 4, 3, PINK), [-0.022, -0.038, -0.004]),
      ],
      [0, 0, z],
    );
  hips.add(legs('rat:legH', 0));
  hips.add(legs('rat:legF', -0.12));
  root.add(hips);
  return root;
}
