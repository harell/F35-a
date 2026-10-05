/**
 * The Codex pests: high-detail models of New Zealand's invasive pests for the Codex's close-up viewer
 * (not the in-game targets: g03's low-poly stoat is render/models/stoat.ts). Each is sculpted from
 * signed-distance primitives (sdf.ts), furred with shells (fur.ts) and painted per vertex, with
 * generated textures for the wasp's wings and eyes and the rat's tail (textures.ts).
 * True scale in metres; front = -Z, up = +Y, origin on the ground under the animal.
 * Building one takes a few hundred milliseconds: build on demand and keep it.
 */
import type { Group } from 'three';
import { possumModel } from './possum';
import { ratModel } from './rat';
import { stoatHeroModel } from './stoat';
import { waspModel } from './wasp';

export type PestId = 'possum' | 'rat' | 'stoat' | 'wasp';

export interface PestInfo {
  id: PestId;
  name: string;
  latin: string;
  /** Head and body length (m), tail excluded. */
  body: number;
  /** Typical adult mass (kg). */
  mass: [number, number];
}

export const PESTS: PestInfo[] = [
  { id: 'possum', name: 'Brushtail possum', latin: 'Trichosurus vulpecula', body: 0.4, mass: [1.4, 6.4] },
  { id: 'rat', name: 'Ship rat', latin: 'Rattus rattus', body: 0.18, mass: [0.12, 0.16] },
  { id: 'stoat', name: 'Stoat', latin: 'Mustela erminea', body: 0.28, mass: [0.2, 0.36] },
  { id: 'wasp', name: 'German wasp', latin: 'Vespula germanica', body: 0.014, mass: [0.00008, 0.00012] },
];

/** Build a pest's model. `detail` scales the mesh resolution and fur shells (1 = Codex quality). */
export function pestModel(id: PestId, detail = 1): Group {
  switch (id) {
    case 'possum':
      return possumModel(detail);
    case 'rat':
      return ratModel(detail);
    case 'stoat':
      return stoatHeroModel(detail);
    case 'wasp':
      return waspModel(detail);
  }
}
