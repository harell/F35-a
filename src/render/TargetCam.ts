/**
 * Target camera (PiP): a second render of the shared scene from a camera near the designated / locked
 * target, into the small window the HUD lays out (hud/hmd/pip.ts → pipView).
 *
 * Cost control: no render target, no copy — the pass draws straight into a scissored viewport of the
 * main canvas after the world (and the 3D cockpit). The environment re-selects terrain LOD / sky / fog
 * per rendered camera on its own (scene.onBeforeRender), the shadow map rendered for the main view is
 * reused (shadowMap.autoUpdate off for this pass), and the entity renderer re-picks LODs for this
 * viewpoint (EntityRendererApi.prepareView) so a target 30 km away still gets its close-up model.
 */
import { PerspectiveCamera, Vector2, type Scene, type WebGLRenderer } from 'three';
import type { EntityRendererApi } from '../core/contracts';
import type { SimWorld } from '../sim/api';
import { TARGET_CAM_FOV, makePose, targetCamPose, type CamTarget } from './targetCam/pose';

/** The animated window rect (CSS px) the HUD publishes. */
export interface TargetCamRect {
  targetId: number | null;
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  /** Full (open) window height — the open animation crops the view instead of squashing it. */
  h: number;
}

const _size = new Vector2();

export class TargetCam {
  readonly camera = new PerspectiveCamera(TARGET_CAM_FOV, 16 / 9, 0.5, 20_000);
  private readonly pose = makePose();
  /** Last rendered target (debug / tests). */
  lastTargetId: number | null = null;
  private readonly surfaceAt: (x: number, z: number) => number;
  private readonly waterAt: (x: number, z: number) => boolean;

  constructor(
    private readonly world: SimWorld,
    private readonly entities: EntityRendererApi,
  ) {
    this.surfaceAt = (x, z) => world.terrain.surfaceHeightAt(x, z);
    this.waterAt = (x, z) => world.terrain.isWater(x, z);
  }

  /**
   * Render the PiP. Call after the main pass (and the cockpit pass).
   * @param far  far plane of the main camera (the fog reaches the horizon colour there)
   * @returns true if something was drawn
   */
  render(renderer: WebGLRenderer, scene: Scene, rect: TargetCamRect, far: number): boolean {
    this.lastTargetId = null;
    if (rect.targetId === null || rect.vw < 2 || rect.vh < 2) return false;
    const t = this.world.getEntity(rect.targetId);
    if (!t || t.kind === 'missile' || t.kind === 'decoy') return false;
    const cam = this.camera;
    targetCamPose(t as CamTarget, this.world.time, this.pose, this.surfaceAt, this.waterAt);
    cam.position.copy(this.pose.position);
    cam.up.copy(this.pose.up);
    cam.lookAt(this.pose.look);
    // opening animation: crop (narrow vertical FOV) rather than squash
    const k = Math.max(0.01, Math.min(1, rect.vh / Math.max(1, rect.h)));
    const half = (TARGET_CAM_FOV * Math.PI) / 360;
    cam.fov = (2 * Math.atan(Math.tan(half) * k) * 180) / Math.PI;
    cam.aspect = rect.vw / rect.vh;
    cam.far = far;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    this.entities.prepareView?.(cam.position);

    renderer.getSize(_size);
    const yGl = _size.y - (rect.vy + rect.vh);
    const autoShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setScissorTest(true);
    renderer.setScissor(rect.vx, yGl, rect.vw, rect.vh);
    renderer.setViewport(rect.vx, yGl, rect.vw, rect.vh);
    const autoClear = renderer.autoClear;
    renderer.autoClear = true;
    try {
      renderer.render(scene, cam);
    } finally {
      renderer.autoClear = autoClear;
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, _size.x, _size.y);
      renderer.shadowMap.autoUpdate = autoShadow;
    }
    this.lastTargetId = t.id;
    return true;
  }
}
