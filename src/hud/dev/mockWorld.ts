/**
 * DEV ONLY — mocked SimWorld / player / mission for hud-lab.html. Builds a static scenario that
 * exercises every HMD / PCD symbol (targets, lock, DLZ, incoming missiles, RWR, warnings, SAM rings,
 * gun, AIM-9X, JDAM, damage...). Not imported by the game.
 */
import { Quaternion, Vector3 } from 'three';
import type { MissionRunnerApi, ObjectiveStatus, Waypoint } from '../../core/contracts';
import { EventBus } from '../../core/events';
import { DIFFICULTIES } from '../../core/data';
import { DEG, dirFromHeadingPitch, quatFromHPR } from '../../core/math';
import type { WarningId, WeaponId } from '../../core/types';
import type { CombatSystemApi, LaunchZone, SimWorld, TerrainQuery } from '../../sim/api';
import {
  AircraftEntity,
  GroundTargetEntity,
  MissileEntity,
  SamSiteEntity,
  type AnyEntity,
  type MunitionDef,
  type RadarContact,
} from '../../sim/entities';

export type Scenario = 'aa' | 'lock' | 'threat' | 'gun' | '9x' | 'ag' | 'ccip' | 'damage' | 'pullup' | 'offscreen' | 'nav';

export interface MockSetup {
  world: SimWorld;
  events: EventBus;
  player: AircraftEntity;
  mission: MissionRunnerApi;
  /** Advance mock time (animations: lock progress, missile TOF...). */
  tick(dt: number): void;
}

function munition(id: string, name: string, short: string, guidance: MunitionDef['guidance']): MunitionDef {
  return {
    id: id as MunitionDef['id'], name, short, category: 'aam', guidance, launch: 'rail', mass: 150, boostTime: 3, boostAccel: 200,
    sustainTime: 5, sustainAccel: 40, drag: 0.001, glideRatio: 0, maxG: 40, seekerFov: 0.3, gimbalLimit: 1, seekerRange: 15000,
    navConstant: 4, minRange: 1000, maxRange: 30000, fuseRadius: 10, damage: 100, blastRadius: 15, maxFlightTime: 60,
    flareResistance: 0.5, chaffResistance: 0.5, notchResistance: 0.5, smoke: 0.3, length: 3.6, diameter: 0.18,
  };
}

const terrain: TerrainQuery = {
  size: 80_000,
  heightAt: () => 0,
  surfaceHeightAt: () => 0,
  isWater: () => false,
  lineOfSight: () => true,
  raycast: () => -1,
};

export function buildMock(scene: Scenario): MockSetup {
  const events = new EventBus();
  let nextId = 1;
  const player = new AircraftEntity(nextId++, 'f35a', 'blue', { name: 'VIPER 1', callsign: 'VIPER 1', radius: 8, rcs: 0.001 });
  player.isPlayer = true;
  const hdg = 30 * DEG;
  let pitch = 3 * DEG;
  let roll = 18 * DEG;
  if (scene === 'gun') {
    pitch = 6 * DEG;
    roll = 55 * DEG;
  }
  if (scene === 'ag' || scene === 'ccip') {
    pitch = -8 * DEG;
    roll = 4 * DEG;
  }
  if (scene === 'pullup') {
    pitch = -25 * DEG;
    roll = -10 * DEG;
  }
  player.position.set(-2000, scene === 'ag' || scene === 'ccip' ? 2600 : scene === 'pullup' ? 350 : 5200, 3000);
  quatFromHPR(hdg, pitch, roll, player.quaternion);
  const spd = 255;
  dirFromHeadingPitch(hdg + 1.5 * DEG, pitch - 3.5 * DEG, player.velocity).multiplyScalar(spd);
  const fl = player.flight;
  fl.alpha = 4.2 * DEG;
  fl.tas = spd;
  fl.ias = spd * 0.8;
  fl.mach = 0.84;
  fl.gLoad = scene === 'gun' ? 6.4 : scene === 'damage' ? 9.2 : 1.6;
  fl.gPeak = fl.gLoad;
  fl.altitude = player.position.y;
  fl.agl = player.position.y - 20;
  fl.verticalSpeed = scene === 'pullup' ? -110 : 9;
  fl.heading = hdg;
  fl.pitch = pitch;
  fl.roll = roll;
  fl.thrust = 120_000;
  fl.engineRpm = 0.97;
  fl.afterburner = scene === 'threat' ? 0.7 : 0;
  fl.fuel = scene === 'damage' ? 1300 : 5400;
  fl.fuelFlow = 1.35;
  fl.mass = 20_000;
  player.input.throttle = scene === 'threat' ? 1 : 0.84;
  player.rates.set(0, scene === 'gun' ? 0.22 : 0.02, scene === 'gun' ? 0.05 : 0);
  player.stores = [
    { weapon: 'aim120', count: 3, internal: true },
    { weapon: scene === 'ag' || scene === 'ccip' ? 'gbu31' : 'aim120', count: 2, internal: true },
    { weapon: 'aim9x', count: 2, internal: false },
  ];
  player.gunAmmo = scene === 'gun' ? 142 : 180;
  player.gunMaxAmmo = 180;
  player.flares = scene === 'threat' ? 3 : 22;
  player.chaff = 18;
  player.selectedWeapon = scene === 'gun' ? 'gun' : scene === '9x' ? 'aim9x' : scene === 'ag' || scene === 'ccip' ? 'gbu31' : 'aim120';
  player.bayDoors = scene === 'lock' ? 1 : 0;

  const aircraft: AircraftEntity[] = [player];
  const sams: SamSiteEntity[] = [];
  const ground: GroundTargetEntity[] = [];
  const missiles: MissileEntity[] = [];
  const byId = new Map<number, AnyEntity>([[player.id, player]]);
  const add = <T extends AnyEntity>(e: T): T => {
    byId.set(e.id, e);
    return e;
  };

  const fwd = dirFromHeadingPitch(hdg, 0);
  const right = new Vector3(Math.cos(hdg), 0, Math.sin(hdg));
  const at = (ahead: number, side: number, up: number) =>
    new Vector3().copy(player.position).addScaledVector(fwd, ahead).addScaledVector(right, side).add(new Vector3(0, up, 0));

  // hostile fighters
  const mig = add(new AircraftEntity(nextId++, 'mig29', 'red', { name: 'MIG-29', radius: 9 }));
  const migDist = scene === 'gun' ? 700 : scene === '9x' ? 3200 : 14_000;
  mig.position.copy(scene === 'gun' ? at(migDist, 60, 90) : at(migDist, 2400, 900));
  mig.velocity.copy(scene === 'gun' ? fwd.clone().multiplyScalar(220).addScaledVector(right, 70) : fwd.clone().multiplyScalar(-230).addScaledVector(right, -40));
  quatFromHPR(hdg + (scene === 'gun' ? 0.3 : Math.PI - 0.2), 0, scene === 'gun' ? 0.9 : 0, mig.quaternion);
  aircraft.push(mig);
  const su35 = add(new AircraftEntity(nextId++, 'su35', 'red', { name: 'SU-35', radius: 10 }));
  su35.position.copy(at(26_000, -9000, 1500));
  su35.velocity.copy(fwd).multiplyScalar(-240);
  aircraft.push(su35);
  const su57 = add(new AircraftEntity(nextId++, 'su57', 'red', { name: 'SU-57', radius: 10 }));
  su57.position.copy(at(-9000, 7000, 600));
  su57.velocity.copy(fwd).multiplyScalar(250);
  aircraft.push(su57);
  // friendly wingman
  const wing = add(new AircraftEntity(nextId++, 'f35a', 'blue', { name: 'VIPER 2', callsign: 'VIPER 2', radius: 8 }));
  wing.position.copy(at(600, -900, 60));
  wing.velocity.copy(player.velocity);
  wing.quaternion.copy(player.quaternion);
  aircraft.push(wing);

  // SAMs
  const sa6 = add(new SamSiteEntity(nextId++, 'sa6', 'red', { name: 'SA-6' }));
  sa6.position.copy(at(19_000, -6500, 0)).setY(0);
  sa6.known = true;
  sa6.engageRange = 20_000;
  sa6.radarOn = true;
  sa6.trackedTargetId = scene === 'threat' || scene === 'ag' ? player.id : null;
  sams.push(sa6);
  const sa10 = add(new SamSiteEntity(nextId++, 'sa10', 'red', { name: 'SA-10' }));
  sa10.position.copy(at(42_000, 12_000, 0)).setY(0);
  sa10.known = true;
  sa10.engageRange = 45_000;
  sams.push(sa10);

  // ground targets
  const ship = add(new GroundTargetEntity(nextId++, 'ship', 'red', { name: 'CORVETTE', radius: 40 }));
  ship.position.copy(at(scene === 'ag' || scene === 'ccip' ? 9000 : 11_000, scene === 'ag' ? 900 : -1500, 0)).setY(0);
  ground.push(ship);
  const fuel = add(new GroundTargetEntity(nextId++, 'fuel', 'red', { name: 'FUEL', radius: 20 }));
  fuel.position.copy(at(8000, 3200, 0)).setY(0);
  ground.push(fuel);

  // own missile in flight
  const aim120 = munition('aim120', 'AIM-120D', 'AMRAAM', 'active_radar');
  if (scene === 'lock' || scene === 'threat') {
    const m = add(new MissileEntity(nextId++, aim120, 'blue', player.id, mig.id));
    m.position.copy(player.position).lerp(mig.position, 0.3);
    m.velocity.subVectors(mig.position, player.position).normalize().multiplyScalar(1100);
    m.age = 4;
    m.seekerLocked = scene === 'threat';
    missiles.push(m);
  }
  // incoming
  if (scene === 'threat') {
    const r77 = add(new MissileEntity(nextId++, munition('r77', 'R-77', 'R-77', 'active_radar'), 'red', su35.id, player.id));
    r77.position.copy(at(-3000, -4500, 300));
    r77.velocity.subVectors(player.position, r77.position).normalize().multiplyScalar(900);
    missiles.push(r77);
    const sam = add(new MissileEntity(nextId++, munition('m_3m9', 'SA-6 3M9', 'SA-6', 'semi_active'), 'red', sa6.id, player.id));
    sam.position.copy(at(5000, -2500, -2000));
    sam.velocity.subVectors(player.position, sam.position).normalize().multiplyScalar(800);
    missiles.push(sam);
    const igla = add(new MissileEntity(nextId++, munition('m_igla', 'Igla', 'SA-18', 'ir'), 'red', sa6.id, player.id));
    igla.position.copy(at(-1500, 2500, -1200));
    missiles.push(igla);
    player.incoming = [
      { missileId: r77.id, bearing: -2.2, elevation: -0.05, distance: 5400, timeToImpact: 7.2, guidance: 'radar' },
      { missileId: sam.id, bearing: -0.45, elevation: -0.4, distance: 6000, timeToImpact: 3.4, guidance: 'radar' },
      { missileId: igla.id, bearing: 2.6, elevation: -0.3, distance: 3100, timeToImpact: 9.5, guidance: 'ir' },
    ];
  }

  // sensor contacts
  const contacts: RadarContact[] = [];
  const addContact = (e: AnyEntity, source: RadarContact['source'] = 'radar', stale = 0) => {
    contacts.push({ id: e.id, lastSeen: -stale, position: e.position.clone(), velocity: e.velocity.clone(), team: e.team, source });
  };
  addContact(mig);
  addContact(su35, 'das', 3);
  addContact(su57, 'datalink');
  addContact(wing, 'datalink');
  addContact(sa6, 'eots');
  addContact(ship, 'eots');
  addContact(fuel, 'eots');
  player.radar.contacts = contacts;
  const designated = scene === 'offscreen' ? su57.id : scene === 'ag' ? ship.id : scene === 'nav' || scene === 'ccip' ? null : mig.id;
  player.radar.designatedId = designated;
  player.radar.lockedId = scene === 'lock' || scene === 'threat' || scene === 'gun' || scene === 'damage' ? mig.id : null;
  player.radar.lockProgress = player.radar.lockedId ? 1 : 0.1;
  player.radar.groundPoint = scene === 'ag' ? ship.position.clone() : null;
  player.radar.emitting = scene !== 'offscreen';

  // RWR
  if (scene === 'threat' || scene === 'ag' || scene === 'aa') {
    player.rwr = [
      { sourceId: sa6.id, kind: 'sam', symbol: '6', bearing: -0.35, strength: 0.75, state: scene === 'threat' ? 'launch' : 'track', age: 5 },
      { sourceId: mig.id, kind: 'fighter', symbol: '29', bearing: 0.2, strength: 0.6, state: 'track', age: 2 },
      { sourceId: sa10.id, kind: 'sam', symbol: '10', bearing: 0.5, strength: 0.3, state: 'search', age: 1 },
      { sourceId: su35.id, kind: 'fighter', symbol: '35', bearing: -2.4, strength: 0.4, state: scene === 'threat' ? 'launch' : 'search', age: 1 },
    ];
  }

  // warnings / damage
  const warn = (...ids: WarningId[]) => ids.forEach((w) => player.warnings.add(w));
  if (scene === 'threat') warn('missile', 'spike', 'flares_low');
  if (scene === 'damage') {
    warn('engine_fire', 'hydraulics', 'bingo', 'damage', 'over_g');
    player.health = 46;
    player.damage.engine = 0.55;
    player.damage.hydraulics = 0.4;
    player.damage.fire = true;
  }
  if (scene === 'pullup') warn('pull_up', 'altitude', 'speed_low');

  let time = 0;
  const zone = (): LaunchZone | null => {
    const tgt = byId.get(player.radar.lockedId ?? player.radar.designatedId ?? -1);
    if (!tgt || tgt.team === player.team) return null;
    const w = player.selectedWeapon;
    const range = tgt.position.distanceTo(player.position);
    const rMax = w === 'aim9x' ? 8000 : w === 'gun' ? 1200 : w === 'gbu31' ? 14_000 : 30_000;
    const rNe = rMax * (w === 'aim9x' ? 0.6 : 0.42);
    return {
      weapon: w,
      targetId: tgt.id,
      range,
      rMin: w === 'aim9x' ? 300 : 1500,
      rNe,
      rMax,
      shoot: (scene === 'lock' || scene === '9x') && range < rMax,
      closure: 360,
      timeOfFlight: range / 900,
    };
  };

  const combat = {
    munitions: {} as CombatSystemApi['munitions'],
    update() {},
    applyLoadout() {},
    applyDefaultLoadout() {},
    cycleWeapon() {},
    selectWeapon() {},
    cycleTarget() {},
    designateNearestTo() {},
    designate(ac: AircraftEntity, id: number | null) {
      ac.radar.designatedId = id;
      ac.radar.lockedId = null;
      ac.radar.lockProgress = 0;
      events.emit('designate', { ownerId: ac.id, targetId: id });
    },
    setRadarEmitting(ac: AircraftEntity, e: boolean) {
      ac.radar.emitting = e;
    },
    remaining(ac: AircraftEntity, w: WeaponId) {
      if (w === 'gun') return ac.gunAmmo;
      let n = 0;
      for (const s of ac.stores) if (s.weapon === w) n += s.count;
      return n;
    },
    launchZone: () => zone(),
    launchZoneFor: () => zone()!,
    fire: () => null,
    irSeekerState: () =>
      scene === '9x'
        ? { state: 'locked' as const, targetId: mig.id, direction: new Vector3().subVectors(mig.position, player.position).normalize() }
        : { state: 'search' as const, targetId: null, direction: null },
    gunLeadPoint: () => (scene === 'gun' ? mig.position.clone().addScaledVector(mig.velocity, 0.75).add(new Vector3(0, 12, 0)) : null),
    bombImpactPoint: () => {
      if (scene === 'ag') return { point: ship.position.clone(), inRange: false, timeToRelease: Math.max(0, 14 - time) };
      if (scene === 'ccip') return { point: at(4200, 150, -player.position.y).setY(0), inRange: true, timeToRelease: 0 };
      return null;
    },
  } as unknown as CombatSystemApi;

  const world = {
    events,
    terrain,
    difficulty: DIFFICULTIES.veteran,
    combat,
    get time() {
      return time;
    },
    aircraft,
    missiles,
    sams,
    ground,
    decoys: [],
    projectiles: [],
    player,
    nextId: () => nextId++,
    getEntity: (id: number | null | undefined) => (id == null ? null : byId.get(id) ?? null),
    hostilesOf: () => [],
  } as unknown as SimWorld;

  // mission
  const wps: Waypoint[] = [
    { id: 'WP1', label: 'WP1 NAV', position: at(9000, -4000, 0).setY(1500), radius: 1500, kind: 'nav' },
    { id: 'WP2', label: 'WP2 CAP', position: at(22_000, 3000, 0).setY(3000), radius: 2000, kind: 'cap' },
    { id: 'WP3', label: 'WP3 RTB', position: new Vector3(-12_000, 50, 9000), radius: 2000, kind: 'rtb' },
  ];
  const objectives: ObjectiveStatus[] = [
    { id: 'o1', label: 'Splash the MiG-29 sweep', state: 'active', primary: true, progress: { done: 1, total: 2 } },
    { id: 'o2', label: 'Destroy the SA-6 on Rangitoto', state: 'pending', primary: true },
    { id: 'o3', label: 'Keep the MiGs off the North Shore', state: 'complete', primary: false },
  ];
  const mission = {
    def: { timeOfDay: 'day', theater: 'auckland', weather: 'clear' },
    state: 'running',
    objectives,
    waypoints: wps,
    currentWaypoint: wps[scene === 'nav' ? 0 : 1],
    hint: scene === 'nav' || scene === 'aa' ? 'Tap a target box or press TGT to designate, then hold for lock' : null,
    setup() {},
    update() {},
    result() {
      return null;
    },
  } as unknown as MissionRunnerApi;

  return {
    world,
    events,
    player,
    mission,
    tick(dt: number) {
      time += dt;
      if (scene === 'aa') player.radar.lockProgress = Math.min(0.95, 0.1 + time * 0.12);
      for (const m of missiles) if (m.shooterId === player.id) m.age += dt;
    },
  };
}

export const _q = new Quaternion();
