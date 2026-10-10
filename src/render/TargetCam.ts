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
 * A ground target or SAM site is shown through the targeting pod (#199, rect.pod): the camera looks down
 * the line of sight from the player's jet, framing the zoom step (pose.ts podCamPose), and draws at most
 * POD_RANGE past the target; with no line of sight (rect.mask) the pass is skipped and the HUD draws the
 * window MASKED.
 * The pass dims the additive glow (effects glowGain → PIP_GLOW_GAIN, #282 R31-10): a kill seen in the
 * zoomed window fills it with flash and fireball, and stacked additive fire blew it out to white.
 */
import { PerspectiveCamera, Vector2, Vector3, type Object3D, type Scene, type WebGLRenderer } from 'three';
import type { EntityRendererApi } from '../core/contracts';
import { POD_ZOOM, POD_ZOOM_DEFAULT, isPodTarget, podSpan } from '../core/pod';
import type { QualitySettings } from '../core/types';
import type { SimWorld } from '../sim/api';
import { glowGain } from './effects/GpuParticles';
import { POD_RANGE, TARGET_CAM_FOV, WEAPON_CAM_FOV, landmarkCamPose, makePose, podCamPose, podFov, targetCamFar, targetCamGroundDepth, targetCamPose, weaponCamPose, type CamLandmark, type CamPose, type CamTarget } from './targetCam/pose';

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
  /** The pod (EOTS) view of a ground target / SAM site (hud/hmd/pip.ts stepPod) instead of the orbit. */
  pod?: boolean;
  /** Pod zoom step (index into core/pod.ts POD_ZOOM). */
  zoom?: number;
  /** Pod view with no line of sight ('' / absent = clear): nothing is rendered. */
  mask?: string;
}

/** The weapon window's shot (hud/hmd/wpnCam.ts wpnView): the weapon, its last state and its target. */
export interface WeaponShotView extends TargetCamRect {
  focusId: number | null;
  /** Still flying (false: the outcome hold, the camera stays where it was and watches the target). */
  flying: boolean;
  len: number;
  pos: Vector3;
  vel: Vector3;
  tgt: Vector3;
}

/**
 * Additive effects glow brightness (fire particles, Effects' glow sprites) in the PiP pass, against 1 in the main view
 * (#282 R31-10): a fireball over the target stacks to orange-yellow instead of white, so the window
 * still shows the kill and the target under it.
 */
export const PIP_GLOW_GAIN = 0.35;

/** After the weapon is gone the held shot keeps at least this far from what it watches (m): out of the fireball. */
const HOLD_MIN_DIST = 160;

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
  /** The weapon window's shot, held when the weapon is gone. */
  private readonly wPose = makePose();
  private wKey: number | null = null;
  private wHas = false;
  /** visible flags of the omitted objects, restored after the pass */
  private readonly shown: boolean[] = [];
  /** objects hidden for the pass (the omit list, or its parts round a kept landmark) */
  private readonly hidden: Object3D[] = [];
  /** Last rendered target (debug / tests). */
  lastTargetId: number | null = null;
  /** Last rendered landmark (the Sky Tower shot; debug / tests). */
  lastLandmark: string | null = null;
  /** The last render() was a pod view: its zoom step's name; 'MASKED' when it had no line of sight (debug / tests). */
  lastPod: string | null = null;
  /** The last render() was the weapon window's chase shot (renderPose; debug / tests). */
  lastWeapon = false;
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
   * @param range  metres drawn past the target (QualitySettings.targetCamRange); 0 = up to `far` (the pod: at most POD_RANGE)
   * @param omit   objects hidden for this pass (EnvironmentApi.targetCamOmit on low quality)
   * @param keep   landmark visuals kept in a landmark shot even inside `omit` (EnvironmentApi.targetCamLandmarks)
   * @returns true if something was drawn
   */
  render(renderer: WebGLRenderer, scene: Scene, rect: TargetCamRect, far: number, range = 0, omit: readonly Object3D[] = NONE, keep: readonly Object3D[] = NONE): boolean {
    this.lastTargetId = null;
    this.lastLandmark = null;
    this.lastWeapon = false;
    this.lastPod = null;
    this.lastStats.calls = 0;
    this.lastStats.triangles = 0;
    if (rect.vw < 2 || rect.vh < 2) return false;
    const lm = rect.landmark ?? null;
    const t = lm || rect.targetId === null ? null : this.world.getEntity(rect.targetId);
    if (!lm && (!t || t.kind === 'missile' || t.kind === 'decoy')) return false;
    const eye = this.world.player?.position;
    let fov = TARGET_CAM_FOV;
    if (!lm && rect.pod && eye && isPodTarget(t as CamTarget)) {
      // the pod: no line of sight, no picture (the HUD fills the window), and no cost
      if (rect.mask) {
        this.lastPod = 'MASKED';
        return false;
      }
      const zoom = rect.zoom ?? POD_ZOOM_DEFAULT;
      const step = POD_ZOOM[zoom] ?? POD_ZOOM[POD_ZOOM_DEFAULT];
      const span = podSpan(zoom, (t as CamTarget).radius);
      podCamPose(t as CamTarget, eye, span, this.pose, this.surfaceAt);
      fov = podFov(span, this.pose.position.distanceTo(this.pose.look));
      range = range > 0 ? Math.min(range, POD_RANGE) : POD_RANGE;
      this.lastPod = step.name;
    } else if (lm) landmarkCamPose(lm, this.world.time, this.pose, this.surfaceAt);
    else targetCamPose(t as CamTarget, this.world.time, this.pose, this.surfaceAt, this.waterAt);
    this.pass(renderer, scene, rect, this.pose, fov, far, range, omit, lm ? keep : NONE);
    if (lm) this.lastLandmark = lm.id;
    else if (t) this.lastTargetId = t.id;
    return true;
  }

  /**
   * Render a given pose into `rect` (the weapon window's chase shot, hud/hmd/wpnCam.ts): the same
   * pass as the target shot, so it costs the same and only one of the two draws in a frame.
   * @returns true if something was drawn
   */
  renderPose(renderer: WebGLRenderer, scene: Scene, rect: TargetCamRect, pose: CamPose, fov: number, far: number, range = 0, omit: readonly Object3D[] = NONE): boolean {
    this.lastTargetId = null;
    this.lastLandmark = null;
    this.lastWeapon = false;
    this.lastPod = null;
    this.lastStats.calls = 0;
    this.lastStats.triangles = 0;
    if (rect.vw < 2 || rect.vh < 2) return false;
    // never under the ground (a bomb's shot in its last metres)
    const floor = this.surfaceAt(pose.position.x, pose.position.z) + 2;
    if (pose.position.y < floor) pose.position.y = floor;
    this.pass(renderer, scene, rect, pose, fov, far, range, omit, NONE);
    this.lastWeapon = true;
    return true;
  }

  /**
   * Render the weapon window (hud/hmd/wpnCam.ts): a chase shot behind the player's weapon while it
   * flies; after the outcome the camera stays where it was and watches the target (the wreck, or the
   * target flying on after a miss). Same cost as the target shot, which isn't rendered meanwhile.
   */
  renderWeapon(renderer: WebGLRenderer, scene: Scene, view: WeaponShotView, far: number, range = 0, omit: readonly Object3D[] = NONE): boolean {
    if (view.vw < 2 || view.vh < 2 || view.focusId === null) {
      this.lastWeapon = false;
      return false;
    }
    if (view.focusId !== this.wKey) {
      this.wKey = view.focusId;
      this.wHas = false;
    }
    if (view.flying || !this.wHas) weaponCamPose(view.pos, view.vel, view.tgt, view.len, this.wPose);
    if (!view.flying) {
      const t = view.targetId === null ? null : this.world.getEntity(view.targetId);
      this.wPose.look.copy(t ? t.position : view.tgt);
      const d = this.wPose.position.distanceTo(this.wPose.look);
      if (d < HOLD_MIN_DIST) {
        _dir.subVectors(this.wPose.position, this.wPose.look);
        if (_dir.lengthSq() < 1e-6) _dir.set(0, 0.3, 1);
        this.wPose.position.copy(this.wPose.look).addScaledVector(_dir.normalize(), HOLD_MIN_DIST);
      }
    }
    this.wHas = true;
    return this.renderPose(renderer, scene, view, this.wPose, WEAPON_CAM_FOV, far, range, omit);
  }

  /** The shared pass: camera from `pose`, scissored viewport, scenery omitted, stats recorded. */
  private pass(renderer: WebGLRenderer, scene: Scene, rect: TargetCamRect, pose: CamPose, fov: number, far: number, range: number, omit: readonly Object3D[], keep: readonly Object3D[]): void {
    const cam = this.camera;
    cam.position.copy(pose.position);
    cam.up.copy(pose.up);
    cam.lookAt(pose.look);
    // opening animation: crop (narrow vertical FOV) rather than squash
    const k = Math.max(0.01, Math.min(1, rect.vh / Math.max(1, rect.h)));
    const half = (fov * Math.PI) / 360;
    cam.fov = (2 * Math.atan(Math.tan(half) * k) * 180) / Math.PI;
    cam.aspect = rect.vw / rect.vh;
    cam.updateMatrixWorld();
    let ground = 0;
    if (range > 0) {
      // keep the ground in the frame inside the short far plane (a high target over blank haze otherwise)
      cam.getWorldDirection(_dir);
      ground = targetCamGroundDepth(cam.position.y, Math.asin(Math.max(-1, Math.min(1, -_dir.y))), (cam.fov * Math.PI) / 360);
    }
    cam.far = targetCamFar(far, pose.position.distanceTo(pose.look), range, ground);
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
    const gain = glowGain.value;
    glowGain.value = PIP_GLOW_GAIN;
    // Game turns renderer.info.autoReset off, so this pass adds to the frame's world + cockpit counts
    const info = renderer.info.render;
    const calls0 = renderer.info.autoReset ? 0 : info.calls;
    const tris0 = renderer.info.autoReset ? 0 : info.triangles;
    this.shown.length = 0;
    this.hidden.length = 0;
    for (const o of omit) this.hide(o, keep);
    try {
      renderer.render(scene, cam);
      this.lastStats.calls = info.calls - calls0;
      this.lastStats.triangles = info.triangles - tris0;
    } finally {
      for (let i = 0; i < this.hidden.length; i++) this.hidden[i].visible = this.shown[i];
      renderer.autoClear = autoClear;
      glowGain.value = gain;
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, _size.x, _size.y);
      renderer.shadowMap.autoUpdate = autoShadow;
    }
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
