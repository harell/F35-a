/**
 * Poses g03's stoat (render/models/stoat.ts) from its sim state (sim/runner.ts RunnerState):
 *  - running: a bounding gait (the body bobs and pitches, the leg pairs swing in turn);
 *  - stopped at a bait station: nose down, sniffing;
 *  - targeted at a stop (RunnerState.alert → 1): it rears up on its hind legs into the "periscope"
 *    stance, turns its head up towards the jet, its tail puffs out into a bottle-brush, and it
 *    dithers on the spot, shuffling round a little.
 * Pure function of the state and the time: no allocations.
 */
import type { Object3D } from 'three';
import type { RunnerState } from '../../sim/runner';

export interface StoatNodes {
  hips: Object3D;
  head: Object3D;
  tail: Object3D;
  legF: Object3D;
  legH: Object3D;
}

/** The posable nodes of a stoat model, or null when it isn't one. */
export function stoatNodes(root: Object3D): StoatNodes | null {
  const get = (n: string) => root.getObjectByName(`stoat:${n}`);
  const hips = get('hips');
  const head = get('head');
  const tail = get('tail');
  const legF = get('legF');
  const legH = get('legH');
  return hips && head && tail && legF && legH ? { hips, head, tail, legF, legH } : null;
}

/** The periscope stance's body pitch (rad): nearly upright. */
export const PERISCOPE_PITCH = 1.3;
/** Tail puff at full alert (× its thickness). */
export const TAIL_PUFF = 1.9;

/** Pose the stoat's nodes for `s` at sim time `time` (s); `seed` desynchronises two stoats. */
export function poseStoat(n: StoatNodes, s: RunnerState, time: number, seed = 0): void {
  const a = s.alert;
  const running = s.phase === 'run';
  // bounding gait while running (s.gait advances with its pace), a sniff while stopped
  const g = s.gait;
  const bound = running ? Math.abs(Math.sin(g)) : 0;
  const sniff = running ? 0 : 0.5 + 0.5 * Math.sin(time * 6 + seed * 10);
  n.hips.position.y = 0.045 + bound * 0.02;
  // rear up on the hind legs (the periscope), otherwise pitch with the bounds or nose down to sniff
  n.hips.rotation.x = a * PERISCOPE_PITCH + (1 - a) * (running ? Math.sin(g) * 0.18 : -0.1 * sniff);
  // dither: shuffle round on the spot while alert
  n.hips.rotation.y = a * 0.25 * Math.sin(time * 3.1 + seed * 7) * Math.sin(time * 1.3 + seed);
  // the head looks up at the sky (on top of the body's pitch) while alert; down to sniff otherwise
  n.head.rotation.x = a * 0.45 + (1 - a) * (running ? 0.05 : -0.25 * sniff);
  n.head.rotation.y = a * 0.35 * Math.sin(time * 2.3 + seed * 3);
  // bottle-brush tail: thicker and stiffer (raised) when alarmed
  const puff = 1 + (TAIL_PUFF - 1) * a;
  n.tail.scale.set(puff, puff, 1);
  n.tail.rotation.x = 0.35 + a * 0.5 + (running ? Math.sin(g + 1) * 0.25 : 0);
  // legs: the pairs swing in turn while running; straight down at a stop (hind legs carry it upright)
  n.legF.rotation.x = running ? Math.sin(g) * 0.7 : -a * 0.9;
  n.legH.rotation.x = running ? -Math.sin(g) * 0.7 : -a * PERISCOPE_PITCH;
}
