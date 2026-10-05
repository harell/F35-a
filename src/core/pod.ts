/**
 * Targeting pod (EOTS) view of the target camera window (#199) — what the HUD (hud/hmd/pip.ts) and the
 * 3D pass (render/targetCam/pose.ts podCamPose) share: which targets get the pod view and its zoom steps.
 *
 * Ground targets and SAM sites are shown as a pod sees them: looking along the line of sight from the
 * player's jet, at one of a few fixed zoom steps. Aircraft keep the cinematic shot near the target, and
 * ships their wide orbit (a 280 m hull reads better from its side than end-on down the pod's line).
 */

/** A pod zoom step: its name on the window and how much it shows (m, top to bottom of the frame). */
export interface PodZoomStep {
  readonly name: string;
  readonly span: number;
}

/**
 * Zoom steps, widest first (a tap on the window cycles them). WIDE: a site and its surroundings; NARROW:
 * one vehicle or building; ZOOM: about 2 m of ground, so a 0.3 m object fills ~15 % of the window height
 * (≈ 12 px in the 82 px HMD window, ≥ 8 px in the smallest 54 px one) at any slant range.
 */
export const POD_ZOOM: readonly PodZoomStep[] = [
  { name: 'WIDE', span: 150 },
  { name: 'NARROW', span: 30 },
  { name: 'ZOOM', span: 2 },
];

/** The step a new pod shot opens at. */
export const POD_ZOOM_DEFAULT = 1;

/** Next zoom step (WIDE → NARROW → ZOOM → WIDE). */
export function nextPodZoom(i: number): number {
  return (i + 1) % POD_ZOOM.length;
}

/** Does the window show `t` through the pod (ground targets other than ships, SAM sites)? */
export function isPodTarget(t: { readonly kind: string; readonly type?: unknown }): boolean {
  return t.kind === 'sam' || (t.kind === 'ground' && t.type !== 'ship');
}
