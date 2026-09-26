/**
 * CameraRig — all camera modes:
 *  cockpit/hud  pilot eye (per-type eye offset), head look with limits + spring-back, G-induced head
 *               sag, AoA buffet; exposes headLocal (head rotation relative to the body)
 *  chase        behind/above in a lagged aircraft frame (feels the rolls), looks ahead along the
 *               velocity, FOV kick with afterburner/speed, drag to look around, never below terrain
 *  orbit        drag to orbit, slow auto-rotate when idle
 *  target       over-the-shoulder padlock keeping jet + designated/locked target in frame
 *               (falls back to chase without a target)
 *  missile      follows the player's latest missile/bomb; holds on the impact ~2 s, then returns
 *  flyby        fixed point ahead of the flight path; re-placed after the jet passes
 *  tactical     high top-down, heading-up overview
 *  death cam    automatic orbit around the player's wreck (reported as 'orbit')
 * Screen shake decays exponentially; near/far planes are set per mode.
 */
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { CameraRigApi, CreateCameraRig, FrameContext } from '../core/contracts';
import type { CameraMode } from '../core/types';
import type { AircraftEntity } from '../sim/entities';
import { AIRCRAFT_SPECS } from './models/specs';
import {
  chasePosition,
  clampAboveGround,
  clampLook,
  flybyAnchor,
  fovToFrame,
  headQuaternion,
  orbitOffset,
  passedAnchor,
  shakeNoise,
  smoothK,
} from './camera/cameraMath';

const ORDER: CameraMode[] = ['cockpit', 'hud', 'chase', 'orbit', 'target', 'missile', 'flyby', 'tactical'];

const _v = new Vector3();
const _w = new Vector3();
const _aim = new Vector3();
const _up = new Vector3();
const _fwd = new Vector3();
const _q = new Quaternion();
const _qs = new Quaternion();
const _look = { yaw: 0, pitch: 0 };

export const createCameraRig: CreateCameraRig = (world, entities, settings) => {
  const camera = new PerspectiveCamera(settings.fov, 16 / 9, 1, 60_000);
  camera.name = 'mainCamera';
  let mode: CameraMode = 'chase';
  let prevMode: CameraMode = 'chase';
  const headLocal = new Quaternion();

  // look state
  let headYaw = 0;
  let headPitch = 0;
  let recenter = false;
  let lookIdle = 99;
  let chaseYaw = 0;
  let chasePitch = 0;
  let orbitYaw = 0;
  let orbitPitch = 0.25;
  let orbitDist = 0;
  // smoothing state
  const sq = new Quaternion();
  let sqValid = false;
  const tgtDir = new Vector3(0, 0, -1);
  let tgtValid = false;
  let gSag = 0;
  let fov = settings.fov;
  // missile cam
  let lastMissileId: number | null = null;
  let followMissile: number | null = null;
  const holdPos = new Vector3();
  let holdUntil = -1;
  let holding = false;
  // flyby
  const anchor = new Vector3();
  let anchorValid = false;
  // death cam
  let dead = false;
  const deathPos = new Vector3();
  let deathYaw = 0;
  // shake
  let shakeAmp = 0;
  let shakeT = 0;
  let time = 0;
  let near = 1;
  let far = 60_000;

  const offLaunch = world.events.on('munition:launch', ({ missile, shooter }) => {
    if (world.player && shooter.id === world.player.id) lastMissileId = missile.id;
  });
  const offEnd = world.events.on('munition:end', ({ missile, position }) => {
    if (mode === 'missile' && followMissile === missile.id) {
      holdPos.copy(position);
      holdUntil = time + 2.2;
      holding = true;
    }
  });

  const targetOf = (p: AircraftEntity | null) => {
    if (!p) return null;
    const id = p.radar.lockedId ?? p.radar.designatedId;
    const e = world.getEntity(id);
    return e && e.alive ? e : null;
  };
  const liveMissile = (id: number | null) => {
    const m = world.getEntity(id);
    return m && m.kind === 'missile' && m.alive ? m : null;
  };

  function available(m: CameraMode): boolean {
    const p = world.player;
    if (m === 'target') return !!targetOf(p);
    if (m === 'missile') return !!liveMissile(lastMissileId);
    return true;
  }

  function setPlanes(n: number, f: number): void {
    if (n !== near || f !== far) {
      near = n;
      far = f;
      camera.near = n;
      camera.far = f;
      camera.updateProjectionMatrix();
    }
  }

  function applyShake(dt: number, external: boolean): void {
    shakeAmp *= Math.exp(-3.2 * dt);
    if (shakeAmp < 0.002) return;
    shakeT += dt;
    const a = shakeAmp * shakeAmp * (external ? 0.03 : 0.045);
    camera.rotateX(shakeNoise(shakeT, 1.3) * a);
    camera.rotateY(shakeNoise(shakeT, 4.1) * a);
    camera.rotateZ(shakeNoise(shakeT, 7.7) * a * 0.6);
    if (external) {
      _v.set(shakeNoise(shakeT, 2.2), shakeNoise(shakeT, 5.5), 0).multiplyScalar(shakeAmp * 0.35);
      camera.position.add(_v.applyQuaternion(camera.quaternion));
    }
  }

  function groundY(x: number, z: number): number {
    return world.terrain.surfaceHeightAt(x, z);
  }

  /* ───────────── modes ───────────── */

  function cockpit(p: AircraftEntity, dt: number, ctx: FrameContext): void {
    // spring the head back to centre
    if (recenter || lookIdle > 4) {
      const k = smoothK(recenter ? 9 : 2.5, dt);
      headYaw += (0 - headYaw) * k;
      headPitch += (0 - headPitch) * k;
      if (Math.abs(headYaw) < 0.002 && Math.abs(headPitch) < 0.002) recenter = false;
    }
    headQuaternion(headYaw, headPitch, headLocal);
    const eye = entities.getEyeOffset(p.type);
    // G pushes the head down (and up under negative G), smoothed
    const gT = Math.max(-0.05, Math.min(0.09, (p.flight.gLoad - 1) * 0.011));
    gSag += (gT - gSag) * smoothK(6, dt);
    _v.set(eye.x, eye.y - gSag, eye.z).applyQuaternion(p.quaternion).add(p.position);
    camera.position.copy(_v);
    camera.quaternion.copy(p.quaternion).multiply(headLocal);
    // AoA / stall buffet
    const buffet = Math.max(0, (p.flight.alpha - 0.3) / 0.25) + (p.flight.stalled ? 0.6 : 0);
    if (buffet > 0 && !ctx.paused) {
      const a = Math.min(1, buffet) * 0.004;
      camera.rotateX(shakeNoise(time * 1.7, 9.1) * a);
      camera.rotateZ(shakeNoise(time * 1.9, 3.3) * a);
    }
    setPlanes(0.3, Math.max(20_000, ctx.quality.drawDistance));
  }

  function chase(p: AircraftEntity, dt: number, ctx: FrameContext, fovOut: { v: number }): void {
    const spec = AIRCRAFT_SPECS[p.type] ?? AIRCRAFT_SPECS.f35a;
    if (!sqValid) {
      sq.copy(p.quaternion);
      sqValid = true;
    }
    sq.slerp(p.quaternion, smoothK(5.5, dt));
    // look-around offset springs back after a moment
    if (lookIdle > 1.2) {
      const k = smoothK(2, dt);
      chaseYaw -= chaseYaw * k;
      chasePitch -= chasePitch * k;
    }
    const ab = p.flight.afterburner;
    const dist = spec.chase.dist * (1 + 0.12 * ab);
    _q.copy(sq);
    if (chaseYaw || chasePitch) {
      _qs.setFromAxisAngle(_up.set(0, 1, 0), chaseYaw);
      _q.multiply(_qs);
      _qs.setFromAxisAngle(_up.set(1, 0, 0), -chasePitch);
      _q.multiply(_qs);
    }
    chasePosition(p.position, _q, dist, spec.chase.height, camera.position);
    const lifted = clampAboveGround(camera.position, groundY(camera.position.x, camera.position.z), 3);
    // aim a little ahead along the velocity so the jet sits low-centre and turns are anticipated
    const spd = p.velocity.length();
    if (spd > 5) _aim.copy(p.velocity).multiplyScalar(28 / spd).add(p.position);
    else _aim.set(0, 0, -28).applyQuaternion(p.quaternion).add(p.position);
    _aim.addScaledVector(_up.set(0, 1, 0).applyQuaternion(sq), spec.chase.height * 0.25);
    camera.up.set(0, 1, 0).applyQuaternion(sq);
    if (lifted) camera.up.lerp(_w.set(0, 1, 0), 0.5).normalize();
    camera.lookAt(_aim);
    fovOut.v += 7 * ab + 4 * Math.max(0, Math.min(1, (p.flight.mach - 0.8) / 0.6));
    setPlanes(1, ctx.quality.drawDistance);
  }

  function orbitAround(center: Vector3, dist: number, dt: number, ctx: FrameContext, auto: boolean): void {
    if (auto || lookIdle > 2.5) orbitYaw += dt * (auto ? 0.3 : 0.15);
    orbitOffset(orbitYaw, orbitPitch, dist, _v);
    camera.position.copy(center).add(_v);
    clampAboveGround(camera.position, groundY(camera.position.x, camera.position.z), 3);
    camera.up.set(0, 1, 0);
    camera.lookAt(center);
    setPlanes(1, ctx.quality.drawDistance);
  }

  function target(p: AircraftEntity, dt: number, ctx: FrameContext, fovOut: { v: number }): boolean {
    const tgt = targetOf(p);
    if (!tgt) return false;
    const spec = AIRCRAFT_SPECS[p.type] ?? AIRCRAFT_SPECS.f35a;
    _v.copy(tgt.position).sub(p.position);
    const range = _v.length();
    _v.divideScalar(Math.max(1, range));
    if (!tgtValid) {
      tgtDir.copy(_v);
      tgtValid = true;
    }
    tgtDir.lerp(_v, smoothK(4, dt)).normalize();
    const back = spec.chase.dist * 1.15 + Math.min(60, range * 0.02);
    const hUp = spec.chase.height * 1.3;
    camera.position.copy(p.position).addScaledVector(tgtDir, -back);
    camera.position.y += hUp;
    clampAboveGround(camera.position, groundY(camera.position.x, camera.position.z), 3);
    // aim between the jet and the target (closer targets pull the aim point back)
    _aim.copy(p.position).addScaledVector(tgtDir, Math.min(range, 600) * 0.85);
    camera.up.set(0, 1, 0);
    camera.lookAt(_aim);
    // widen the lens when the target is close so both stay in frame
    if (range < 400) fovOut.v += (1 - range / 400) * 18;
    setPlanes(1, ctx.quality.drawDistance);
    return true;
  }

  function missileCam(dt: number, ctx: FrameContext): boolean {
    if (holding) {
      camera.up.set(0, 1, 0);
      camera.lookAt(holdPos);
      setPlanes(1, ctx.quality.drawDistance);
      if (time > holdUntil) {
        holding = false;
        followMissile = null;
        mode = prevMode === 'missile' ? 'chase' : prevMode;
        sqValid = false;
        return false;
      }
      return true;
    }
    const m = liveMissile(followMissile ?? lastMissileId);
    if (!m) return false;
    followMissile = m.id;
    _fwd.set(0, 0, -1).applyQuaternion(m.quaternion);
    const L = (m as { def?: { length: number } }).def?.length ?? 3.6;
    _v.copy(m.position).addScaledVector(_fwd, -(8 + L * 1.5));
    _v.y += 2.2;
    camera.position.lerp(_v, smoothK(12, dt));
    if (camera.position.distanceTo(_v) > 200) camera.position.copy(_v);
    clampAboveGround(camera.position, groundY(camera.position.x, camera.position.z), 2);
    _aim.copy(m.position).addScaledVector(_fwd, 40);
    camera.up.set(0, 1, 0);
    camera.lookAt(_aim);
    holdPos.copy(m.position);
    setPlanes(0.5, ctx.quality.drawDistance);
    return true;
  }

  function flyby(p: AircraftEntity, ctx: FrameContext, fovOut: { v: number }): void {
    const spec = AIRCRAFT_SPECS[p.type] ?? AIRCRAFT_SPECS.f35a;
    const spd = p.velocity.length();
    const d = anchorValid ? anchor.distanceTo(p.position) : Infinity;
    if (!anchorValid || passedAnchor(anchor, p.position, p.velocity, 120) || d > 2500) {
      _fwd.set(0, 0, -1).applyQuaternion(p.quaternion);
      flybyAnchor(p.position, p.velocity, _fwd, Math.max(220, spd * 3.2), 28 + spec.span, 6, anchor);
      clampAboveGround(anchor, groundY(anchor.x, anchor.z), 3);
      anchorValid = true;
    }
    camera.position.copy(anchor);
    camera.up.set(0, 1, 0);
    camera.lookAt(p.position);
    // zoom so the jet keeps a pleasing size
    const dist = anchor.distanceTo(p.position);
    fovOut.v = Math.min(fovOut.v, fovToFrame(spec.length * 1.6, dist, 0.45, 8, fovOut.v));
    setPlanes(1, ctx.quality.drawDistance);
  }

  function tactical(p: AircraftEntity, ctx: FrameContext): void {
    const H = 9000;
    camera.position.set(p.position.x, p.position.y + H, p.position.z);
    _fwd.set(0, 0, -1).applyQuaternion(p.quaternion);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    camera.up.copy(_fwd.normalize());
    camera.lookAt(p.position.x, p.position.y, p.position.z);
    setPlanes(50, H + ctx.quality.drawDistance);
  }

  const fovBox = { v: 60 };

  const rig: CameraRigApi = {
    camera,
    get mode() {
      return dead ? 'orbit' : mode;
    },
    get focusId() {
      const p = world.player;
      if (mode === 'missile' && followMissile != null) return followMissile;
      if (mode === 'target') return targetOf(p)?.id ?? p?.id ?? null;
      return p?.id ?? null;
    },
    headLocal,

    setMode(m: CameraMode) {
      if (m === mode) return;
      if (m === 'missile') {
        if (!available('missile')) return;
        prevMode = mode;
        followMissile = lastMissileId;
        holding = false;
      }
      if (m === 'flyby') anchorValid = false;
      if (m === 'target') tgtValid = false;
      if (m === 'orbit') {
        const p = world.player;
        if (p) {
          // start the orbit from behind the jet
          _fwd.set(0, 0, -1).applyQuaternion(p.quaternion);
          orbitYaw = Math.atan2(-_fwd.x, -_fwd.z);
        }
        orbitPitch = 0.22;
      }
      sqValid = false;
      mode = m;
    },

    nextMode() {
      const i = ORDER.indexOf(mode);
      for (let k = 1; k <= ORDER.length; k++) {
        const m = ORDER[(i + k) % ORDER.length];
        if (available(m)) {
          rig.setMode(m);
          break;
        }
      }
      return rig.mode;
    },

    look(dYaw: number, dPitch: number) {
      lookIdle = 0;
      recenter = false;
      if (dead || mode === 'orbit') {
        orbitYaw -= dYaw;
        orbitPitch = Math.max(-0.15, Math.min(1.35, orbitPitch + dPitch));
      } else if (mode === 'cockpit' || mode === 'hud') {
        clampLook(headYaw + dYaw, headPitch + dPitch, _look);
        headYaw = _look.yaw;
        headPitch = _look.pitch;
      } else if (mode === 'chase' || mode === 'target') {
        chaseYaw = Math.max(-Math.PI, Math.min(Math.PI, chaseYaw - dYaw));
        chasePitch = Math.max(-0.6, Math.min(1.0, chasePitch + dPitch));
      }
    },

    resetLook() {
      recenter = true;
      chaseYaw = chasePitch = 0;
    },

    shake(intensity: number) {
      shakeAmp = Math.min(1.2, Math.max(shakeAmp, intensity) + intensity * 0.25);
    },

    update(ctx: FrameContext) {
      const dt = Math.min(0.05, ctx.dt);
      time += dt;
      lookIdle += dt;
      const p = world.player;
      fovBox.v = ctx.settings.fov || settings.fov;
      if (p) {
        if (!p.alive && !dead) {
          dead = true;
          deathYaw = orbitYaw = Math.atan2(p.velocity.x, p.velocity.z) + 0.6;
          orbitPitch = 0.35;
        }
        if (p.alive && dead) dead = false;
        deathPos.copy(p.position);
      }
      if (dead) {
        const spec = p ? AIRCRAFT_SPECS[p.type] : AIRCRAFT_SPECS.f35a;
        orbitAround(deathPos, (spec?.chase.dist ?? 25) * 2.4, dt, ctx, true);
        void deathYaw;
      } else if (!p) {
        // no player (menu/teardown): keep the camera where it is
      } else {
        let m = mode;
        if (m === 'missile' && !missileCam(dt, ctx)) m = mode === 'missile' ? 'chase' : mode;
        if (m === 'target' && !target(p, dt, ctx, fovBox)) m = 'chase';
        switch (m) {
          case 'cockpit':
          case 'hud':
            cockpit(p, dt, ctx);
            break;
          case 'chase':
            chase(p, dt, ctx, fovBox);
            break;
          case 'orbit': {
            const spec = AIRCRAFT_SPECS[p.type] ?? AIRCRAFT_SPECS.f35a;
            if (!orbitDist) orbitDist = spec.chase.dist * 1.3;
            orbitAround(p.position, orbitDist, dt, ctx, false);
            break;
          }
          case 'flyby':
            flyby(p, ctx, fovBox);
            break;
          case 'tactical':
            tactical(p, ctx);
            break;
          default:
            break;
        }
        if (m !== 'cockpit' && m !== 'hud') headQuaternion(headYaw, headPitch, headLocal);
      }
      // FOV (smoothed)
      fov += (fovBox.v - fov) * smoothK(4, dt);
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      if (!ctx.paused) applyShake(dt, mode !== 'cockpit' && mode !== 'hud');
      camera.updateMatrixWorld();
    },

    resize(width: number, height: number) {
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
    },

    dispose() {
      offLaunch();
      offEnd();
      camera.removeFromParent();
    },
  };
  return rig;
};
