/**
 * F35-A — loadouts, store stations and weapon selection.
 *
 * Store stations use the WeaponId "slots" of the shared contract. For enemy jets the slots
 * map to their own munitions: 'aim120' = radar BVR missile (R-27ER semi-active or R-77 active),
 * 'aim9x' = IR dogfight missile (R-73). The actual munition of each station is tracked here
 * (stationMunition) and is visible on launched missiles as `missile.def`. Enemy strike jets carry
 * the KAB-500S on the 'gbu31' (GPS bomb) slot.
 */
import type { AircraftType, LoadoutId, MunitionId, WeaponId } from '../../core/types';
import { LOADOUTS } from '../../core/data';
import type { SimWorld } from '../api';
import type { AircraftEntity, RadarMode, StoreStation } from '../entities';
import { acState } from './context';
import { GUNS, type GunDef } from './defs';
import { TYPE_IR, TYPE_RCS } from '../sensors/signatures';

/** Weapon cycle order; the gun is always last. */
export const WEAPON_ORDER: readonly WeaponId[] = ['aim120', 'aim9x', 'gbu31', 'gbu39', 'gbu53', 'aargm', 'gun'];

type StoreWeapon = Exclude<WeaponId, 'gun'>;

interface DefaultStore {
  weapon: StoreWeapon;
  munition: MunitionId;
  count: number;
  internal: boolean;
}

interface DefaultLoadout {
  stores: DefaultStore[];
  gunAmmo: number;
  flares: number;
  chaff: number;
}

/** Typical enemy loadouts (applyDefaultLoadout). */
const ENEMY_LOADOUTS: Partial<Record<AircraftType, DefaultLoadout>> = {
  mig29: {
    stores: [
      { weapon: 'aim120', munition: 'r27', count: 2, internal: false },
      { weapon: 'aim9x', munition: 'r73', count: 4, internal: false },
    ],
    gunAmmo: 150,
    flares: 30,
    chaff: 30,
  },
  // baseline Su-27S: semi-active R-27R/ER + R-73 (the active R-77 is for the Su-35 / Su-57)
  su27: {
    stores: [
      { weapon: 'aim120', munition: 'r27', count: 4, internal: false },
      { weapon: 'aim9x', munition: 'r73', count: 4, internal: false },
    ],
    gunAmmo: 150,
    flares: 32,
    chaff: 32,
  },
  su35: {
    stores: [
      { weapon: 'aim120', munition: 'r77', count: 4, internal: false },
      { weapon: 'aim9x', munition: 'r73', count: 2, internal: false },
    ],
    gunAmmo: 150,
    flares: 32,
    chaff: 32,
  },
  su57: {
    stores: [
      { weapon: 'aim120', munition: 'r77', count: 4, internal: true },
      { weapon: 'aim9x', munition: 'r73', count: 2, internal: true },
    ],
    gunAmmo: 150,
    flares: 30,
    chaff: 30,
  },
  a320: { stores: [], gunAmmo: 0, flares: 0, chaff: 0 },
  shahed136: { stores: [], gunAmmo: 0, flares: 0, chaff: 0 },
};

/**
 * Enemy strike loadouts (applyDefaultLoadout with variant 'strike'): KAB-500S satellite-guided
 * bombs on the 'gbu31' slot plus a pair of R-73s for self-defence. Types without an entry fall
 * back to STRIKE_FALLBACK.
 */
const ENEMY_STRIKE_LOADOUTS: Partial<Record<AircraftType, DefaultLoadout>> = {
  mig29: {
    stores: [
      { weapon: 'gbu31', munition: 'kab500', count: 2, internal: false },
      { weapon: 'aim9x', munition: 'r73', count: 2, internal: false },
    ],
    gunAmmo: 150,
    flares: 30,
    chaff: 30,
  },
};
const STRIKE_FALLBACK: DefaultLoadout = {
  stores: [
    { weapon: 'gbu31', munition: 'kab500', count: 4, internal: false },
    { weapon: 'aim9x', munition: 'r73', count: 2, internal: false },
  ],
  gunAmmo: 150,
  flares: 32,
  chaff: 32,
};

/** Enemy loadout variant: the type's usual air-to-air fit, or air-to-ground ('strike'). */
export type EnemyLoadout = 'default' | 'strike';

/** Gun fitted to an aircraft type (null = none). */
export function gunFor(ac: AircraftEntity): GunDef | null {
  if (ac.gunMaxAmmo <= 0 && ac.gunAmmo <= 0) return null;
  return ac.type === 'f35a' ? GUNS.gau22 : GUNS.gsh301;
}

/** Fill rcsBase / irBase from the type tables if the spawner left the constructor defaults. */
function ensureSignatures(ac: AircraftEntity): void {
  if (ac.rcsBase === 5 && TYPE_RCS[ac.type] !== undefined) ac.rcsBase = TYPE_RCS[ac.type];
  if (ac.irBase === 1 && TYPE_IR[ac.type] !== undefined) ac.irBase = TYPE_IR[ac.type];
}

/** Default munition for a weapon slot on an aircraft (no station bookkeeping). */
export function defaultMunitionFor(ac: AircraftEntity, weapon: StoreWeapon): MunitionId {
  if (ac.type === 'f35a') return weapon;
  if (weapon === 'aim120') return ac.type === 'mig29' ? 'r27' : 'r77';
  if (weapon === 'aim9x') return 'r73';
  if (weapon === 'gbu31') return 'kab500';
  return weapon;
}

/** Munition carried on a specific store station. */
export function stationMunition(ac: AircraftEntity, index: number): MunitionId {
  const st = acState(ac);
  const station = ac.stores[index];
  if (st.storesRef === ac.stores && st.stationMunitions && st.stationMunitions[index]) return st.stationMunitions[index];
  return defaultMunitionFor(ac, station.weapon);
}

/** Rounds remaining for a weapon slot. */
export function remaining(ac: AircraftEntity, weapon: WeaponId): number {
  if (weapon === 'gun') return ac.gunAmmo;
  let n = 0;
  for (const s of ac.stores) if (s.weapon === weapon) n += s.count;
  return n;
}

/** Total stores left (missiles + bombs). */
export function totalStores(ac: AircraftEntity): number {
  let n = 0;
  for (const s of ac.stores) n += s.count;
  return n;
}

/**
 * Pick the station to release a weapon from: external pylons first (beast mode), then the bays.
 * `prefer` lets the caller favour a specific munition (e.g. R-77 over R-27). Returns -1 if empty.
 */
export function pickStation(ac: AircraftEntity, weapon: StoreWeapon, prefer?: (m: MunitionId) => number): number {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < ac.stores.length; i++) {
    const s = ac.stores[i];
    if (s.weapon !== weapon || s.count <= 0) continue;
    let score = s.internal ? 0 : 10;
    if (prefer) score += prefer(stationMunition(ac, i)) * 100;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export function radarModeFor(weapon: WeaponId): RadarMode {
  if (weapon === 'aim9x' || weapon === 'gun') return 'acm';
  if (weapon === 'aim120') return 'search';
  return 'ground';
}

const MODE_RANGE: Record<RadarMode, number> = { search: 74_000, acm: 18_500, ground: 37_000 };

function setSelected(ac: AircraftEntity, weapon: WeaponId, world: SimWorld | null): void {
  const changed = ac.selectedWeapon !== weapon;
  ac.selectedWeapon = weapon;
  const mode = radarModeFor(weapon);
  if (ac.radar.mode !== mode) {
    ac.radar.mode = mode;
    ac.radar.range = MODE_RANGE[mode];
  }
  if (changed && world) world.events.emit('weapon:select', { ownerId: ac.id, weapon });
}

/** Directly select a weapon (no-op if none left). */
export function selectWeapon(ac: AircraftEntity, weapon: WeaponId, world: SimWorld | null): void {
  if (weapon === 'gun' ? gunFor(ac) === null : remaining(ac, weapon) <= 0) return;
  setSelected(ac, weapon, world);
}

/** Cycle to the next weapon type that has rounds (gun always last). */
export function cycleWeapon(ac: AircraftEntity, world: SimWorld | null): void {
  const start = Math.max(0, WEAPON_ORDER.indexOf(ac.selectedWeapon));
  for (let k = 1; k <= WEAPON_ORDER.length; k++) {
    const w = WEAPON_ORDER[(start + k) % WEAPON_ORDER.length];
    if (w === 'gun' ? gunFor(ac) !== null : remaining(ac, w) > 0) {
      setSelected(ac, w, world);
      return;
    }
  }
}

/** After a type runs dry: pick another of the same kind (A/A or A/G), else anything, else the gun. */
export function autoReselect(ac: AircraftEntity, world: SimWorld | null): void {
  if (ac.selectedWeapon === 'gun' || remaining(ac, ac.selectedWeapon) > 0) return;
  const aa = ac.selectedWeapon === 'aim120' || ac.selectedWeapon === 'aim9x';
  const sameKind: WeaponId[] = aa ? ['aim120', 'aim9x'] : ['aargm', 'gbu53', 'gbu39', 'gbu31'];
  for (const w of sameKind) if (remaining(ac, w) > 0) return setSelected(ac, w, world);
  for (const w of WEAPON_ORDER) if (w !== 'gun' && remaining(ac, w) > 0) return setSelected(ac, w, world);
  if (gunFor(ac)) setSelected(ac, 'gun', world);
}

function initialWeapon(ac: AircraftEntity, role: 'aa' | 'ag' | 'sead' | 'none'): WeaponId {
  const order: WeaponId[] =
    role === 'ag'
      ? ['gbu31', 'gbu53', 'gbu39', 'aargm', 'aim120', 'aim9x']
      : role === 'sead'
        ? ['aargm', 'gbu53', 'gbu39', 'gbu31', 'aim120', 'aim9x']
        : ['aim120', 'aim9x', 'gbu31', 'gbu53', 'gbu39', 'aargm'];
  for (const w of order) if (remaining(ac, w) > 0) return w;
  return 'gun';
}

/** Equip an aircraft with a player/friendly loadout from LOADOUTS. */
export function applyLoadout(ac: AircraftEntity, id: LoadoutId, world: SimWorld | null = null): void {
  const def = LOADOUTS[id] ?? LOADOUTS.a2a_stealth;
  ensureSignatures(ac);
  const st = acState(ac);
  ac.loadout = def.id;
  ac.stores = def.stores.map((s): StoreStation => ({ weapon: s.weapon, count: s.count, internal: s.internal }));
  st.storesRef = ac.stores;
  st.stationMunitions = ac.stores.map((s) => defaultMunitionFor(ac, s.weapon));
  ac.gunAmmo = ac.gunMaxAmmo = def.gunAmmo;
  ac.flares = def.flares;
  ac.chaff = def.chaff;
  ac.rcsMultiplier = st.rcsMultiplier = def.rcsMultiplier;
  st.winchester = false;
  ac.selectedWeapon = 'gun'; // force a change so the mode/range get set
  setSelected(ac, initialWeapon(ac, def.role), world);
}

/** Equip an AI aircraft with its typical weapons (by type). */
export function applyDefaultLoadout(ac: AircraftEntity, world: SimWorld | null = null, variant: EnemyLoadout = 'default'): void {
  if (ac.type === 'f35a') return applyLoadout(ac, variant === 'strike' ? 'strike_stealth' : 'a2a_stealth', world);
  ensureSignatures(ac);
  const def =
    variant === 'strike' ? (ENEMY_STRIKE_LOADOUTS[ac.type] ?? STRIKE_FALLBACK) : (ENEMY_LOADOUTS[ac.type] ?? { stores: [], gunAmmo: 150, flares: 30, chaff: 30 });
  const st = acState(ac);
  ac.loadout = null;
  ac.stores = def.stores.map((s): StoreStation => ({ weapon: s.weapon, count: s.count, internal: s.internal }));
  st.storesRef = ac.stores;
  st.stationMunitions = def.stores.map((s) => s.munition);
  ac.gunAmmo = ac.gunMaxAmmo = def.gunAmmo;
  ac.flares = def.flares;
  ac.chaff = def.chaff;
  ac.rcsMultiplier = st.rcsMultiplier = 1;
  ac.selectedWeapon = 'gun';
  setSelected(ac, initialWeapon(ac, variant === 'strike' ? 'ag' : 'aa'), world);
}
