/**
 * F35-A — Instant Action generator: dogfight / SAM gauntlet / strike / survival, in any theatre
 * (Auckland uses real landmarks; the procedural theatres use generic layouts — pads and
 * features keep every SAM site and compound on dry, flat land).
 */
import type { InstantActionOptions, MissionDef, SceneryFeature } from '../../core/contracts';
import { mulberry32 } from '../../core/math';
import type { AircraftType, LoadoutId, SamType, TheaterId } from '../../core/types';
import type { AircraftGroupDef, GroundTargetDef, MissionScript, ObjectiveDef, SamSiteDef, XZ } from '../schema';
import { AKL_SEED, BASE_FEATURES, FEATURES, P, WAIHEKE_RUNWAY_HDG, flight, mission, runwayPoint, site, target, wingmen } from './common';

const FIGHTERS: AircraftType[] = ['mig29', 'su27', 'su35', 'su57'];

const THEATER_LABEL: Record<TheaterId, string> = {
  auckland: 'Auckland',
  desert: 'Desert',
  islands: 'Islands',
  mountains: 'Mountains',
  arctic: 'Arctic',
};

const MODE_TITLE: Record<InstantActionOptions['mode'], string> = {
  dogfight: 'Dogfight',
  sam_gauntlet: 'SAM Gauntlet',
  strike: 'Strike',
  survival: 'Survival',
};

interface Layout {
  player: { x: number; z: number; altitude: number; heading: number; speed: number };
  /** Enemy fighters arrive from here, heading `enemyHeading`. */
  enemyAt: XZ;
  enemyHeading: number;
  /** Strike / gauntlet target compound centre. */
  target: XZ;
  /** SAM belt positions, ordered along the route (first = nearest the player). */
  belt: XZ[];
  features: SceneryFeature[];
  /** Target is an airbase feature (runway heading) — for the strike layout. */
  airbase: { at: XZ; heading: number } | null;
}

function aucklandLayout(): Layout {
  return {
    player: { x: -12000, z: -1500, altitude: 5000, heading: 80, speed: 240 },
    enemyAt: { x: 22000, z: -20000 },
    enemyHeading: 240,
    target: P.waiC,
    belt: [P.rangSW, P.brownsIs, P.motuS, P.motuihe, P.waiW, P.rangE, P.waiS, P.motuN],
    features: [...BASE_FEATURES],
    airbase: { at: P.waiAirstrip, heading: WAIHEKE_RUNWAY_HDG },
  };
}

function genericLayout(): Layout {
  const belt: XZ[] = [];
  for (let i = 0; i < 8; i++) belt.push({ x: -10000 + i * 5000, z: (i % 2 === 0 ? 1 : -1) * (2500 + (i % 3) * 1200) });
  return {
    player: { x: -31000, z: 2000, altitude: 5000, heading: 90, speed: 240 },
    enemyAt: { x: 12000, z: -12000 },
    enemyHeading: 245,
    target: { x: 29000, z: 0 },
    belt,
    features: [
      { type: 'airbase', x: -28000, z: 22000, rotation: 45 },
      { type: 'airbase', x: 24000, z: -14000, rotation: 90 },
      { type: 'town', x: 30000, z: 6000 },
      { type: 'industrial', x: 29000, z: 0, size: 0.7 },
      { type: 'village', x: 4000, z: 14000 },
    ],
    airbase: { at: { x: 24000, z: -14000 }, heading: 90 },
  };
}

/** Enemy type for the i-th aircraft. */
function pickType(opts: InstantActionOptions, rng: () => number): AircraftType {
  if (opts.enemyType !== 'mixed') return opts.enemyType;
  return FIGHTERS[Math.floor(rng() * FIGHTERS.length) % FIGHTERS.length];
}

/** Split `n` enemies into pairs (last group may be a single). */
function enemyFlights(opts: InstantActionOptions, n: number, lay: Layout, rng: () => number, extra: Partial<AircraftGroupDef> = {}): AircraftGroupDef[] {
  const out: AircraftGroupDef[] = [];
  const h = (lay.enemyHeading * Math.PI) / 180;
  const rx = Math.cos(h);
  const rz = Math.sin(h);
  let left = n;
  let i = 0;
  while (left > 0) {
    const size = Math.min(2, left);
    left -= size;
    const lateral = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * 5000;
    const back = Math.floor(i / 2) * 4000;
    const at = {
      x: Math.round(lay.enemyAt.x + rx * lateral - Math.sin(h) * back),
      z: Math.round(lay.enemyAt.z + rz * lateral + Math.cos(h) * back),
    };
    out.push(
      flight(`bandits${i + 1}`, pickType(opts, rng), size, at, 5500 + ((i * 700) % 2800), lay.enemyHeading, 245, i % 2 === 0 ? 'fighter' : 'interceptor', {
        fixedCount: true,
        task: i % 2 === 0 ? { kind: 'patrol', x: Math.round((lay.enemyAt.x + lay.player.x) / 2), z: Math.round((lay.enemyAt.z + lay.player.z) / 2), radius: 9000, altitude: 5500 } : { kind: 'attack_player' },
        ...extra,
      }),
    );
    i++;
  }
  return out;
}

const BELT_TYPES: SamType[] = ['sa6', 'zsu23', 'sa8', 'sa15', 'sa6', 'zsu23', 'sa8', 'sa15'];

export function buildInstantMissionSeeded(opts: InstantActionOptions, seed: number): MissionDef {
  const rng = mulberry32(seed >>> 0);
  const akl = opts.theater === 'auckland';
  const lay = akl ? aucklandLayout() : genericLayout();
  const n = Math.max(1, Math.min(8, Math.round(opts.enemyCount)));
  const groups: AircraftGroupDef[] = [];
  const sams: SamSiteDef[] = [];
  const ground: GroundTargetDef[] = [];
  const objectives: ObjectiveDef[] = [];
  const features = [...lay.features];
  let loadout: LoadoutId = 'a2a_beast';
  let allowed: LoadoutId[] = ['a2a_beast', 'a2a_stealth'];
  let briefing: string[] = [];
  const script: Partial<MissionScript> = {};

  switch (opts.mode) {
    case 'dogfight': {
      if (n >= 3) groups.push(wingmen(1, lay.player, { loadout: 'a2a_beast' }));
      const flights = enemyFlights(opts, n, lay, rng);
      groups.push(...flights);
      objectives.push({ id: 'o_kill', kind: 'destroy', groups: flights.map((f) => f.id), label: `Splash all ${n} bandit${n > 1 ? 's' : ''}`, primary: true });
      briefing = [`${n} hostile fighter${n > 1 ? 's' : ''} inbound. Weapons free — splash them all.`, n >= 3 ? 'Viper 2 is on your wing.' : 'You are on your own.'];
      script.parTime = 180 + n * 45;
      break;
    }
    case 'sam_gauntlet': {
      loadout = 'sead_stealth';
      allowed = ['sead_stealth', 'strike_stealth', 'strike_beast'];
      const count = Math.max(2, Math.min(lay.belt.length, n + 1));
      for (let i = 0; i < count; i++) {
        const type = BELT_TYPES[i % BELT_TYPES.length];
        sams.push(site(`sam${i + 1}`, 'belt', type, lay.belt[i], { emcon: i >= 3 && rng() < 0.35 }));
      }
      ground.push(
        target('fuel1', 'target', 'fuel', { x: lay.target.x - 120, z: lay.target.z }),
        target('fuel2', 'target', 'fuel', { x: lay.target.x + 120, z: lay.target.z + 60 }),
        target('bunker', 'target', 'bunker', { x: lay.target.x, z: lay.target.z + 260 }),
      );
      objectives.push(
        { id: 'o_target', kind: 'destroy', groups: ['target'], label: 'Destroy the depot at the end of the gauntlet', primary: true },
        { id: 'o_belt', kind: 'destroy', groups: ['belt'], label: 'Destroy every SAM in the belt', primary: false },
      );
      if (n >= 4) groups.push(flight('cap', pickType(opts, rng), 2, lay.enemyAt, 6000, lay.enemyHeading, 240, 'cap', { fixedCount: true, spawn: { kind: 'time', t: 120 }, task: { kind: 'patrol', x: lay.target.x, z: lay.target.z, radius: 8000, altitude: 6000 } }));
      briefing = [`A belt of ${count} SAM sites guards a depot. Some sites are silent until you are close.`, 'Kill the depot. Kill the belt if you can. Stay low, stay stealthy, fire AARGMs at anything that emits.'];
      script.parTime = 420;
      break;
    }
    case 'strike': {
      loadout = 'strike_stealth';
      allowed = ['strike_stealth', 'strike_beast', 'sead_stealth'];
      const ab = lay.airbase!;
      const rw = (v: number, u: number) => runwayPoint(ab.at, ab.heading, v, u);
      if (akl && !features.includes(FEATURES.waihekeStrip)) features.push(FEATURES.waihekeStrip);
      ground.push(
        target('jet1', 'parked', 'parked_jet', rw(-150, 320), { name: 'Parked Jet' }),
        target('jet2', 'parked', 'parked_jet', rw(-90, 320), { name: 'Parked Jet' }),
        target('jet3', 'parked', 'parked_jet', rw(120, 320), { name: 'Parked Jet' }),
        target('hangar1', 'hangars', 'hangar', rw(-300, 560)),
        target('hangar2', 'hangars', 'hangar', rw(100, 560)),
        target('fuel1', 'fuel', 'fuel', rw(600, 620)),
      );
      sams.push(site('zsu1', 'defences', 'zsu23', rw(-650, 150)), site('zsu2', 'defences', 'zsu23', rw(650, 150)));
      if (n >= 2) sams.push(site('sam1', 'defences', akl ? 'sa6' : 'sa8', akl ? P.waiW : rw(-1800, -1200)));
      if (n >= 4) sams.push(site('sam2', 'defences', 'sa15', akl ? P.waiC : rw(1600, 1100)));
      const cap = enemyFlights(opts, Math.max(1, Math.ceil(n / 2)), lay, rng, { role: 'cap' });
      groups.push(...cap);
      objectives.push(
        { id: 'o_jets', kind: 'destroy', groups: ['parked'], label: 'Destroy the parked jets', primary: true },
        { id: 'o_hangars', kind: 'destroy', groups: ['hangars', 'fuel'], label: 'Destroy the hangars and fuel', primary: false },
        { id: 'o_cap', kind: 'destroy', groups: cap.map((g) => g.id), label: 'Splash the CAP', primary: false },
      );
      briefing = ['Enemy airfield. Destroy the parked jets on the apron.', 'Shilkas guard the runway and fighters hold a CAP overhead.'];
      script.parTime = 420;
      break;
    }
    case 'survival': {
      const types = opts.enemyType === 'mixed' ? FIGHTERS : [opts.enemyType];
      script.survival = {
        types,
        baseCount: Math.max(1, Math.round(n / 2)),
        growth: 0.5,
        maxCount: 8,
        skillStart: 0.3,
        skillStep: 0.06,
        spawnDistance: 30000,
        interWaveDelay: 8,
        rearm: true,
      };
      objectives.push({ id: 'o_survive', kind: 'survive', seconds: 36000, label: 'Survive as many waves as you can', primary: true });
      briefing = ['Endless waves of bandits, each bigger and sharper than the last. You are rearmed between waves.', 'How long can you last?'];
      script.parTime = 600;
      script.awacs = { pictureInterval: 0 };
      break;
    }
  }

  const title = `${MODE_TITLE[opts.mode]} — ${THEATER_LABEL[opts.theater]}`;
  return mission({
    id: `ia_${opts.mode}_${opts.theater}`,
    kind: 'instant',
    index: 0,
    title,
    subtitle: `Instant Action · ${THEATER_LABEL[opts.theater]}`,
    theater: opts.theater,
    timeOfDay: opts.timeOfDay,
    weather: opts.weather,
    seed: akl ? AKL_SEED : (seed % 100000) + 1,
    briefing,
    recommendedLoadout: loadout,
    allowedLoadouts: allowed,
    player: lay.player,
    features,
    script: { ...script, groups, sams, ground, objectives, waypoints: objectives.some((o) => o.id === 'o_target' || o.id === 'o_jets') ? [{ id: 'wp_t', label: 'Target', kind: 'target', x: opts.mode === 'strike' ? lay.airbase!.at.x : lay.target.x, z: opts.mode === 'strike' ? lay.airbase!.at.z : lay.target.z, objective: objectives[0].id }] : [], triggers: [] },
  });
}

/** Instant Action mission (fresh random seed each time). */
export function buildInstantMission(opts: InstantActionOptions): MissionDef {
  return buildInstantMissionSeeded(opts, Math.floor(Math.random() * 0x7fffffff));
}
