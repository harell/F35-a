/**
 * F35-A — Instant Action generator: dogfight / SAM gauntlet / strike / defend, in any theatre
 * (Auckland uses real landmarks; the procedural theatres use generic layouts — pads and
 * features keep every SAM site and compound on dry, flat land).
 */
import type { InstantActionOptions, MissionDef, SceneryFeature } from '../../core/contracts';
import { mulberry32 } from '../../core/math';
import type { AircraftType, LoadoutId, SamType, TheaterId } from '../../core/types';
import { WIRI_TANKS } from '../../core/sites';
import type { AircraftGroupDef, Condition, GroundTargetDef, HintDef, MissionScript, ObjectiveDef, SamSiteDef, TriggerDef, WaypointDef, XZ } from '../schema';
import { AKL_SEED, BASE_FEATURES, FEATURES, P, WAIHEKE_RUNWAY_HDG, flight, mission, runwayPoint, site, target, wingmen } from './common';

const FIGHTERS: AircraftType[] = ['mig29', 'su27', 'su35', 'su57'];
const DS_CALL = 'DARKSTAR';
const PLAYER_CALL = 'Viper 1';

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
  defend: 'Defend',
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
  /** Defend: the friendly site, the player's start and where the strike package comes from. */
  defend: { site: XZ; player: Layout['player']; raidFrom: XZ; low: number };
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
    // the raid comes in low from the Firth of Thames, over Whitford and Flat Bush
    defend: { site: P.wiri, player: { x: -5000, z: 5000, altitude: 5000, heading: 125, speed: 240 }, raidFrom: { x: 35000, z: 10000 }, low: 300 },
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
    defend: { site: { x: -14000, z: 9000 }, player: { x: -31000, z: 2000, altitude: 5000, heading: 90, speed: 240 }, raidFrom: { x: 26000, z: -6000 }, low: 700 },
  };
}

/** Enemy type for a flight ('mixed' draws from every fighter type). */
function pickType(opts: InstantActionOptions, rng: () => number): AircraftType {
  if (opts.enemyType !== 'mixed') return opts.enemyType;
  return FIGHTERS[Math.floor(rng() * FIGHTERS.length) % FIGHTERS.length];
}

/**
 * 'mixed' only: the modern Su-35 / Su-57 are Veteran / Ace opponents — below that the flight is
 * a MiG-29 or Su-27 instead (resolved by the runner for the difficulty being flown).
 */
function mixedDowngrade(opts: InstantActionOptions, type: AircraftType, rng: () => number): Partial<AircraftGroupDef> {
  if (opts.enemyType !== 'mixed' || (type !== 'su35' && type !== 'su57')) return {};
  return { downgrade: { below: 'veteran', type: rng() < 0.5 ? 'mig29' : 'su27' } };
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
    const type = pickType(opts, rng);
    out.push(
      // sizes follow the difficulty (script.scaleEnemyTotal: the total scales, not each pair)
      flight(`bandits${i + 1}`, type, size, at, 5500 + ((i * 700) % 2800), lay.enemyHeading, 245, i % 2 === 0 ? 'fighter' : 'interceptor', {
        task: i % 2 === 0 ? { kind: 'patrol', x: Math.round((lay.enemyAt.x + lay.player.x) / 2), z: Math.round((lay.enemyAt.z + lay.player.z) / 2), radius: 9000, altitude: 5500 } : { kind: 'attack_player' },
        ...mixedDowngrade(opts, type, rng),
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
  // Air-to-air defaults to the stealth loadout (internal AIM-120s, low RCS): beast mode's
  // external pylons multiply the RCS ~40× and let Flanker radars find the jet at ~17 km.
  let loadout: LoadoutId = 'a2a_stealth';
  let allowed: LoadoutId[] = ['a2a_stealth', 'a2a_beast'];
  let briefing: string[] = [];
  let player = lay.player;
  let waypoints: WaypointDef[] | null = null;
  const script: Partial<MissionScript> = {};

  switch (opts.mode) {
    case 'dogfight': {
      if (n >= 3) groups.push(wingmen(1, lay.player, { loadout: 'a2a_beast' }));
      const flights = enemyFlights(opts, n, lay, rng);
      groups.push(...flights);
      objectives.push({ id: 'o_kill', kind: 'destroy', groups: flights.map((f) => f.id), label: n > 1 ? 'Splash all the bandits' : 'Splash the bandit', primary: true });
      briefing = [
        `About ${n} hostile fighter${n > 1 ? 's' : ''} inbound (fewer on Recruit, more on Ace). Weapons free — splash them all.`,
        opts.enemyType === 'mixed' ? 'Mixed types: MiG-29s and Su-27s — Su-35s and Su-57s join on Veteran and Ace.' : '',
        n >= 3 ? 'Viper 2 is on your wing.' : 'You are on your own.',
        'Stealth loadout: stay unseen and shoot first. Beast mode carries more missiles but they see you from much farther out.',
      ].filter(Boolean);
      script.scaleEnemyTotal = true;
      script.parTime = 180 + n * 45;
      break;
    }
    case 'sam_gauntlet': {
      loadout = 'sead_stealth';
      allowed = ['sead_stealth', 'strike_stealth', 'strike_beast', 'strike_sdb2'];
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
      if (n >= 4) {
        const capType = pickType(opts, rng);
        groups.push(
          flight('cap', capType, 2, lay.enemyAt, 6000, lay.enemyHeading, 240, 'cap', {
            spawn: { kind: 'time', t: 120 },
            task: { kind: 'patrol', x: lay.target.x, z: lay.target.z, radius: 8000, altitude: 6000 },
            ...mixedDowngrade(opts, capType, rng),
          }),
        );
      }
      briefing = [
        `A belt of ${count} SAM sites guards a depot. Some sites are silent until you are close.`,
        ...(n >= 4 ? ['Two fighters launch to cover the depot about two minutes in: keep your AMRAAMs for them.'] : []),
        'Kill the depot. Kill the belt if you can. Stay low, stay stealthy, fire AARGMs at anything that emits.',
      ];
      script.parTime = 420;
      break;
    }
    case 'strike': {
      loadout = 'strike_stealth';
      allowed = ['strike_stealth', 'strike_beast', 'sead_stealth', 'strike_sdb2'];
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
      // the SA-15 Tor shoots down JDAMs: Veteran and up only, as in c04
      if (n >= 4) sams.push(site('sam2', 'defences', 'sa15', akl ? P.waiC : rw(1600, 1100), { minDifficulty: 'veteran' }));
      const cap = enemyFlights(opts, Math.max(1, Math.ceil(n / 2)), lay, rng, { role: 'cap' });
      groups.push(...cap);
      script.scaleEnemyTotal = true;
      objectives.push(
        { id: 'o_jets', kind: 'destroy', groups: ['parked'], label: 'Destroy the parked jets', primary: true },
        { id: 'o_hangars', kind: 'destroy', groups: ['hangars', 'fuel'], label: 'Destroy the hangars and fuel', primary: false },
        { id: 'o_cap', kind: 'destroy', groups: cap.map((g) => g.id), label: 'Splash the CAP', primary: false },
      );
      briefing = ['Enemy airfield. Destroy the parked jets on the apron.', 'Shilkas guard the runway and fighters hold a CAP overhead.'];
      script.parTime = 420;
      break;
    }
    case 'defend': {
      const d = defendScenario(opts, n, lay, akl, rng);
      groups.push(...d.groups);
      ground.push(...d.ground);
      objectives.push(...d.objectives);
      player = lay.defend.player;
      waypoints = d.waypoints;
      script.triggers = d.triggers;
      script.hints = d.hints;
      script.opening = d.opening;
      script.successText = d.successText;
      briefing = d.briefing;
      script.parTime = 360;
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
    player,
    features,
    script: { triggers: [], ...script, groups, sams, ground, objectives, waypoints: waypoints ?? defaultWaypoints(opts, lay, objectives) },
  });
}

/** Steering cue on the strike / gauntlet target (none for the other modes). */
function defaultWaypoints(opts: InstantActionOptions, lay: Layout, objectives: ObjectiveDef[]): WaypointDef[] {
  if (!objectives.some((o) => o.id === 'o_target' || o.id === 'o_jets')) return [];
  const at = opts.mode === 'strike' ? lay.airbase!.at : lay.target;
  return [{ id: 'wp_t', label: 'Target', kind: 'target', x: at.x, z: at.z, objective: objectives[0].id }];
}

/** Defend: tanks that must survive (primary), out of the 9 fuel tanks at Wiri. */
export const DEFEND_MIN_TANKS = 6;

/**
 * Fuel tanks of the defended site as friendly ground targets: the Wiri terminal's real tanks in
 * Auckland (drawn by the scenery), a 3 × 3 farm elsewhere.
 */
export function defendTanks(lay: Layout, akl: boolean): GroundTargetDef[] {
  const opts = { team: 'blue' as const, name: 'Fuel Tank' };
  if (akl) return WIRI_TANKS.filter((t) => t.fuel).map((t, i) => target(`wiri${i}`, 'wiri', 'fuel', t, { ...opts, scenery: true }));
  const out: GroundTargetDef[] = [];
  for (let i = 0; i < 9; i++) out.push(target(`wiri${i}`, 'wiri', 'fuel', { x: lay.defend.site.x + ((i % 3) - 1) * 90, z: lay.defend.site.z + (Math.floor(i / 3) - 1) * 90 }, opts));
  return out;
}

interface DefendParts {
  groups: AircraftGroupDef[];
  ground: GroundTargetDef[];
  objectives: ObjectiveDef[];
  waypoints: WaypointDef[];
  triggers: TriggerDef[];
  hints: HintDef[];
  opening: MissionScript['opening'];
  successText: string;
  briefing: string[];
}

/**
 * Defend (issue #49): an enemy strike package (Flankers with KAB-500S guided bombs, low level)
 * and its fighter escort come for the friendly fuel terminal. The strikers fly low to 20 km out,
 * climb to bombing height by the IP 13 km out, then roll in (FighterBrain's StrikePlanner on an 'attack_group' task: each jet takes
 * its own tank and moves on to the next). Keep DEFEND_MIN_TANKS of the 9 tanks standing until the
 * strikers are shot down or driven off.
 */
function defendScenario(opts: InstantActionOptions, n: number, lay: Layout, akl: boolean, rng: () => number): DefendParts {
  const site = lay.defend.site;
  const from = lay.defend.raidFrom;
  const low = lay.defend.low;
  const dx = from.x - site.x;
  const dz = from.z - site.z;
  const dist = Math.hypot(dx, dz);
  const ux = dx / dist;
  const uz = dz / dist;
  /** Point on the raid's track `r` metres out from the site. */
  const out = (r: number): XZ => ({ x: Math.round(site.x + ux * r), z: Math.round(site.z + uz * r) });
  // low until 20 km out, climb to bombing height by the IP 13 km out, then roll in on the tanks
  const climb = out(20_000);
  const ip = out(13_000);
  const bombAlt = low + 3_700;
  const inbound = Math.round(((Math.atan2(-ux, uz) * 180) / Math.PI + 360) % 360);
  // strike jets: the chosen Flanker / Fulcrum, else Su-27s (the Su-57 and the heavies don't carry KABs here)
  const strikeType: AircraftType = opts.enemyType === 'mig29' || opts.enemyType === 'su27' || opts.enemyType === 'su35' ? opts.enemyType : 'su27';
  const strikers = Math.max(2, Math.min(4, Math.ceil(n / 2)));
  const escorts = Math.max(0, Math.min(4, n - strikers));
  let escortType = pickType(opts, rng);
  if (!FIGHTERS.includes(escortType)) escortType = 'mig29';

  const groups: AircraftGroupDef[] = [
    flight('strikers', strikeType, strikers, from, low, inbound, 235, 'fighter', {
      maxCount: 4,
      formation: 'echelon',
      spacing: 400,
      enemyLoadout: 'strike',
      noun: 'strikers',
      callsign: 'Striker',
      commitAfter: 0,
      task: { kind: 'route', points: [{ ...climb, altitude: low }, { ...ip, altitude: bombAlt }] },
    }),
  ];
  if (n >= 3) groups.push(wingmen(1, lay.defend.player, { loadout: 'a2a_stealth' }));
  if (escorts > 0) {
    const at = { x: Math.round(from.x + uz * 3000), z: Math.round(from.z - ux * 3000) };
    groups.push(
      flight('escort', escortType, escorts, at, 4500, inbound, 245, 'escort', {
        maxCount: 4,
        task: { kind: 'escort_group', group: 'strikers' },
        ...mixedDowngrade(opts, escortType, rng),
      }),
    );
  }
  const total = 9;
  const strikersBeaten: Condition = { kind: 'group_defeated', group: 'strikers' };
  /** 20 s after the strikers are shot down / driven off and their bombs have landed (a KAB from 10 km falls for ~50 s). */
  const strikersDone: Condition = { kind: 'trigger', id: 't_clear' };
  const objectives: ObjectiveDef[] = [
    {
      id: 'o_tanks',
      kind: 'protect',
      group: 'wiri',
      minSurvivors: DEFEND_MIN_TANKS,
      until: strikersDone,
      tally: 'Fuel tanks saved',
      label: `Keep at least ${DEFEND_MIN_TANKS} of the ${total} fuel tanks standing`,
      primary: true,
    },
    { id: 'o_all', kind: 'protect', group: 'wiri', minSurvivors: total, until: strikersDone, label: `Save all ${total} tanks`, primary: false },
  ];
  if (escorts > 0) objectives.push({ id: 'o_escort', kind: 'destroy', groups: ['escort'], label: 'Splash the escort', primary: false });
  const where = akl ? 'Wiri' : 'the fuel farm';
  const at: Condition = { kind: 'area', who: { group: 'strikers' }, x: ip.x, z: ip.z, radius: 2500 };
  return {
    groups,
    ground: defendTanks(lay, akl),
    objectives,
    waypoints: [{ id: 'wp_site', label: 'Intercept point', kind: 'cap', x: ip.x, z: ip.z, altitude: 3000, radius: 4000, objective: 'o_tanks' }],
    triggers: [
      {
        // at the IP (or after 3 min, whatever happened on the way) the strikers pop up and bomb
        id: 't_attack',
        when: { kind: 'any', of: [at, { kind: 'time', t: 180 }] },
        actions: [
          { kind: 'retask', group: 'strikers', task: { kind: 'attack_group', group: 'wiri' } },
          { kind: 'radio', from: DS_CALL, text: `${PLAYER_CALL}, Darkstar. Strikers climbing, rolling in on ${where}!`, priority: 3 },
        ],
      },
      { id: 't_hit', when: { kind: 'group_destroyed', group: 'wiri', count: 1 }, actions: [{ kind: 'radio', from: 'Wiri', text: 'We have a tank burning! Keep them off us!', priority: 3 }] },
      { id: 't_clear', when: { kind: 'all', of: [strikersBeaten, { kind: 'munitions_clear', group: 'strikers' }] }, delay: 20, actions: [{ kind: 'radio', from: DS_CALL, text: `${PLAYER_CALL}, Darkstar. Strike package is beaten. Good work.`, priority: 2 }] },
    ],
    hints: [
      { id: 'h_defend', text: 'The tanks are friendly: kill the bombers before they reach the IP — the escort can wait', when: { kind: 'time', t: 6 }, duration: 9 },
      { id: 'h_low', text: 'The strikers are low: look down with the radar and shoot from range before they climb to bomb', when: { kind: 'time', t: 40 }, until: { kind: 'trigger', id: 't_attack' }, duration: 7 },
    ],
    opening: [
      {
        kind: 'radio',
        from: DS_CALL,
        text: akl
          ? `${PLAYER_CALL}, Darkstar. Strike package low over the Firth of Thames, heading for the Wiri fuel terminal. Bombers have priority.`
          : `${PLAYER_CALL}, Darkstar. Strike package low from the east, heading for our fuel farm. Bombers have priority.`,
        priority: 3,
      },
    ],
    successText: akl ? 'Wiri is still standing. The airport keeps its fuel.' : 'The fuel farm is still standing.',
    briefing: [
      akl
        ? "A strike package is going for the Wiri oil terminal, Auckland's fuel supply at the end of the Marsden Point pipeline: the airport's jet fuel comes from these tanks."
        : 'A strike package is going for our fuel farm.',
      `About ${strikers} Flankers loaded with KAB-500 guided bombs come in low, then climb to bomb from about 13,000 ft${escorts > 0 ? `, with ${escorts} fighters as escort` : ''}. Each bomber that gets through can wreck a tank or two.`,
      `Keep at least ${DEFEND_MIN_TANKS} of the ${total} tanks standing until the strikers are dead or running. The tanks are friendly: never bomb or strafe them.`,
    ],
  };
}

/** Instant Action mission (fresh random seed each time). */
export function buildInstantMission(opts: InstantActionOptions): MissionDef {
  return buildInstantMissionSeeded(opts, Math.floor(Math.random() * 0x7fffffff));
}
