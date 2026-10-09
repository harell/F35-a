/**
 * Poses t07's sewer rats (render/models/rat.ts) from their sim state (sim/stoat.ts StoatState, the
 * runner rats share with the stoat):
 *  - running: a low, quick scurry (small bobs, the leg pairs swinging in turn, the tail swaying);
 *  - stopped at a drain: nose down, sniffing;
 *  - targeted at a stop (StoatState.alert → 1): it sits up on its haunches, front paws off the
 *    ground, and turns its head up towards the jet;
 *  - swimming (StoatState.swimming): sunk to the waterline with only its head and the top of its back
 *    showing, nose up, legs paddling, tail trailing and sculling behind.
 * Pure function of the state and the time: no allocations.
 */
import type { Object3D } from 'three';
import type { StoatState } from '../../sim/stoat';

export interface RatNodes {
  hips: Object3D;
  head: Object3D;
  tail: Object3D;
  legF: Object3D;
  legH: Object3D;
}

/** The posable nodes of a rat model, or null when it isn't one. */
export function ratNodes(root: Object3D): RatNodes | null {
  const get = (n: string) => root.getObjectByName(`rat:${n}`);
  const hips = get('hips');
  const head = get('head');
  const tail = get('tail');
  const legF = get('legF');
  const legH = get('legH');
  return hips && head && tail && legF && legH ? { hips, head, tail, legF, legH } : null;
}

/** Height of the hips pivot (m): standing, and swimming (sunk to the waterline). */
export const RAT_HIPS_Y = 0.04;
export const RAT_SWIM_Y = -0.012;
/** Body pitch when it sits up (rad). */
export const SIT_PITCH = 0.95;

/** Pose the rat's nodes for `s` at sim time `time` (s); `seed` desynchronises two rats. */
export function poseRat(n: RatNodes, s: StoatState, time: number, seed = 0): void {
  const g = s.gait;
  if (s.swimming) {
    n.hips.position.y = RAT_SWIM_Y + 0.004 * Math.sin(g * 2);
    n.hips.rotation.set(-0.12, 0, 0.05 * Math.sin(g));
    n.head.rotation.set(0.3, 0.12 * Math.sin(g * 0.5 + seed), 0);
    n.tail.rotation.set(0.05, 0.35 * Math.sin(g * 1.3), 0);
    n.legF.rotation.x = Math.sin(g * 2) * 0.9;
    n.legH.rotation.x = -Math.sin(g * 2) * 0.9;
    return;
  }
  const a = s.alert;
  const running = s.phase === 'run';
  const bob = running ? Math.abs(Math.sin(g)) : 0;
  const sniff = running ? 0 : 0.5 + 0.5 * Math.sin(time * 9 + seed * 10);
  n.hips.position.y = RAT_HIPS_Y + bob * 0.008;
  // sit up on the haunches while alert, otherwise a slight pitch with the scurry or nose down to sniff
  n.hips.rotation.set(a * SIT_PITCH + (1 - a) * (running ? Math.sin(g) * 0.08 : -0.08 * sniff), 0, 0);
  // the head looks up at the jet while alert, down to the drain otherwise
  n.head.rotation.set(a * 0.5 + (1 - a) * (running ? 0 : -0.3 * sniff), a * 0.4 * Math.sin(time * 2.1 + seed * 3), 0);
  // the tail sways while it runs, lies flat (props it up) while it sits
  n.tail.rotation.set(-0.12 - a * 0.6, running ? Math.sin(g * 0.5) * 0.3 : 0.1 * Math.sin(time + seed), 0);
  n.legF.rotation.x = running ? Math.sin(g) * 0.8 : -a * 0.6;
  n.legH.rotation.x = running ? -Math.sin(g) * 0.8 : -a * SIT_PITCH;
}
