/**
 * F35-A — shared static data tables (difficulty, quality presets, loadouts, display names).
 * OWNERSHIP: orchestrator. The COMBAT agent may tune LOADOUTS numbers; SIM/AI may retune the
 * DIFFICULTIES numbers and descriptions (balance measured with tests/ai-balance.test.ts and
 * e2e/review/dev-simai-balance.ts); nobody else edits.
 */
import type {
  AircraftType,
  Difficulty,
  DifficultyParams,
  LoadoutId,
  QualityLevel,
  QualitySettings,
  SamType,
  Settings,
  TheaterId,
  TimeOfDay,
  WeaponId,
} from './types';

export const GAME_TITLE = 'F35-A';
/**
 * Build number: the GitHub Actions run number of the deploy workflow (GITHUB_RUN_NUMBER, passed in as
 * VITE_BUILD_NUMBER by .github/workflows/deploy.yml). Find the deployment as run #N under Actions →
 * "Build & deploy F35-A". Local and dev builds have no run, so they show "dev".
 */
export const GAME_BUILD: string = (import.meta.env.VITE_BUILD_NUMBER as string | undefined) || 'dev';

/**
 * Test hooks: `?mission=<id>&autostart=1` (fly any mission, campaign locks ignored) and `window.__f35`
 * (state, autopilot, fast-forward, scripted controls, Sky Tower demolition). They exist on the dev
 * server and in builds made with VITE_TEST_HOOKS=1, never in the deployed game. Playtests use them
 * (.claude/skills/play-f35).
 */
export const TEST_HOOKS: boolean = import.meta.env.DEV || import.meta.env.VITE_TEST_HOOKS === '1';

export const DIFFICULTIES: Record<Difficulty, DifficultyParams> = {
  recruit: {
    id: 'recruit',
    label: 'Recruit',
    description: 'Forgiving enemies that react slowly and shoot late, generous countermeasures, three missile hits to kill. Learn the jet.',
    playerDamageScale: 0.35,
    aiSkill: 0.25,
    aiReactionTime: 3.0,
    aiMaxG: 5.5,
    enemyMissileSkill: 0.55,
    samRangeScale: 0.75,
    samReactionTime: 6,
    playerLockTime: 0.6,
    countermeasureEffectiveness: 1.6,
    flightAssist: true,
    gEffects: false,
    generousShootCues: true,
    enemyCountScale: 0.75,
    scoreMultiplier: 0.75,
    playerMissileHitsToKill: 3,
    fuelBurnScale: 0.5,
  },
  pilot: {
    id: 'pilot',
    label: 'Pilot',
    description: 'Balanced. Competent enemies and dangerous SAMs — see them first, shoot first, defend every missile.',
    playerDamageScale: 0.65,
    aiSkill: 0.5,
    aiReactionTime: 2.0,
    aiMaxG: 7,
    enemyMissileSkill: 0.8,
    samRangeScale: 0.9,
    samReactionTime: 4,
    playerLockTime: 1.0,
    countermeasureEffectiveness: 1.2,
    flightAssist: true,
    gEffects: true,
    generousShootCues: true,
    enemyCountScale: 1,
    scoreMultiplier: 1,
    playerMissileHitsToKill: 2,
    fuelBurnScale: 0.8,
  },
  veteran: {
    id: 'veteran',
    label: 'Veteran',
    description: 'Aggressive, well-trained enemies; one missile hit is fatal. Manage your energy and your emissions.',
    playerDamageScale: 1,
    aiSkill: 0.75,
    aiReactionTime: 0.8,
    aiMaxG: 8,
    enemyMissileSkill: 1,
    samRangeScale: 1,
    samReactionTime: 2.5,
    playerLockTime: 1.5,
    countermeasureEffectiveness: 1,
    flightAssist: true,
    gEffects: true,
    generousShootCues: false,
    enemyCountScale: 1,
    scoreMultiplier: 1.5,
    playerMissileHitsToKill: 1,
    fuelBurnScale: 1,
  },
  ace: {
    id: 'ace',
    label: 'Ace',
    description: 'Realistic. Carefree FBW and Auto-GCAS like the real jet, but no flight-path hold, rough buffet and G-LOC. More, sharper enemies with GCI support, lethal SAMs, one hit kills.',
    playerDamageScale: 1.25,
    aiSkill: 0.95,
    aiReactionTime: 0.4,
    aiMaxG: 9,
    enemyMissileSkill: 1.2,
    samRangeScale: 1.1,
    samReactionTime: 1.5,
    playerLockTime: 2,
    countermeasureEffectiveness: 0.85,
    flightAssist: false,
    gEffects: true,
    generousShootCues: false,
    enemyCountScale: 1.5,
    scoreMultiplier: 2,
    playerMissileHitsToKill: 1,
    fuelBurnScale: 1,
  },
};

export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  low: {
    level: 'low',
    pixelRatio: 1,
    drawDistance: 28_000,
    terrainDetail: 0,
    hdTerrain: false,
    aerialPhoto: false,
    cloudCount: 24,
    particleScale: 0.4,
    shadows: false,
    antialias: false,
    postfx: false,
    sceneryDensity: 0.35,
    wakes: false,
    ferries: 10,
    railways: true,
    targetCamRange: 8_000,
    targetCamScenery: false,
  },
  medium: {
    level: 'medium',
    pixelRatio: 1.5,
    drawDistance: 40_000,
    terrainDetail: 1,
    hdTerrain: false,
    aerialPhoto: true,
    cloudCount: 60,
    particleScale: 0.75,
    shadows: false,
    antialias: true,
    postfx: false,
    sceneryDensity: 0.7,
    wakes: true,
    ferries: 13,
    railways: true,
    targetCamRange: 0,
    targetCamScenery: true,
  },
  high: {
    level: 'high',
    pixelRatio: 2,
    drawDistance: 60_000,
    terrainDetail: 2,
    hdTerrain: true,
    aerialPhoto: true,
    cloudCount: 120,
    particleScale: 1,
    shadows: true,
    antialias: true,
    postfx: true,
    sceneryDensity: 1,
    wakes: true,
    ferries: 16,
    railways: true,
    targetCamRange: 0,
    targetCamScenery: true,
  },
};

export const DEFAULT_SETTINGS: Settings = {
  difficulty: 'pilot',
  quality: 'auto',
  controlScheme: 'stick',
  invertPitch: false,
  stickSensitivity: 1,
  tiltSensitivity: 1,
  leftHanded: false,
  masterVolume: 0.9,
  sfxVolume: 0.9,
  voiceVolume: 1,
  musicVolume: 0.6,
  haptics: true,
  hints: true,
  hudColor: 'green',
  fov: 60,
  showFps: false,
  defaultView: 'cockpit',
  targetCam: true,
  hdTerrain: true,
  aerialPhoto: true,
};

export interface LoadoutDef {
  id: LoadoutId;
  name: string;
  description: string;
  /** Radar cross-section multiplier (external stores wreck stealth). */
  rcsMultiplier: number;
  stores: { weapon: Exclude<WeaponId, 'gun'>; count: number; internal: boolean }[];
  gunAmmo: number;
  flares: number;
  chaff: number;
  role: 'aa' | 'ag' | 'sead';
}

export const LOADOUTS: Record<LoadoutId, LoadoutDef> = {
  a2a_stealth: {
    id: 'a2a_stealth',
    name: 'Air Dominance (Stealth)',
    description: '4× AIM-120D in the internal bays. Lowest RCS — see them first, shoot them first.',
    rcsMultiplier: 1,
    stores: [{ weapon: 'aim120', count: 4, internal: true }],
    gunAmmo: 180,
    flares: 24,
    chaff: 24,
    role: 'aa',
  },
  strike_stealth: {
    id: 'strike_stealth',
    name: 'Deep Strike (Stealth)',
    description: '2× GBU-31 JDAM + 2× AIM-120D internal. Penetrate defended airspace undetected.',
    rcsMultiplier: 1,
    stores: [
      { weapon: 'gbu31', count: 2, internal: true },
      { weapon: 'aim120', count: 2, internal: true },
    ],
    gunAmmo: 180,
    flares: 24,
    chaff: 24,
    role: 'ag',
  },
  sead_stealth: {
    id: 'sead_stealth',
    name: 'SEAD (Stealth)',
    description: '2× AARGM-ER + 4× GBU-39 SDB + 2× AIM-120D internal. Kill the SAM network.',
    rcsMultiplier: 1.2,
    stores: [
      { weapon: 'aargm', count: 2, internal: true },
      { weapon: 'gbu39', count: 4, internal: true },
      { weapon: 'aim120', count: 2, internal: true },
    ],
    gunAmmo: 180,
    flares: 24,
    chaff: 24,
    role: 'sead',
  },
  strike_sdb2: {
    id: 'strike_sdb2',
    name: 'Precision Strike (Stealth)',
    description: '4× GBU-53/B StormBreaker + 2× AIM-120D internal. Datalinked glide bombs that chase moving ships and vehicles.',
    rcsMultiplier: 1,
    stores: [
      { weapon: 'gbu53', count: 4, internal: true },
      { weapon: 'aim120', count: 2, internal: true },
    ],
    gunAmmo: 180,
    flares: 24,
    chaff: 24,
    role: 'ag',
  },
  // The real F-35A's full internal SDB II load: a BRU-61/A rack of four GBU-53/B and an AIM-120 in
  // each bay. Offered only where a mission lists it (the boat swarm needs a bomb per moving boat), so
  // the other missions keep their balance.
  strike_sdb2_full: {
    id: 'strike_sdb2_full',
    name: 'Precision Strike (Full Bays)',
    description: '8× GBU-53/B StormBreaker + 2× AIM-120D internal: four bombs and an AMRAAM in each bay. A datalinked bomb for every moving boat in a swarm.',
    rcsMultiplier: 1,
    stores: [
      { weapon: 'gbu53', count: 8, internal: true },
      { weapon: 'aim120', count: 2, internal: true },
    ],
    gunAmmo: 180,
    flares: 24,
    chaff: 24,
    role: 'ag',
  },
  a2a_beast: {
    id: 'a2a_beast',
    name: 'Beast Mode (Air)',
    description: '4× AIM-120D internal + 2× AIM-120D and 2× AIM-9X on wing pylons. Firepower over stealth.',
    rcsMultiplier: 40,
    stores: [
      { weapon: 'aim120', count: 4, internal: true },
      { weapon: 'aim120', count: 2, internal: false },
      { weapon: 'aim9x', count: 2, internal: false },
    ],
    gunAmmo: 180,
    flares: 30,
    chaff: 30,
    role: 'aa',
  },
  strike_beast: {
    id: 'strike_beast',
    name: 'Beast Mode (Strike)',
    description: '2× GBU-31 + 2× AIM-120D internal, 4× GBU-31 and 2× AIM-9X external. Maximum ordnance.',
    rcsMultiplier: 60,
    stores: [
      { weapon: 'gbu31', count: 2, internal: true },
      { weapon: 'aim120', count: 2, internal: true },
      { weapon: 'gbu31', count: 4, internal: false },
      { weapon: 'aim9x', count: 2, internal: false },
    ],
    gunAmmo: 180,
    flares: 30,
    chaff: 30,
    role: 'ag',
  },
};

export const WEAPON_INFO: Record<WeaponId, { name: string; short: string; kind: 'gun' | 'aam' | 'agm' | 'bomb' }> = {
  gun: { name: 'GAU-22/A 25mm', short: 'GUN', kind: 'gun' },
  aim120: { name: 'AIM-120D AMRAAM', short: 'AMRAAM', kind: 'aam' },
  aim9x: { name: 'AIM-9X Sidewinder', short: 'AIM-9X', kind: 'aam' },
  gbu31: { name: 'GBU-31 JDAM', short: 'JDAM', kind: 'bomb' },
  gbu39: { name: 'GBU-39 SDB', short: 'SDB', kind: 'bomb' },
  gbu53: { name: 'GBU-53/B StormBreaker', short: 'SDB II', kind: 'bomb' },
  aargm: { name: 'AGM-88G AARGM-ER', short: 'AARGM', kind: 'agm' },
};

export const AIRCRAFT_INFO: Record<AircraftType, { name: string; nato: string; rwrSymbol: string }> = {
  f35a: { name: 'F-35A Lightning II', nato: 'F-35A', rwrSymbol: '35' },
  mig29: { name: 'MiG-29', nato: 'Fulcrum', rwrSymbol: '29' },
  su27: { name: 'Su-27', nato: 'Flanker', rwrSymbol: '27' },
  su35: { name: 'Su-35', nato: 'Flanker-E', rwrSymbol: '35' },
  su57: { name: 'Su-57', nato: 'Felon', rwrSymbol: '57' },
  tu22m: { name: 'Tu-22M3', nato: 'Backfire', rwrSymbol: '22' },
  a50: { name: 'A-50', nato: 'Mainstay', rwrSymbol: '50' },
  a320: { name: 'A320neo', nato: 'Airliner', rwrSymbol: 'CV' },
  shahed136: { name: 'Shahed-136', nato: 'Shahed', rwrSymbol: 'UA' },
};

export const SAM_INFO: Record<SamType, { name: string; nato: string; rwrSymbol: string }> = {
  sa6: { name: '2K12 Kub', nato: 'SA-6 Gainful', rwrSymbol: '6' },
  sa8: { name: '9K33 Osa', nato: 'SA-8 Gecko', rwrSymbol: '8' },
  sa10: { name: 'S-300PS', nato: 'SA-10 Grumble', rwrSymbol: '10' },
  sa15: { name: '9K330 Tor', nato: 'SA-15 Gauntlet', rwrSymbol: '15' },
  sa18: { name: '9K38 Igla', nato: 'SA-18 Grouse', rwrSymbol: '' },
  zsu23: { name: 'ZSU-23-4 Shilka', nato: 'Shilka', rwrSymbol: 'A' },
};

export const THEATER_INFO: Record<TheaterId, { name: string; region: string }> = {
  auckland: { name: 'Operation Southern Cross', region: 'Auckland, New Zealand' },
};

export const TIME_OF_DAY_INFO: Record<TimeOfDay, { label: string; sunElevationDeg: number }> = {
  dawn: { label: 'Dawn', sunElevationDeg: 6 },
  day: { label: 'Day', sunElevationDeg: 55 },
  dusk: { label: 'Dusk', sunElevationDeg: 4 },
  night: { label: 'Night', sunElevationDeg: -20 },
};
