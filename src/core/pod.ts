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
 * one vehicle or building; ZOOM: about 1 m of ground, half that on an animal (podSpan), so g03's 0.38 m
 * stoat fills about half the window at any slant range.
 */
export const POD_ZOOM: readonly PodZoomStep[] = [
  { name: 'WIDE', span: 150 },
  { name: 'NARROW', span: 30 },
  { name: 'ZOOM', span: 1 },
];

/**
 * ZOOM's span (m) on an animal under a metre across (g03's stoat, t07's rats): at 1 m the 0.38 m stoat
 * was a 10 × 20 px dark blob in the window (playtest r2 F6); at 0.5 m it fills about half of it.
 */
export const POD_ZOOM_SMALL = 0.5;

/** The span (m) zoom step `i` shows of a target of `radius` m: POD_ZOOM's, closer at ZOOM on a small one. */
export function podSpan(i: number, radius: number): number {
  const step = POD_ZOOM[i] ?? POD_ZOOM[POD_ZOOM_DEFAULT];
  return step.name === 'ZOOM' && radius < 0.5 ? POD_ZOOM_SMALL : step.span;
}

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
