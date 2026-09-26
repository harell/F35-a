/**
 * Shared constants / types of the terrain generator (pure data, node-safe).
 */
import type { SceneryFeature } from '../../core/contracts';
import type { TheaterId } from '../../core/types';

/** Playable world size (m) — TerrainQuery.size. */
export const WORLD_SIZE = 80_000;
/** Extent covered by the heightfield (m). The extra margin hosts the fade to the outside profile. */
export const HF_EXTENT = 88_000;
/** Border fade (super-ellipse radius, m): terrain → smooth outside profile. */
export const EDGE_FADE_START = 38_500;
export const EDGE_FADE_END = 43_200;

/* Material hints written per sample by the theater generators (consumed by the colour baker). */
export const MAT_NONE = 0;
export const MAT_DUNE = 1; // aux = sand-sea intensity
export const MAT_WADI = 2; // aux = channel strength
export const MAT_SALT = 3; // sabkha / salt flat
export const MAT_MESA = 4; // aux = plateau strength
export const MAT_BEACH = 5;
export const MAT_VOLCANIC = 6; // aux = volcanic intensity
export const MAT_REEF = 7;
export const MAT_ICE = 8; // frozen lake
export const MAT_RIVER = 9; // valley floor / river plain, aux = strength
export const MAT_JUNGLE = 10; // aux = density
export const MAT_ROCKY = 11; // bare mountain rock, aux = strength
export const MAT_TUNDRA = 12;
export const MAT_URBAN = 13; // aux = built-up density
export const MAT_BUSH = 14; // native bush / dense forest, aux = density
export const MAT_CONE = 15; // grassy volcanic cone (Auckland)

/** Scratch record the per-sample generator writes material hints into. */
export interface SampleOut {
  mat: number;
  aux: number;
}

export interface TheaterGenerator {
  /** Terrain height (m MSL) at world (x, z); may set out.mat / out.aux. */
  height(x: number, z: number, out: SampleOut): number;
  /** Smooth "outside the world" profile (m). Must be low-frequency — it's clamped outward forever. */
  edge(x: number, z: number): number;
}

/** Area that must be dry land (features / pads). */
export interface Anchor {
  x: number;
  z: number;
  /** Radius that must be land (m). */
  r: number;
  port: boolean;
}

export interface TerrainSpec {
  theater: TheaterId;
  seed: number;
  /** Samples per side (power of two: 256 .. 2048). */
  resolution: number;
  features: SceneryFeature[];
  pads: { x: number; z: number; radius: number }[];
}

/** Flatten footprint of a scenery feature (local frame: +Z along `rotation` heading). */
export interface Footprint {
  kind: 'rect' | 'circle';
  /** Centre (world m). */
  x: number;
  z: number;
  /** Rect half extents (m): across (local X) and along (local Z) the heading. */
  halfW: number;
  halfL: number;
  /** Circle radius (m). */
  radius: number;
  /** Heading (rad, 0 = north, clockwise). */
  heading: number;
  /** Blend distance outside the core (m). */
  blend: number;
  /** 0..1 flatten strength in the core. */
  strength: number;
  /** Minimum target height (m) — keeps airfields/towns out of the sea. */
  minLevel: number;
  flatten: boolean;
}
