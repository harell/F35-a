/**
 * Target camera (PiP): a second render of the shared scene from a camera near the designated / locked
 * target, into the small window the HUD lays out (hud/hmd/pip.ts → pipView).
 *
 * Cost control: no render target, no copy — the pass draws straight into a scissored viewport of the
 * main canvas after the world (and the 3D cockpit). The environment re-selects terrain LOD / sky / fog
 * per rendered camera on its own (scene.onBeforeRender), the shadow map rendered for the main view is
 * reused (shadowMap.autoUpdate off for this pass), and the entity renderer re-picks LODs for this
 * viewpoint (EntityRendererApi.prepareView) so a target 30 km away still gets its close-up model.
 * On low quality the pass no longer draws the whole scene again (#66): it gets a short far plane
 * (QualitySettings.targetCamRange past the target, or far enough to keep the ground in the frame for a
 * high target, see targetCamFar) that culls distant terrain patches and models, and it leaves out the static scenery detail (EnvironmentApi.targetCamOmit: the
 * city, roads, scatter and night lights are merged world-wide meshes a far plane can't cull).
 * The Sky Tower shot (pipView.landmark: the tower hit or collapsing) keeps the tower's own visual
 * (EnvironmentApi.targetCamLandmarks) when its scenery group is left out.
 */
import { PerspectiveCamera, Vector2, Vector3, type Object3D, type Scene, type WebGLRenderer } from 'three';
import type { EntityRendererApi } from '../core/contracts';
import type { QualitySettings } from '../core/types';
import type { SimWorld } from '../sim/api';
import { TARGET_CAM_FOV, landmarkCamPose, makePose, targetCamFar, targetCamGroundDepth, targetCamPose, type CamLandmark, type CamTarget } from './targetCam/pose';

/** The animated window rect (CSS px) the HUD publishes. */
export interface TargetCamRect {
  targetId: number | null;
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  /** Full (open) window height — the open animation crops the view instead of squashing it. */
  h: number;
  /** A landmark shot (the Sky Tower hit / collapsing) instead of targetId. */
  landmark?: (CamLandmark & { readonly id: string }) | null;
}

/** Is `a` the object `o` or one of its ancestors? */
function holds(a: Object3D, o: Object3D): boolean {
  for (let n: Object3D | null = o; n; n = n.parent) if (n === a) return true;
  return false;
}

const _size = new Vector2();
const _dir = new Vector3();
const NONE: readonly Object3D[] = [];

/**
 * What the PiP pass leaves out for a quality preset: the environment's targetCamOmit list when the
 * preset drops the scenery detail from the PiP (low), nothing otherwise.
 */
export function targetCamOmitFor(q: Pick<QualitySettings, 'targetCamScenery'>, envOmit: readonly Object3D[] | undefined): readonly Object3D[] {
  return q.targetCamScenery ? NONE : (envOmit ?? NONE);
}

export class TargetCam {
  readonly camera = new PerspectiveCamera(TARGET_CAM_FOV, 16 / 9, 0.5, 20_000);
  private readonly pose = makePose();
  /** visible flags of the omitted objects, restored after the pass */
  private readonly shown: boolean[] = [];
  /** objects hidden for the pass (the omit list, or its parts round a kept landmark) */
  private readonly hidden: Object3D[] = [];
  /** Last rendered target (debug / tests). */
  lastTargetId: number | null = null;
  /** Last rendered landmark (the Sky Tower shot; debug / tests). */
  lastLandmark: string | null = null;
  /** Draw calls / triangles of the last render() (0 when nothing was drawn; test hooks read them). */
  readonly lastStats = { calls: 0, triangles: 0 };
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
   * @param far    far plane of the main camera (the fog reaches the horizon colour there)
   * @param range  metres drawn past the target (QualitySettings.targetCamRange); 0 = up to `far`
   * @param omit   objects hidden for this pass (EnvironmentApi.targetCamOmit on low quality)
   * @param keep   landmark visuals kept in a landmark shot even inside `omit` (EnvironmentApi.targetCamLandmarks)
   * @returns true if something was drawn
   */
  render(renderer: WebGLRenderer, scene: Scene, rect: TargetCamRect, far: number, range = 0, omit: readonly Object3D[] = NONE, keep: readonly Object3D[] = NONE): boolean {
    this.lastTargetId = null;
    this.lastLandmark = null;
    this.lastStats.calls = 0;
    this.lastStats.triangles = 0;
    if (rect.vw < 2 || rect.vh < 2) return false;
    const lm = rect.landmark ?? null;
    const t = lm || rect.targetId === null ? null : this.world.getEntity(rect.targetId);
    if (!lm && (!t || t.kind === 'missile' || t.kind === 'decoy')) return false;
    const cam = this.camera;
    if (lm) landmarkCamPose(lm, this.world.time, this.pose, this.surfaceAt);
    else targetCamPose(t as CamTarget, this.world.time, this.pose, this.surfaceAt, this.waterAt);
    cam.position.copy(this.pose.position);
    cam.up.copy(this.pose.up);
    cam.lookAt(this.pose.look);
    // opening animation: crop (narrow vertical FOV) rather than squash
    const k = Math.max(0.01, Math.min(1, rect.vh / Math.max(1, rect.h)));
    const half = (TARGET_CAM_FOV * Math.PI) / 360;
    cam.fov = (2 * Math.atan(Math.tan(half) * k) * 180) / Math.PI;
    cam.aspect = rect.vw / rect.vh;
    cam.updateMatrixWorld();
    let ground = 0;
    if (range > 0) {
      // keep the ground in the frame inside the short far plane (a high target over blank haze otherwise)
      cam.getWorldDirection(_dir);
      ground = targetCamGroundDepth(cam.position.y, Math.asin(Math.max(-1, Math.min(1, -_dir.y))), (cam.fov * Math.PI) / 360);
    }
    cam.far = targetCamFar(far, this.pose.position.distanceTo(this.pose.look), range, ground);
    cam.updateProjectionMatrix();

    this.entities.prepareView?.(cam.position, range > 0 ? cam.far : undefined);

    renderer.getSize(_size);
    const yGl = _size.y - (rect.vy + rect.vh);
    const autoShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setScissorTest(true);
    renderer.setScissor(rect.vx, yGl, rect.vw, rect.vh);
    renderer.setViewport(rect.vx, yGl, rect.vw, rect.vh);
    const autoClear = renderer.autoClear;
    renderer.autoClear = true;
    // Game turns renderer.info.autoReset off, so this pass adds to the frame's world + cockpit counts
    const info = renderer.info.render;
    const calls0 = renderer.info.autoReset ? 0 : info.calls;
    const tris0 = renderer.info.autoReset ? 0 : info.triangles;
    this.shown.length = 0;
    this.hidden.length = 0;
    for (const o of omit) this.hide(o, lm ? keep : NONE);
    try {
      renderer.render(scene, cam);
      this.lastStats.calls = info.calls - calls0;
      this.lastStats.triangles = info.triangles - tris0;
    } finally {
      for (let i = 0; i < this.hidden.length; i++) this.hidden[i].visible = this.shown[i];
      renderer.autoClear = autoClear;
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, _size.x, _size.y);
      renderer.shadowMap.autoUpdate = autoShadow;
    }
    if (lm) this.lastLandmark = lm.id;
    else if (t) this.lastTargetId = t.id;
    return true;
  }

  /** Hide `o` for the pass — or, when it holds a kept object, everything in it but that object. */
  private hide(o: Object3D, keep: readonly Object3D[]): void {
    let inside = false;
    for (const k of keep) {
      if (k === o) return;
      if (holds(o, k)) inside = true;
    }
    if (inside) {
      for (const c of o.children) this.hide(c, keep);
      return;
    }
    this.hidden.push(o);
    this.shown.push(o.visible);
    o.visible = false;
  }
}
