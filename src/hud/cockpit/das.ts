/**
 * F35-A — DAS see-through window (#116, finding 1.2-i / the pilot's suggestion 1).
 *
 * In the cockpit view anything more than ~5° below the flight path is behind the glare shield and the
 * PCD, so a low bandit or a JDAM / SDB target was only an off-screen cue. The real jet's helmet shows
 * the Distributed Aperture System's picture through the airframe; on a phone that is a round window cut
 * through the panel around the designated target: the cockpit pass writes depth over a disc at the
 * near plane before anything else (no colour), so the panel and the PCD aren't drawn there and the
 * world shows through. The HMD then draws the target box inside it and rings it with a DAS frame.
 *
 * The cockpit (Cockpit.update) decides each frame whether the window is open and where; the HUD, drawn
 * after it in the same frame, reads `dasWindow`. One draw call while it is open, none otherwise.
 */
import { CircleGeometry, Mesh, MeshBasicMaterial, type PerspectiveCamera } from 'three';

/** The window this frame, in CSS px of the viewport (`active` false = closed). */
export const dasWindow = { active: false, id: -1, x: 0, y: 0, r: 0 };

/** Window radius (CSS px) for a viewport `h` px tall: 58 px at 390, scaled like the HMD's unit. */
export function dasRadius(h: number): number {
  return 58 * Math.max(0.85, Math.min(1.6, h / 390));
}

/** Does the open window cover the point (CSS px)? `inset` shrinks it (keep a symbol fully inside). */
export function inDasWindow(x: number, y: number, inset = 0): boolean {
  const d = dasWindow;
  if (!d.active) return false;
  const r = d.r - inset;
  return r > 0 && (x - d.x) * (x - d.x) + (y - d.y) * (y - d.y) < r * r;
}

/** Distance in front of the cockpit camera the mask disc sits at (m): just past the 0.02 m near plane. */
const MASK_DIST = 0.025;

/** The depth-only disc that cuts the window through the cockpit (child of the cockpit camera). */
export class DasMask {
  readonly mesh: Mesh;
  private readonly mat: MeshBasicMaterial;

  constructor() {
    this.mat = new MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true });
    this.mesh = new Mesh(new CircleGeometry(1, 40), this.mat);
    this.mesh.name = 'dasMask';
    this.mesh.renderOrder = -100; // before every cockpit part (the pass starts on a cleared depth buffer)
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Put the disc over `dasWindow` (or hide it) for a camera showing a `viewW` × `viewH` px viewport. */
  place(camera: PerspectiveCamera, viewW: number, viewH: number): void {
    const d = dasWindow;
    this.mesh.visible = d.active;
    if (!d.active) return;
    const t = Math.tan((camera.fov * Math.PI) / 360) * MASK_DIST;
    const nx = (d.x / viewW) * 2 - 1;
    const ny = 1 - (d.y / viewH) * 2;
    this.mesh.position.set(nx * t * camera.aspect, ny * t, -MASK_DIST);
    this.mesh.scale.setScalar((d.r / (viewH / 2)) * t);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
