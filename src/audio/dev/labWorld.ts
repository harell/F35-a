/**
 * DEV ONLY — a tiny mock sim for labs/audio-lab.html: the player's jet flying straight and level
 * with slider-driven engine/flight state, AI jets doing flybys, missiles that ignite, fly and
 * explode, and a camera rig for every view mode. It emits the same events the real sim does,
 * so the real AudioSystem can be exercised end-to-end. Not imported by the game.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import type { FrameContext } from '../../core/contracts';
import { DEFAULT_SETTINGS, DIFFICULTIES, QUALITY_PRESETS } from '../../core/data';
import { EventBus } from '../../core/events';
import type { AircraftType, CameraMode, ExplosionSize, MunitionId, QualityLevel, WarningId } from '../../core/types';
import type { CombatSystemApi, SimWorld, TerrainQuery } from '../../sim/api';
import {
  AircraftEntity,
  DecoyEntity,
  MissileEntity,
  SamSiteEntity,
  type AnyEntity,
  type RwrContact,
} from '../../sim/entities';
import { MUNITIONS } from '../../sim/weapons/defs';

const terrain: TerrainQuery = {
  size: 80_000,
  heightAt: () => 0,
  surfaceHeightAt: () => 0,
  isWater: () => false,
  lineOfSight: () => true,
  raycast: () => -1,
};

interface LabMissile {
  m: MissileEntity;
  ignite: number;
  life: number;
  accel: number;
  explode: ExplosionSize;
}

export interface LabControls {
  throttle: number; // 0..1 (AB above 0.9)
  ias: number; // m/s
  alphaDeg: number;
  g: number;
  buffet: number;
  view: CameraMode;
  quality: QualityLevel;
  rwr: 'none' | 'search' | 'track' | 'track_sam' | 'launch';
  maws: boolean;
  growl: 'off' | 'search' | 'locked';
  paused: boolean;
}

export class LabWorld {
  readonly events = new EventBus();
  readonly aircraft: AircraftEntity[] = [];
  readonly missiles: MissileEntity[] = [];
  readonly sams: SamSiteEntity[] = [];
  readonly ground = [];
  readonly decoys: DecoyEntity[] = [];
  readonly projectiles = [];
  readonly player: AircraftEntity;
  readonly camera = new PerspectiveCamera(60, 844 / 390, 0.5, 60000);
  time = 0;
  controls: LabControls = {
    throttle: 0.7,
    ias: 230,
    alphaDeg: 3,
    g: 1,
    buffet: 0,
    view: 'cockpit',
    quality: 'medium',
    rwr: 'none',
    maws: false,
    growl: 'off',
    paused: false,
  };
  private id = 1;
  private readonly flying: LabMissile[] = [];
  private readonly flybys: { ac: AircraftEntity; until: number }[] = [];
  private readonly anchor = new Vector3();
  private anchorValid = false;
  private orbitA = 0;
  private mawsT = 12;
  private rpm = 0.8;
  private lastMissile: MissileEntity | null = null;
  private readonly world: SimWorld;
  private readonly rwrContacts: Record<string, RwrContact> = {
    fighter: { sourceId: 900, kind: 'fighter', symbol: '29', bearing: 0.6, strength: 0.6, state: 'search', age: 0 },
    sam: { sourceId: 901, kind: 'sam', symbol: 'S6', bearing: -1.2, strength: 0.7, state: 'track', age: 0 },
  };

  constructor() {
    const p = new AircraftEntity(this.id++, 'f35a', 'blue', { name: 'VIPER 1', callsign: 'VIPER 1' });
    p.isPlayer = true;
    p.position.set(0, 1500, 0);
    p.velocity.set(0, 0, -230);
    p.flares = 24;
    p.chaff = 24;
    p.gunAmmo = 180;
    this.player = p;
    this.aircraft.push(p);
    const self = this;
    const combat = {
      munitions: MUNITIONS,
      irSeekerState: () => ({ state: self.controls.growl, targetId: null, direction: null }),
    } as unknown as CombatSystemApi;
    this.world = {
      events: this.events,
      terrain,
      difficulty: DIFFICULTIES.pilot,
      combat,
      get time() {
        return self.time;
      },
      aircraft: this.aircraft,
      missiles: this.missiles,
      sams: this.sams,
      ground: [],
      decoys: this.decoys,
      projectiles: [],
      get player() {
        return self.player;
      },
      nextId: () => this.id++,
      getEntity: (id: number | null | undefined) => (id == null ? null : this.find(id)),
      hostilesOf: () => [],
    } as unknown as SimWorld;
  }

  private find(id: number): AnyEntity | null {
    for (const a of this.aircraft) if (a.id === id) return a;
    for (const m of this.missiles) if (m.id === id) return m;
    for (const s of this.sams) if (s.id === id) return s;
    return null;
  }

  /* ───────────── actions ───────────── */

  /** AI jet passing close to the camera (speed m/s; > 343 = supersonic, sonic boom). */
  flyby(speed: number, type: AircraftType = 'su27', ab = 1, dist = 3000): void {
    const ac = new AircraftEntity(this.id++, type, 'red', { name: type.toUpperCase() });
    const cam = this.camera.position;
    const fwd = new Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).setY(0).normalize();
    const right = new Vector3(-fwd.z, 0, fwd.x);
    // start `dist` m in front of the camera, fly towards and past it with a 45 m miss distance
    ac.position.copy(cam).addScaledVector(fwd, dist).addScaledVector(right, 45).setY(cam.y + 15);
    ac.velocity.copy(fwd).multiplyScalar(-speed).add(this.player.velocity.clone().multiplyScalar(this.controls.view === 'flyby' ? 0 : 1));
    ac.quaternion.setFromUnitVectors(new Vector3(0, 0, -1), ac.velocity.clone().normalize());
    ac.flight.engineRpm = 1.02;
    ac.flight.afterburner = ab;
    ac.flight.tas = speed;
    this.aircraft.push(ac);
    this.flybys.push({ ac, until: this.time + 14 });
  }

  launchPlayer(weapon: 'aim120' | 'aim9x' | 'gbu31'): void {
    const p = this.player;
    const def = MUNITIONS[weapon];
    const m = new MissileEntity(this.id++, def, 'blue', p.id, null);
    m.position.copy(p.position).add(new Vector3(0, -1.5, -2));
    m.velocity.copy(p.velocity).add(new Vector3(0, -8, 0));
    m.quaternion.copy(p.quaternion);
    if (weapon === 'aim120') {
      // bay doors first, like the real release sequence
      this.bay(() => this.addMissile(m, p, 0.35, 190, 'small'));
    } else this.addMissile(m, p, weapon === 'aim9x' ? 0 : 999, weapon === 'aim9x' ? 260 : 0, 'large');
  }

  /** SAM site `dist` m ahead-left launches at the player; the missile flies past close by. */
  launchSam(dist: number, id: MunitionId = 'm_3m9'): void {
    const p = this.player;
    const site = new SamSiteEntity(this.id++, id === 'm_48n6' ? 'sa10' : 'sa6', 'red');
    site.position.set(p.position.x - dist * 0.5, 0, p.position.z - dist * 0.85);
    this.sams.push(site);
    const m = new MissileEntity(this.id++, MUNITIONS[id], 'red', site.id, p.id);
    m.position.copy(site.position).setY(5);
    const aim = p.position.clone().add(p.velocity.clone().multiplyScalar(dist / 700)).add(new Vector3(35, 20, 0));
    m.velocity.copy(aim.sub(m.position).normalize().multiplyScalar(60));
    this.addMissile(m, site, 0, 320, 'medium');
  }

  /** Enemy fighter `dist` m ahead fires at the player. */
  launchEnemy(dist: number): void {
    const p = this.player;
    const shooter = new AircraftEntity(this.id++, 'su35', 'red');
    shooter.position.copy(p.position).add(new Vector3(300, 50, -dist));
    shooter.velocity.set(0, 0, 250);
    this.aircraft.push(shooter);
    this.flybys.push({ ac: shooter, until: this.time + 10 });
    const m = new MissileEntity(this.id++, MUNITIONS.r77, 'red', shooter.id, p.id);
    m.position.copy(shooter.position);
    m.velocity.copy(p.position).sub(shooter.position).normalize().multiplyScalar(300);
    this.addMissile(m, shooter, 0, 250, 'small');
  }

  /** Explosion `dist` m from the camera (ahead-right, below) — surface is just the flavour. */
  explode(size: ExplosionSize, dist: number, surface: 'air' | 'ground' | 'water'): void {
    const dir = new Vector3(0.55, surface === 'air' ? 0.1 : -0.45, -0.7).normalize();
    const pos = this.camera.position.clone().addScaledVector(dir, dist);
    this.events.emit('explosion', { position: pos, size, surface });
  }

  countermeasure(type: 'flare' | 'chaff'): void {
    const p = this.player;
    const d = new DecoyEntity(this.id++, type, 'blue', p.id, 3, 1);
    d.position.copy(p.position).add(new Vector3(0, -2, 6));
    this.events.emit('countermeasure', { decoy: d, ownerId: p.id });
  }

  gun(firing: boolean): void {
    const p = this.player;
    p.gunFiring = firing;
    this.events.emit('gun:state', { shooterId: p.id, firing, position: p.position, team: 'blue', weapon: 'gau22' });
  }

  /** Remote gun burst (enemy cannon / Shilka) `dist` m away for `sec` s. */
  remoteGun(weapon: 'gsh301' | 'zsu23', dist: number, sec: number): void {
    const p = this.player;
    const s = new SamSiteEntity(this.id++, 'zsu23', 'red');
    s.position.set(p.position.x + dist * 0.7, weapon === 'zsu23' ? 0 : p.position.y, p.position.z - dist * 0.7);
    this.sams.push(s);
    this.events.emit('gun:state', { shooterId: s.id, firing: true, position: s.position, team: 'red', weapon });
    setTimeout(() => this.events.emit('gun:state', { shooterId: s.id, firing: false, position: s.position, team: 'red', weapon }), sec * 1000);
  }

  hit(amount: number): void {
    this.events.emit('player:hit', { amount, direction: null });
  }

  setWarning(id: WarningId, on: boolean): void {
    const w = this.player.warnings;
    if (on === w.has(id)) return;
    if (on) w.add(id);
    else w.delete(id);
    this.events.emit('warning', { id, active: on });
  }

  private bay(then: () => void): void {
    const p = this.player;
    const t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      if (t < 0.35) p.bayDoors = t / 0.35;
      else if (t < 1.9) p.bayDoors = 1;
      else p.bayDoors = Math.max(0, 1 - (t - 1.9) / 0.5);
      if (t >= 0.36 && then) {
        then();
        then = null as unknown as () => void;
      }
      if (t < 2.5) requestAnimationFrame(tick);
      else p.bayDoors = 0;
    };
    tick();
  }

  private addMissile(m: MissileEntity, shooter: AnyEntity, ignite: number, accel: number, explode: ExplosionSize): void {
    this.missiles.push(m);
    this.flying.push({ m, ignite: this.time + ignite, life: this.time + (accel > 0 ? 9 : 6), accel, explode });
    this.lastMissile = m;
    this.events.emit('munition:launch', { missile: m, shooter, targetId: m.targetId });
  }

  /** Remove every AI jet, missile and site (between automated scenarios). */
  clear(): void {
    this.flying.length = 0;
    this.missiles.length = 0;
    this.sams.length = 0;
    this.flybys.length = 0;
    this.aircraft.length = 0;
    this.aircraft.push(this.player);
    this.player.bayDoors = 0;
    this.player.gunFiring = false;
  }

  /* ───────────── simulation ───────────── */

  step(dt: number): void {
    if (this.controls.paused) return;
    this.time += dt;
    const c = this.controls;
    const p = this.player;
    const f = p.flight;
    // engine spool towards the lever
    const cmd = Math.min(c.throttle, 0.9) / 0.9;
    const target = 0.63 + 0.37 * Math.pow(cmd, 0.7) + (c.throttle > 0.9 ? 0.02 : 0);
    this.rpm += (target - this.rpm) * Math.min(1, dt * 1.5);
    f.engineRpm = this.rpm;
    const abCmd = c.throttle > 0.905 ? (c.throttle - 0.9) / 0.1 : 0;
    f.afterburner += ((this.rpm > 0.97 ? abCmd : 0) - f.afterburner) * Math.min(1, dt * 3);
    f.ias = c.ias;
    f.tas = c.ias * 1.15;
    f.mach = f.tas / 330;
    f.alpha = (c.alphaDeg * Math.PI) / 180;
    f.gLoad = c.g;
    f.stalled = c.alphaDeg > 24;
    p.buffet = c.buffet;
    p.velocity.set(0, 0, -f.tas);
    p.position.addScaledVector(p.velocity, dt);
    if (p.position.z < -30000) p.position.z += 60000;

    // rwr / maws
    p.rwr.length = 0;
    if (c.rwr !== 'none') {
      const fc = this.rwrContacts.fighter;
      const sc = this.rwrContacts.sam;
      fc.state = c.rwr === 'search' ? 'search' : c.rwr === 'launch' ? 'launch' : 'track';
      p.rwr.push(c.rwr === 'track_sam' ? sc : fc);
    }
    p.incoming.length = 0;
    if (c.maws) {
      this.mawsT -= dt;
      if (this.mawsT < 0) this.mawsT = 12;
      p.incoming.push({ missileId: 999, bearing: 1, elevation: 0, distance: this.mawsT * 700, timeToImpact: this.mawsT, guidance: 'radar' });
    }
    if (c.growl !== 'off') p.selectedWeapon = 'aim9x';

    // missiles
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const lm = this.flying[i];
      const m = lm.m;
      m.age += dt;
      if (!m.motorBurning && this.time >= lm.ignite && lm.accel > 0) m.motorBurning = true;
      if (m.motorBurning) {
        const dir = m.velocity.clone().normalize();
        m.velocity.addScaledVector(dir, lm.accel * dt);
        if (m.age > 6) m.motorBurning = false;
      } else m.velocity.y -= 9.8 * dt;
      m.position.addScaledVector(m.velocity, dt);
      if (m.velocity.lengthSq() > 1) m.quaternion.setFromUnitVectors(new Vector3(0, 0, -1), m.velocity.clone().normalize());
      if (this.time > lm.life || m.position.y < 0) {
        m.alive = false;
        m.motorBurning = false;
        this.events.emit('explosion', { position: m.position.clone().setY(Math.max(0, m.position.y)), size: lm.explode, surface: m.position.y <= 0 ? 'ground' : 'air' });
        this.flying.splice(i, 1);
        this.missiles.splice(this.missiles.indexOf(m), 1);
      }
    }
    // flybys
    for (let i = this.flybys.length - 1; i >= 0; i--) {
      const fb = this.flybys[i];
      fb.ac.position.addScaledVector(fb.ac.velocity, dt);
      if (this.time > fb.until) {
        fb.ac.alive = false;
        this.aircraft.splice(this.aircraft.indexOf(fb.ac), 1);
        this.flybys.splice(i, 1);
      }
    }
    this.updateCamera(dt);
  }

  private updateCamera(dt: number): void {
    const cam = this.camera;
    const p = this.player;
    const up = new Vector3(0, 1, 0);
    switch (this.controls.view) {
      case 'cockpit':
      case 'hud':
        cam.position.copy(p.position).add(new Vector3(0, 1, -4));
        cam.lookAt(cam.position.clone().add(new Vector3(0, 0, -100)));
        break;
      case 'chase':
      case 'target':
        cam.position.copy(p.position).add(new Vector3(0, 5, 26));
        cam.lookAt(p.position.clone().add(new Vector3(0, 0, -60)));
        break;
      case 'orbit':
        this.orbitA += dt * 0.5;
        cam.position.copy(p.position).add(new Vector3(Math.sin(this.orbitA) * 35, 8, Math.cos(this.orbitA) * 35));
        cam.lookAt(p.position);
        break;
      case 'flyby': {
        if (!this.anchorValid || this.anchor.z - p.position.z > 400) {
          this.anchor.copy(p.position).add(new Vector3(40, 6, -Math.max(800, p.velocity.length() * 4)));
          this.anchorValid = true;
        }
        cam.position.copy(this.anchor);
        cam.lookAt(p.position);
        break;
      }
      case 'missile': {
        const m = this.lastMissile;
        if (m && m.alive) {
          cam.position.copy(m.position).add(m.velocity.clone().normalize().multiplyScalar(-12)).add(new Vector3(0, 2, 0));
          cam.lookAt(m.position);
        } else {
          cam.position.copy(p.position).add(new Vector3(0, 5, 26));
          cam.lookAt(p.position);
        }
        break;
      }
      case 'tactical':
        cam.position.copy(p.position).add(new Vector3(0, 9000, 0));
        cam.up.set(0, 0, -1);
        cam.lookAt(p.position);
        cam.up.copy(up);
        break;
    }
    if (this.controls.view !== 'flyby') this.anchorValid = false;
    cam.updateMatrixWorld();
  }

  frame(dt: number): FrameContext {
    const q = QUALITY_PRESETS[this.controls.quality];
    return {
      dt,
      time: this.time,
      world: this.world,
      player: this.player,
      camera: this.camera,
      viewMode: this.controls.view,
      focusId: this.controls.view === 'missile' ? (this.lastMissile?.id ?? null) : this.player.id,
      mission: null,
      settings: DEFAULT_SETTINGS,
      quality: q,
      paused: this.controls.paused,
      screen: { width: 844, height: 390, dpr: 2, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
    };
  }
}
