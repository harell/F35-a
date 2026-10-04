/**
 * F35-A UI — Codex knowledge base: what each weapon is for, what each warning means, in game terms.
 *
 * Only the prose is written by hand. Every number a balance change could move is read from the game's
 * own tables at runtime, so the Codex can't drift from the sim:
 *   - launch ranges, warhead damage            sim/weapons/defs.ts (MUNITIONS)
 *   - gun cue ranges                           sim/weapons/gun.ts (GUN_*_RANGE)
 *   - target hit points                        sim/damage/tables.ts (SAM_SITE_DATA, GROUND_TARGET_DATA, AIRCRAFT_HEALTH)
 *   - HUD weapon labels and brevity calls      hud/hmd/format.ts (WEAPON_HUD, WEAPON_BREVITY)
 *
 * Pure data and functions (no DOM): tests/ui-codex.test.ts checks every rating against the computed hits.
 */
import { LOADOUTS } from '../../core/data';
import type { WeaponId } from '../../core/types';
import { WEAPON_BREVITY, WEAPON_HUD } from '../../hud/hmd/format';
import { AIRCRAFT_HEALTH, GROUND_TARGET_DATA, SAM_SITE_DATA } from '../../sim/damage/tables';
import { MUNITIONS } from '../../sim/weapons/defs';
import { GUN_CUE_RANGE, GUN_EFFECTIVE_RANGE, GUN_LETHAL_RANGE, GUN_MIN_RANGE } from '../../sim/weapons/gun';

/* ───────────────────────────── categories ───────────────────────────── */

export type CodexCat = 'aa' | 'ag' | 'gun' | 'thr' | 'fly' | 'cue' | 'ref';

export const CODEX_CATS: { id: CodexCat; name: string; icon: string; group: 'Weapons' | 'Warnings & cues' }[] = [
  { id: 'aa', name: 'Air-to-air', icon: 'missile', group: 'Weapons' },
  { id: 'ag', name: 'Air-to-ground', icon: 'bomb', group: 'Weapons' },
  { id: 'gun', name: 'Gun & decoys', icon: 'crosshair', group: 'Weapons' },
  { id: 'thr', name: 'Threat warnings', icon: 'radar', group: 'Warnings & cues' },
  { id: 'fly', name: 'Flight & systems', icon: 'jet', group: 'Warnings & cues' },
  { id: 'cue', name: 'Weapon cues', icon: 'target', group: 'Warnings & cues' },
  { id: 'ref', name: 'Threat reference', icon: 'sam', group: 'Warnings & cues' },
];

/* ───────────────────────────── target classes ───────────────────────────── */

export type ClassId = 'air' | 'ad' | 'soft' | 'hard' | 'bridge' | 'ship' | 'boat';

/**
 * Target classes the player recognises. `members` are sim entity types (aircraft, SAM or ground);
 * names are strings so a type deleted from the sim drops out here instead of breaking the build.
 * `example` is the member the In-action view shows.
 */
export interface TargetClass {
  id: ClassId;
  name: string;
  examples: string;
  members: string[];
  example: string;
  /** Can move (a GPS bomb aims at a fixed point). */
  moving?: boolean;
  /** Has a radar the AARGM can home on. */
  emitters?: string[];
}

export const TARGET_CLASSES: TargetClass[] = [
  { id: 'air', name: 'Aircraft', examples: 'Fighters, drones', members: ['fighter', 'shahed136'], example: 'fighter', moving: true },
  { id: 'ad', name: 'Air defence', examples: 'SAM sites, anti-aircraft guns', members: ['sa6', 'sa15', 'zsu23'], example: 'sa6', emitters: ['sa6', 'sa15', 'zsu23'] },
  { id: 'soft', name: 'Soft targets', examples: 'Fuel depots, parked jets', members: ['fuel', 'parked_jet'], example: 'fuel' },
  { id: 'hard', name: 'Hardened', examples: 'Bunkers, hardened hangars', members: ['bunker', 'hangar'], example: 'bunker' },
  { id: 'bridge', name: 'Bridges', examples: '', members: ['bridge'], example: 'bridge' },
  { id: 'ship', name: 'Warships', examples: 'Big, slow, can move', members: ['ship'], example: 'ship', moving: true },
  { id: 'boat', name: 'Small boats', examples: 'Fast attack, suicide and air-defence boats', members: ['suicide_boat', 'missile_boat', 'ad_boat'], example: 'missile_boat', moving: true, emitters: ['ad_boat'] },
];

const AIR_DEFAULT_HP = 100;

/** Hit points of a sim entity type, or null if the type no longer exists. */
export function targetHp(type: string): number | null {
  if (type === 'fighter') return AIR_DEFAULT_HP;
  const air = (AIRCRAFT_HEALTH as Record<string, number | undefined>)[type];
  if (air !== undefined) return air;
  const sam = (SAM_SITE_DATA as Record<string, { health: number } | undefined>)[type];
  if (sam) return sam.health;
  const g = (GROUND_TARGET_DATA as Record<string, { health: number } | undefined>)[type];
  return g ? g.health : null;
}

/** The members of a class that still exist in the sim. */
export function liveMembers(c: TargetClass): string[] {
  return c.members.filter((m) => targetHp(m) !== null);
}

/* ───────────────────────────── weapons ───────────────────────────── */

/** GAU-22 damage per round inside the lethal range (≈18: 20 per round × the energy factor, sim/weapons/gun.ts). */
export const GUN_HIT_DAMAGE = 18;
/** AIM-120D no-escape range (sim/weapons/defs.ts header: "no-escape zone about 10 km"). */
const AMRAAM_NO_ESCAPE = 10_000;

export type CodexWeaponId = Exclude<WeaponId, 'gbu39'> | 'cms';

export interface RangeSpec {
  unit: 'km' | 'm';
  /** Right edge of the drawn scale (in `unit`). */
  scale: number;
  min: number;
  max: number;
  /** The max depends on release height and speed (bombs). */
  varMax?: boolean;
  best?: [number, number];
  bestLabel?: string;
  mark?: { at: number; label: string };
}

export interface WeaponEntry {
  kind: 'weapon';
  id: CodexWeaponId;
  cat: CodexCat;
  name: string;
  /** Short name used in the matrix and result lines. */
  short: string;
  line: string;
  inspect: string;
  needs: string;
  how: string[];
  avoid: string[];
  terms: [string, string][];
  hud: [string, string][];
  range: RangeSpec | null;
  /** 3D model / scene kind for the viewer. */
  scene: 'aam' | 'bomb' | 'agm' | 'gun' | 'cms';
  /** Glide bomb with folding wings. */
  glide?: boolean;
  /** Has its own terminal seeker (follows a moving target). */
  seeker?: boolean;
  /** Aims at a fixed GPS point. */
  gps?: boolean;
  /** Needs the launching jet after launch (datalink course updates). */
  datalink?: boolean;
  /** Burn time of the motor for the plume (s). */
  burn?: number;
}

const km = (m: number): number => m / 1000;

function munitionRange(id: 'aim120' | 'aim9x' | 'gbu31' | 'gbu53' | 'aargm', scale: number, extra: Partial<RangeSpec> = {}): RangeSpec {
  const d = MUNITIONS[id];
  return { unit: 'km', scale, min: km(d.minRange), max: km(d.maxRange), ...extra };
}

/** Number of rounds the player's gun carries in the standard loadouts. */
function gunRounds(): number {
  return LOADOUTS.a2a_stealth?.gunAmmo ?? 180;
}

const T_TWS: [string, string] = ['TWS shot', 'Track-while-scan. Your radar keeps scanning while it follows targets, without locking one. The enemy gets no SPIKE warning, but the missile gets rougher course updates, so it misses more often.'];
const T_CCIP: [string, string] = ['CCIP', 'With no target designated, a cross on the HUD shows where the bomb would land if you released now.'];
const T_DES: [string, string] = ['Designate', 'Select a ground target on the radar so the bomb or missile knows where to go.'];

function buildWeapons(): WeaponEntry[] {
  const hud = (id: WeaponId) => WEAPON_HUD[id];
  const brev = (id: WeaponId) => WEAPON_BREVITY[id];
  const rounds = gunRounds();
  return [
    {
      kind: 'weapon', id: 'aim120', cat: 'aa', name: 'AIM-120D AMRAAM', short: hud('aim120'), scene: 'aam', datalink: true, burn: 7,
      line: 'Your long-range air-to-air missile. One hit kills any fighter. It does nothing to ground targets.',
      inspect: 'Clipped mid-body fins let four fit in the internal bays. Yellow band: live warhead. Brown band: live rocket motor.',
      needs: 'Needs a radar track on an enemy aircraft. A full lock is optional: without one it fires as a TWS shot (see Terms).',
      hud: [[`${hud('aim120')} 4`, 'Selected, 4 left'], ['LOCKING → LOCK', 'Your radar lock is building, then held'], ['SHOOT', 'Good shot: fire now'], [brev('aim120'), 'Flashes as it launches'], ['NO TARGET · OUT OF RANGE · MIN RANGE', 'Why it didn\'t fire']],
      how: ['Select AMRAAM. The radar switches to search mode (74 km).', 'Tap the target box to lock. The lock builds while the target is within ±30° of your nose.', 'Fire on SHOOT. Inside 10 km it rarely misses, and once it launches you can turn away.'],
      avoid: ['It does nothing to ground targets.', 'A fighter that turns 90° to it and drops chaff can make it miss.'],
      terms: [T_TWS, ['Lock', 'Your radar holds one target and feeds the missile the best course updates. The target gets a SPIKE warning.']],
      range: munitionRange('aim120', 35, { best: [km(MUNITIONS.aim120.minRange), km(AMRAAM_NO_ESCAPE)], bestLabel: `no-escape ≤ ${km(AMRAAM_NO_ESCAPE)}` }),
    },
    {
      kind: 'weapon', id: 'aim9x', cat: 'aa', name: 'AIM-9X Sidewinder', short: hud('aim9x'), scene: 'aam', burn: 5,
      line: 'Short-range heat-seeker. Look at the fighter, wait for the tone, fire. It doesn\'t need radar, but only the Beast loadouts carry it.',
      inspect: 'Small body, no canards. Tail fins plus thrust vectoring make it the most agile missile in the game. The dark dome is an imaging infrared seeker.',
      needs: 'No radar needed. The seeker must see an enemy aircraft within 90° of your nose.',
      hud: [[`${hud('aim9x')} 2`, 'Selected, 2 left'], ['Growl → steady tone', 'The seeker is searching, then sees heat'], [brev('aim9x'), 'Flashes as it launches'], ['NO SEEKER', 'The seeker can\'t see an enemy aircraft']],
      how: ['Select 9X. The radar switches to dogfight mode (18.5 km).', 'Point within 90° of the fighter and wait for the steady tone.', 'Fire. No lock needed.'],
      avoid: ['Only the Beast loadouts carry it, and they make you much easier to see on radar.'],
      terms: [['Seeker tone', 'The growl is the heat-seeker searching. A steady tone means it sees a target.']],
      range: munitionRange('aim9x', 10),
    },
    {
      kind: 'weapon', id: 'gbu31', cat: 'ag', name: 'GBU-31 JDAM', short: hud('gbu31'), scene: 'bomb', gps: true,
      line: '2,000 lb GPS bomb. One hit destroys any ground target in the game. It falls on a fixed point, so a moving target can get away.',
      inspect: 'A plain bomb body with a GPS tail kit and strakes. It falls more than it flies.',
      needs: 'Designate a ground target, or drop it by eye with no target (CCIP). Its reach depends on your height and speed.',
      hud: [[`${hud('gbu31')} 2`, 'Selected, 2 left'], ['REL 5', 'Seconds to the release point'], ['STEER LEFT / RIGHT', 'Correct your line'], ['IN RANGE', 'Release now'], ['CCIP · PICKLE', 'No target: the cross shows where it lands. Drop now.'], [`${brev('gbu31')} · BOMB AWAY`, 'It\'s released']],
      how: ['Designate the target on the radar (ground mode, 37 km).', 'Fly toward it. Follow STEER until REL reaches 0 and IN RANGE shows.', 'Release. Higher and faster lets you release from further away.'],
      avoid: ['It aims at a fixed point, so boats can drive away.', 'External JDAMs lower your g limit.'],
      terms: [T_DES, T_CCIP],
      range: munitionRange('gbu31', 15, { varMax: true }),
    },
    {
      kind: 'weapon', id: 'gbu53', cat: 'ag', name: 'GBU-53/B StormBreaker', short: hud('gbu53'), scene: 'bomb', glide: true, seeker: true, datalink: true,
      line: 'Smart glide bomb with its own seeker. It chases moving boats and ships, but it needs a designated target.',
      inspect: 'The glass nose holds a seeker that searches from 3 km out. The wings fold along the body in the bay and swing out after release.',
      needs: 'Needs a designated live target. It won\'t release without one, and it can\'t be dropped by eye.',
      hud: [[`${hud('gbu53')} 8`, 'Selected, 8 left'], ['NO TARGET', 'Designate a target first'], ['IN RANGE', 'Release now'], [brev('gbu53'), 'It\'s released']],
      how: ['Designate a live target.', `Release inside ${km(MUNITIONS.gbu53.maxRange)} km. It follows the target if it moves.`, 'Eight fit in the bays, enough for a pack of boats.'],
      avoid: ['Bunkers always take two.', 'If the target dies first, it lands where the target was heading. It never switches target.'],
      terms: [T_DES],
      range: munitionRange('gbu53', 35),
    },
    {
      kind: 'weapon', id: 'aargm', cat: 'ag', name: 'AGM-88G AARGM-ER', short: hud('aargm'), scene: 'agm', burn: 14,
      line: 'Anti-radiation missile. It homes on a radar that\'s switched on. One hit kills any SAM site or air-defence radar.',
      inspect: 'Long body strakes and a big rocket motor. A passive radar receiver in the nose, plus a second seeker for the last 3 km.',
      needs: 'Needs a radar that\'s switched on (a MUD SPIKE) within 45° of your nose, or a designated radar site.',
      hud: [[`${hud('aargm')} 2`, 'Selected, 2 left'], ['MUD SPIKE 6', 'A ground radar is on: a valid target'], [brev('aargm'), 'Flashes as it launches'], ['MIN RANGE · NO TARGET', `Inside ${km(MUNITIONS.aargm.minRange)} km, or no radar switched on`]],
      how: ['Wait for a MUD SPIKE. That radar is your target.', 'Designate it, or point within 45° of it and fire.', 'Fire from outside the SAM\'s reach: medium SAMs 20 km, short-range SAMs 12 km.'],
      avoid: ['Crews switch the radar off when it\'s coming. It then gets one chance to find the site.', 'It can\'t lock anything without a radar.'],
      terms: [['MUD SPIKE', 'The warning that a ground radar (a SAM site or anti-aircraft gun) is tracking you. That radar is what the AARGM homes on.']],
      range: munitionRange('aargm', 55),
    },
    {
      kind: 'weapon', id: 'gun', cat: 'gun', name: 'GAU-22/A 25 mm', short: hud('gun'), scene: 'gun',
      line: `25 mm rotary cannon with ${rounds} rounds, about 3 seconds of fire. Use it to finish fighters and strafe light targets.`,
      inspect: 'Four barrels spin at 3,300 rounds a minute. Every 4th round is a tracer.',
      needs: `No lock needed. Put the pipper on the target. SHOOT blinks inside ${GUN_EFFECTIVE_RANGE.toLocaleString('en')} m.`,
      hud: [[`${hud('gun')} ${rounds}`, 'Rounds left'], ['SHOOT', `Inside ${GUN_EFFECTIVE_RANGE.toLocaleString('en')} m with the pipper on target`], ['OVERSHOOT', 'You\'ll pass the target within 4 s'], [brev('gun'), 'Flashes while firing']],
      how: ['Select GUN. The radar switches to dogfight mode.', 'Close until SHOOT blinks with the pipper on the target.', 'Fire short bursts.'],
      avoid: ['Bunkers and ships take far too many rounds. Use a bomb.', 'It can\'t damage landmarks.'],
      terms: [['Pipper', 'The aiming dot of the gunsight. Put it on the target and fire.']],
      range: { unit: 'm', scale: 1600, min: GUN_MIN_RANGE, max: GUN_CUE_RANGE, best: [GUN_MIN_RANGE, GUN_LETHAL_RANGE], bestLabel: `full damage ≤ ${GUN_LETHAL_RANGE}`, mark: { at: GUN_EFFECTIVE_RANGE, label: `SHOOT ${GUN_EFFECTIVE_RANGE.toLocaleString('en')}` } },
    },
    {
      kind: 'weapon', id: 'cms', cat: 'gun', name: 'Flares & chaff', short: 'CMS', scene: 'cms',
      line: 'Flares fool heat-seeking missiles. Chaff fools radar missiles. One button drops both.',
      inspect: 'Flares burn hot for a few seconds. Chaff is a cloud of foil that shows up on radar.',
      needs: '',
      hud: [['FL 24  CH 24', 'Flares and chaff left'], ['FLARES LOW · CHAFF LOW', '4 or fewer left'], ['MISSILE', 'The moment to press']],
      how: ['Press CMS when the MISSILE warning is close. It drops 2 flares and 2 chaff.', 'Turn at the same time: 90° to a radar missile, hard into a heat-seeker.', 'Hold the button to keep dropping every 0.6 s.'],
      avoid: ['Dropping early wastes them.', 'Flares do nothing to radar missiles, and chaff does nothing to heat-seekers.'],
      terms: [],
      range: null,
    },
  ];
}

export const CODEX_WEAPONS: WeaponEntry[] = buildWeapons();

/** Warhead damage of a codex weapon against one target (per hit), or 0 if it can't hurt it. */
export function weaponDamage(id: CodexWeaponId): number {
  if (id === 'gun') return GUN_HIT_DAMAGE;
  if (id === 'cms') return 0;
  return MUNITIONS[id].damage;
}

/* ───────────────────────────── ratings ───────────────────────────── */

export type Rating = 'best' | 'good' | 'poor' | 'no';

/**
 * Hand-picked rating and reason per weapon × class. The hits shown next to it are computed
 * (classHits); tests/ui-codex.test.ts fails if a balance change makes a rating untrue
 * (a 'best' that now takes two hits, say).
 */
const NG: [Rating, string] = ['no', 'No effect on ground or sea targets'];
const NA: [Rating, string] = ['no', 'Can\'t target aircraft'];
const NR: [Rating, string] = ['no', 'No radar to home on'];

export const RATINGS: Record<Exclude<CodexWeaponId, 'cms'>, Record<ClassId, [Rating, string]>> = {
  aim120: { air: ['best', 'One hit kills any fighter, out to 30 km'], ad: NG, soft: NG, hard: NG, bridge: NG, ship: NG, boat: NG },
  aim9x: { air: ['best', 'One hit inside 8 km, no radar lock needed'], ad: NG, soft: NG, hard: NG, bridge: NG, ship: NG, boat: NG },
  gbu31: { air: NA, ad: ['best', 'Kills any SAM site'], soft: ['good', 'Works, but a 2,000 lb bomb is overkill'], hard: ['best', 'Its main job'], bridge: ['best', 'Drops a bridge in one'], ship: ['best', 'The 60 m blast covers a ship even if it moves'], boat: ['poor', 'Aims at a fixed point, and boats move'] },
  gbu53: { air: NA, ad: ['best', 'Kills any SAM site'], soft: ['best', 'Kills a fuel depot or parked jet'], hard: ['good', 'Hangar 1, bunker always 2'], bridge: ['good', 'Needs two'], ship: ['good', 'Tracks it while it moves'], boat: ['best', 'Tracks it while it moves. Its main job'] },
  aargm: { air: NA, ad: ['best', 'Only while the radar is switched on'], soft: NR, hard: NR, bridge: NR, ship: NR, boat: ['poor', 'Only the air-defence boat, which has a radar'] },
  gun: { air: ['good', 'Inside 1,200 m, behind the target'], ad: ['poor', 'You have to fly into its range'], soft: ['good', 'Good for strafing'], hard: ['poor', 'Use a bomb'], bridge: ['poor', 'Use a bomb'], ship: ['poor', 'Use a bomb'], boat: ['good', 'Good for strafing'] },
};

/** Direct hits needed against each live member of a class: [fewest, most], or null if none can be hurt. */
export function classHits(id: Exclude<CodexWeaponId, 'cms'>, c: TargetClass): [number, number] | null {
  const dmg = weaponDamage(id);
  const air = c.id === 'air';
  const isAam = id === 'aim120' || id === 'aim9x';
  if (isAam && !air) return null; // AAM warheads only hurt aircraft (sim/weapons/flight.ts applyBlast)
  if (!isAam && id !== 'gun' && air) return null; // bombs and the AARGM can't be aimed at aircraft
  let members = liveMembers(c);
  if (id === 'aargm') members = members.filter((m) => c.emitters?.includes(m));
  if (!members.length || dmg <= 0) return null;
  const hits = members.map((m) => Math.ceil((targetHp(m) as number) / dmg));
  return [Math.min(...hits), Math.max(...hits)];
}

export function hitsText(h: [number, number] | null): string {
  if (!h) return '—';
  const [a, b] = h;
  if (a === b) return a === 1 ? '1 hit' : `${a} hits`;
  return `${a}–${b} hits`;
}

export interface UseOn {
  cls: TargetClass;
  rating: Rating;
  why: string;
  hits: string;
}

/** The classes a weapon is good for (best first), the "Use it on" list. */
export function useOn(id: CodexWeaponId): UseOn[] {
  if (id === 'cms') return [];
  const order: Record<Rating, number> = { best: 0, good: 1, poor: 2, no: 3 };
  return TARGET_CLASSES.map((cls) => {
    const [rating, why] = RATINGS[id][cls.id];
    return { cls, rating, why, hits: hitsText(classHits(id, cls)) };
  })
    .filter((u) => u.rating === 'best' || u.rating === 'good')
    .sort((a, b) => order[a.rating] - order[b.rating]);
}

/** Weapons with a column in the cross-reference matrix. */
export const MATRIX_WEAPONS: Exclude<CodexWeaponId, 'cms'>[] = ['aim120', 'aim9x', 'gbu31', 'gbu53', 'aargm', 'gun'];

/* ───────────────────────────── warnings & cues ───────────────────────────── */

export type WarnLevel = 'red' | 'amb' | 'grn' | 'dim' | 'hud';
export type WarnSound = 'spike' | 'mud' | 'launch' | 'missile' | 'defeated' | 'silent' | 'buzz' | 'none';

export interface WarningEntry {
  kind: 'warning';
  id: string;
  cat: CodexCat;
  name: string;
  chip: string;
  level: WarnLevel;
  sound: WarnSound;
  /** Game voice clip (public/audio/voice/<id>.mp3) that goes with it. */
  voice?: string;
  /** What the voice says (shown as text). */
  voiceText?: string;
  line: string;
  trigger: string;
  how: string[];
  notes: string[];
  /** Threat reference table instead of trigger / what-to-do. */
  reference?: boolean;
}

export const CODEX_WARNINGS: WarningEntry[] = [
  {
    kind: 'warning', id: 'spike', cat: 'thr', name: 'SPIKE', chip: 'SPIKE 29', level: 'amb', sound: 'spike', voice: 'p_spike', voiceText: 'Spike!',
    line: 'A fighter\'s radar has locked on to you. It may fire next.',
    trigger: 'An enemy fighter\'s radar goes from searching to tracking you. The number after SPIKE identifies the aircraft type.',
    how: ['Look for the chip\'s arrow and the diamond at the screen edge. The threat is that way.', 'Decide: fight back (lock and fire) or break the lock (turn 90° to it, dive, chaff).', 'Watch for it to turn red. That\'s a launch.'],
    notes: ['Search radars show as dim symbols with no chip. Only a lock makes a SPIKE.', 'Stealthy fighters are only picked up at closer range.', 'Your pilot calls "Spike!" at most once every 25 s.'],
  },
  {
    kind: 'warning', id: 'mud', cat: 'thr', name: 'MUD SPIKE', chip: 'MUD SPIKE 6', level: 'amb', sound: 'mud', voice: 'p_mud_spike', voiceText: 'Mud spike!',
    line: 'A ground or boat radar (a SAM site or anti-aircraft gun) is tracking you.',
    trigger: 'A SAM site, anti-aircraft gun or air-defence boat starts tracking you with its radar. The symbol identifies the type: numbers are SAMs, A is a gun, B is a boat.',
    how: ['Know the reach: medium SAMs up to 20 km, short-range about 12 km, guns 2.5 km. If unsure, leave the area.', 'Leave its range, or put a hill between you. Terrain blocks the radar.', 'Or kill it: an AARGM homes on exactly this radar.'],
    notes: ['The tone is lower than an air SPIKE, so you can tell them apart without looking.', 'Shoulder-fired missiles have no radar and never cause a MUD SPIKE.'],
  },
  {
    kind: 'warning', id: 'launch', cat: 'thr', name: 'Launch (red spike)', chip: 'MUD SPIKE 15', level: 'red', sound: 'launch',
    line: 'The radar that was tracking you is now guiding a missile at you.',
    trigger: 'A SAM, or a fighter\'s radar-guided missile, is being steered at you by that radar, or an anti-aircraft gun is firing. The chip and symbol turn red and blink, and the tone becomes a fast warble. AWACS (DARKSTAR) calls "SAM launch!".',
    how: ['These missiles need the radar to keep tracking you. Break the track: turn 90° to it, dive behind terrain, drop chaff.', 'Killing the radar kills the missile. Command-guided missiles coast for 1 s, then fall ballistic.', 'Expect a MISSILE warning as it gets close.'],
    notes: ['The DARKSTAR call repeats at most every 8 s.'],
  },
  {
    kind: 'warning', id: 'missile', cat: 'thr', name: 'MISSILE', chip: 'MISSILE 6s', level: 'red', sound: 'missile', voice: 'b_missile', voiceText: 'Missile',
    line: 'A missile is coming at you, any type, within 15 km. Act now.',
    trigger: 'The jet\'s missile approach warning sees a missile heading for you. A red ring appears around your flight path marker, with an arrow per missile (orange means heat-seeker) and 1–3 chevrons as it closes. The seconds to impact count down.',
    how: ['Radar missile: turn 90° to it, dive, drop countermeasures late.', 'Heat-seeker (orange arrow): drop flares, break hard into it, come out of afterburner.', 'Three chevrons means under 4 s to impact.'],
    notes: ['This is the only warning for shoulder-fired missiles and for long-range fighter missiles in midcourse.', 'The tone sweeps down, and it speeds up as the missile gets closer.'],
  },
  {
    kind: 'warning', id: 'defeated', cat: 'thr', name: 'MISSILE DEFEATED', chip: 'MISSILE DEFEATED', level: 'grn', sound: 'defeated',
    line: 'The missile that was tracking you has missed or lost you.',
    trigger: 'A missile aimed at you drops off the threat list. A green box appears and its arrow stays crossed out for about a second.',
    how: ['Check for more threats. A second missile may still be inbound.', 'Get back to the fight or the route.'],
    notes: [],
  },
  {
    kind: 'warning', id: 'silent', cat: 'thr', name: 'What you won\'t hear', chip: '(nothing)', level: 'dim', sound: 'silent',
    line: 'Some missiles give no warning until late, or none at all before the MISSILE alarm.',
    trigger: 'Long-range fighter missiles are silent in midcourse. A red "M" and a MISSILE warning appear only when the missile\'s own radar switches on, about 8 km out. Shoulder-fired missiles from air-defence boats are heat-seekers with no radar, so the radar warning never sees them.',
    how: ['If a fighter had a SPIKE on you and it disappeared, assume it may have fired.', 'Stay more than 5 km from air-defence boats when you\'re low and slow.', 'Respect the MISSILE warning even when nothing else is sounding.'],
    notes: [],
  },
  {
    kind: 'warning', id: 'pullup', cat: 'fly', name: 'PULL UP', chip: 'PULL UP', level: 'red', sound: 'none', voice: 'b_pull_up', voiceText: 'Pull up',
    line: 'You will hit the ground within seconds if you don\'t pull now.',
    trigger: 'The terrain along your flight path is closer than 4 s, plus the time it takes to pull out at 80% of max g. Big blinking text and a red X fill the screen.',
    how: ['Pull up now. Wings level first if you\'re rolled.', 'Auto-GCAS may take the jet. Let it.'],
    notes: [],
  },
  {
    kind: 'warning', id: 'gcas', cat: 'fly', name: 'AUTO GCAS', chip: 'AUTO GCAS', level: 'amb', sound: 'none',
    line: 'The jet is flying itself away from the ground.',
    trigger: 'Automatic ground collision avoidance is active. Two chevrons close in on your flight path marker.',
    how: ['Don\'t fight the stick. It hands control back once you\'re clear.'],
    notes: [],
  },
  {
    kind: 'warning', id: 'altitude', cat: 'fly', name: 'ALTITUDE', chip: 'ALTITUDE', level: 'red', sound: 'none', voice: 'b_altitude', voiceText: 'Altitude',
    line: 'You\'re below 500 ft and descending.',
    trigger: 'Below 152 m (500 ft) above ground and sinking faster than 1.5 m/s.',
    how: ['Level off or climb.'],
    notes: [],
  },
  {
    kind: 'warning', id: 'stall', cat: 'fly', name: 'STALL', chip: 'STALL', level: 'red', sound: 'none', voice: 'b_aoa', voiceText: 'Angle of attack',
    line: 'The wing has stopped flying, or is about to.',
    trigger: 'Stalled, or within 0.6° of the angle-of-attack limiter at less than 0.9 g.',
    how: ['Ease the stick forward.', 'Add power. Trade height for speed.'],
    notes: ['Related: SPEED (below 140 kt) and AOA (angle of attack too high).'],
  },
  {
    kind: 'warning', id: 'speed', cat: 'fly', name: 'SPEED · AOA', chip: 'SPEED', level: 'amb', sound: 'none', voice: 'b_speed', voiceText: 'Speed',
    line: 'You\'re slow (SPEED) or pulling too hard for your speed (AOA).',
    trigger: 'SPEED: indicated airspeed below 140 kt and not stalled. AOA: angle of attack above 24°. AOA shows on the HUD only, with no voice.',
    how: ['Unload: relax the pull.', 'Add power or lower the nose.'],
    notes: [],
  },
  {
    kind: 'warning', id: 'overg', cat: 'fly', name: 'OVER-G', chip: 'OVER-G', level: 'red', sound: 'none', voice: 'b_over_g', voiceText: 'Over G',
    line: 'You\'re pulling more g than the airframe allows.',
    trigger: 'More than 0.3 g past the limit. The limit is lower with heavy JDAMs on the wings. Overstressing damages the jet ("OVERSTRESS").',
    how: ['Relax the pull.'],
    notes: ['On Ace, holding about 9 g for around 11 s causes G-LOC (blackout).'],
  },
  {
    kind: 'warning', id: 'fuel', cat: 'fly', name: 'BINGO · FUEL LOW', chip: 'BINGO', level: 'amb', sound: 'none', voice: 'b_bingo', voiceText: 'Bingo',
    line: 'BINGO: you have just enough fuel to get home. FUEL LOW: under 30%.',
    trigger: 'BINGO below 15% of internal fuel, FUEL LOW below 30%. The fuel readout turns amber, then red.',
    how: ['At BINGO, finish the attack you\'re in and head home.', 'Cut the afterburner.'],
    notes: [],
  },
  {
    kind: 'warning', id: 'damage', cat: 'fly', name: 'DAMAGE · ENGINE · HYDRAULICS', chip: 'DAMAGE', level: 'amb', sound: 'none', voice: 'b_warning', voiceText: 'Warning',
    line: 'You\'ve been hit. Check what still works.',
    trigger: 'DAMAGE: airframe below 50%. HYDRAULICS: hydraulic damage over half. ENGINE FIRE or ENGINE FAIL: engine damage, no fuel or flame-out. The AIRFRAME % readout shows ENG, HYD, LEAK and FIRE tags.',
    how: ['Leave the fight.', 'Avoid hard manoeuvres with hydraulics damage.', 'Engine fail: trade height for distance to safety.'],
    notes: ['On Recruit and Pilot, one missile never kills you from full health.'],
  },
  {
    kind: 'warning', id: 'cmlow', cat: 'fly', name: 'FLARES / CHAFF LOW', chip: 'FLARES LOW', level: 'dim', sound: 'none', voice: 'b_flares_low', voiceText: 'Flares low',
    line: 'Four or fewer flares or chaff left.',
    trigger: '4 or fewer of either. The FL or CH counter turns amber.',
    how: ['Save the rest for the last few seconds before a missile hits.'],
    notes: [],
  },
  {
    kind: 'warning', id: 'lock', cat: 'cue', name: 'LOCKING · LOCK', chip: 'LOCK', level: 'hud', sound: 'none',
    line: 'How your radar lock works, which the AMRAAM needs for a full-quality shot.',
    trigger: 'Tap the target box or TGT. A ring fills while the target stays within ±30° of your nose: 0.6 s on Recruit, 1 s on Pilot, 1.5 s on Veteran, 2 s on Ace.',
    how: ['Point at the target until the ring closes.', 'Once locked, it holds anywhere within ±60°.', 'It drops after 2 s without radar contact, or when you go EMCON (radar off).'],
    notes: ['Your lock gives the enemy a SPIKE. A TWS shot without a lock doesn\'t.'],
  },
  {
    kind: 'warning', id: 'cues', cat: 'cue', name: 'SHOOT · IN RANGE · REL · CCIP', chip: 'SHOOT', level: 'hud', sound: 'none',
    line: 'The HUD tells you when a shot or release will work.',
    trigger: 'SHOOT blinks when an air-to-air shot is good. For bombs: REL n counts seconds to release, IN RANGE means release now, STEER LEFT/RIGHT corrects your line, and BOMB AWAY confirms the release. With nothing designated, CCIP shows where a bomb would land, and PICKLE means drop now.',
    how: ['Fire on SHOOT. Release on IN RANGE.', 'Follow STEER until it clears.'],
    notes: ['After each shot the brevity call flashes: FOX 3, FOX 2, RIFLE, MAGNUM, GUNS.'],
  },
  {
    kind: 'warning', id: 'denied', cat: 'cue', name: 'Release denied', chip: 'NO LOCK', level: 'amb', sound: 'buzz',
    line: 'You pressed fire and nothing happened. The weapon block says why.',
    trigger: 'Blinking amber text for about 2 s with a buzz: WINCHESTER (none left), NO TARGET, NO LOCK, OUT OF RANGE, MIN RANGE, or NO SEEKER (the 9X can\'t see an enemy aircraft).',
    how: ['Read the reason and fix that one thing.'],
    notes: [],
  },
  {
    kind: 'warning', id: 'overshoot', cat: 'cue', name: 'OVERSHOOT', chip: 'OVERSHOOT', level: 'amb', sound: 'none',
    line: 'You\'re about to fly past the target in a gun fight.',
    trigger: 'At your current closure, you\'ll be inside 150 m within 4 s.',
    how: ['Ease the throttle or pull out of plane to stay behind.'],
    notes: [],
  },
  {
    kind: 'warning', id: 'rwrsym', cat: 'ref', name: 'Radar warning symbols', chip: 'RWR', level: 'amb', sound: 'none', reference: true,
    line: 'What each symbol on the radar warning ring means, and how far each threat reaches.',
    trigger: '',
    how: [],
    notes: [],
  },
];

/** Rows of the threat reference table: symbol, threat type, reach, note. */
export const THREAT_REFERENCE: [string, string, string, string][] = [
  ['6', 'Medium SAM', 'up to 20 km', 'Covers a wide area up to 12 km altitude'],
  ['15', 'Short-range SAM', 'up to 12 km', 'Also shoots down your bombs and missiles'],
  ['A', 'Anti-aircraft gun', 'up to 2.5 km', 'Only below 3 km altitude'],
  ['B', 'Air-defence boat', 'up to 12 km', 'Sees you within 9 km even when stealthy. Also carries shoulder-fired missiles.'],
  ['29 · 27 · 35 · 57', 'Fighters', 'radar 35–55 km', 'Their radar lock is a SPIKE'],
  ['M', 'Missile seeker', 'about 8 km', 'A missile\'s own radar is locked on you'],
  ['—', 'Shoulder-fired missile', 'up to 5 km', 'Fired from air-defence boats. No symbol and no warning until MISSILE.'],
];

/* ───────────────────────────── lookup ───────────────────────────── */

export type CodexEntry = WeaponEntry | WarningEntry;

export const CODEX_ENTRIES: CodexEntry[] = [...CODEX_WEAPONS, ...CODEX_WARNINGS];

export function codexEntry(id: string): CodexEntry | null {
  return CODEX_ENTRIES.find((e) => e.id === id) ?? null;
}

/** The Codex entry for a loadout store (weapon id), if the Codex has one. */
export function codexForWeapon(weapon: string): WeaponEntry | null {
  return CODEX_WEAPONS.find((w) => w.id === weapon) ?? null;
}

export function entriesIn(cat: CodexCat): CodexEntry[] {
  return CODEX_ENTRIES.filter((e) => e.cat === cat);
}

/** Case-insensitive search over names, HUD labels and one-liners. */
export function searchCodex(q: string): CodexEntry[] {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  return CODEX_ENTRIES.filter((e) => {
    const labels = e.kind === 'weapon' ? e.hud.map((x) => x[0]).join(' ') + ' ' + e.short : e.chip;
    return `${e.name} ${labels} ${e.line}`.toLowerCase().includes(s);
  });
}
