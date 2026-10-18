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
 * one vehicle or building; ZOOM: about 1 m of ground, 1.25 m on an animal (podSpan), so g03's 0.38 m
 * stoat fills about a third of the window at any slant range, with the ground round it in view.
 */
export const POD_ZOOM: readonly PodZoomStep[] = [
  { name: 'WIDE', span: 150 },
  { name: 'NARROW', span: 30 },
  { name: 'ZOOM', span: 1 },
];

/**
 * ZOOM's span (m) on an animal under a metre across (g03's stoat, t07's rats). At 0.5 m (playtest r2 F6:
 * at 1 m the stoat was a 10 × 20 px blob in a window that was smaller then) the animal filled the window
 * and a running rat dragged the ground through it several frames a second, with nothing round it to say
 * whether it was on a roof or in the street (owner, 2026-10-18). At 1.25 m a rat is a dark shape across
 * the crosshair's gap on its patch of road or roof, the kerb or the roof's edge in view.
 */
export const POD_ZOOM_SMALL = 1.25;

/** An animal under a metre across (g03's stoat, t07's rats): ZOOM closes in on it, and its pod shot opens at ZOOM. */
export function isPodAnimal(radius: number): boolean {
  return radius < 0.5;
}

/** The span (m) zoom step `i` shows of a target of `radius` m: POD_ZOOM's, closer at ZOOM on an animal. */
export function podSpan(i: number, radius: number): number {
  const step = POD_ZOOM[i] ?? POD_ZOOM[POD_ZOOM_DEFAULT];
  return step.name === 'ZOOM' && isPodAnimal(radius) ? POD_ZOOM_SMALL : step.span;
}

/** The step a new pod shot opens at (an animal's opens at POD_ZOOM_ANIMAL: hud/hmd/pip.ts stepPod). */
export const POD_ZOOM_DEFAULT = 1;

/**
 * The step an animal's pod shot opens at: ZOOM. At NARROW a 20 cm rat is a few pixels, and players
 * didn't know a tap zooms the window (playtest 2026-10-11).
 */
export const POD_ZOOM_ANIMAL = 2;

/** Next zoom step (WIDE → NARROW → ZOOM → WIDE). */
export function nextPodZoom(i: number): number {
  return (i + 1) % POD_ZOOM.length;
}

/** Does the window show `t` through the pod (ground targets other than ships, SAM sites)? */
export function isPodTarget(t: { readonly kind: string; readonly type?: unknown }): boolean {
  return t.kind === 'sam' || (t.kind === 'ground' && t.type !== 'ship');
}
