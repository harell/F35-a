/**
 * F35-A — shared primitive types.
 *
 * OWNERSHIP: orchestrator. Module agents must NOT edit this file (except where a
 * comment explicitly grants an append-only extension). Everything here is the
 * contract between subsystems.
 *
 * ─── COORDINATE CONVENTIONS (read this!) ───────────────────────────────────────
 *  World space (three.js, right-handed, Y-up):
 *     +X = east, +Y = up, -Z = north (so +Z = south). Units: metres, seconds, kg, N, rad.
 *     Sea level is y = 0. The playable world spans [-size/2, +size/2] on X and Z.
 *  Body / local space of every aircraft, missile and model:
 *     forward (nose) = -Z, up = +Y, right wing = +X.   (same as a three.js camera, so a
 *     camera parented to an aircraft looks out of the nose with identity rotation)
 *  Aerospace body rates stored on entities (AircraftEntity.rates):
 *     p = roll rate  (+ = right wing down)   == angular velocity about local -Z
 *     q = pitch rate (+ = nose up)           == angular velocity about local +X
 *     r = yaw rate   (+ = nose right)        == angular velocity about local -Y
 *     => local angular velocity vector = (q, -r, -p). Helpers live in core/math.ts.
 *  Euler angles for display: heading 0 = north, 90° = east (clockwise); pitch + = nose up;
 *     roll + = right wing down.
 *  Display units: knots, feet, feet/min (like the real HMD). Internals are SI.
 */

/**
 * 'neutral' = civilian traffic (airliners, merchant ships). Neither side treats neutrals as hostile: AI, SAMs and
 * sensors' threat logic ignore them, but the human player can still designate, lock and shoot them.
 */
export type Team = 'blue' | 'red' | 'neutral';

/** Would `a` engage `b` on its own? Same side and anything involving neutrals is never hostile. */
export function isHostile(a: Team, b: Team): boolean {
  return a !== b && a !== 'neutral' && b !== 'neutral';
}

export type Difficulty = 'recruit' | 'pilot' | 'veteran' | 'ace';
export type QualityLevel = 'low' | 'medium' | 'high';
/** The game's one theatre: Auckland CBD, Waitematā Harbour & Hauraki Gulf, NZ (campaign, training, Instant Action). */
export type TheaterId = 'auckland';
export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';
export type Weather = 'clear' | 'scattered' | 'overcast';

/** Camera / view modes. `cockpit` shows the 3D cockpit + panoramic cockpit display. */
export type CameraMode =
  | 'cockpit' // pilot eye, HMD symbology + PCD
  | 'hud' // pilot eye without cockpit geometry (max visibility, HMD only)
  | 'chase' // behind and slightly above the jet
  | 'orbit' // free orbit around the jet (drag to rotate)
  | 'target' // over-the-shoulder towards locked target (padlock)
  | 'missile' // follows the last missile/bomb the player released
  | 'flyby' // fixed point the jet flies past (cinematic)
  | 'tactical'; // top-down AWACS style map view

export type AircraftType =
  | 'f35a' // Lockheed Martin F-35A Lightning II (player + friendly wingmen)
  | 'mig29' // MiG-29 Fulcrum
  | 'su27' // Su-27 Flanker
  | 'su35' // Su-35 Flanker-E
  | 'su57' // Su-57 Felon (low observable)
  | 'tu22m' // Tu-22M3 Backfire bomber (intercept target)
  | 'a50' // A-50 Mainstay AEW&C (high value target)
  | 'a320' // Airbus A320neo airliner (neutral civilian traffic)
  | 'shahed136'; // HESA Shahed-136 one-way attack drone (flies a scripted route, see sim/drone)

export type SamType =
  | 'sa6' // 2K12 Kub — Straight Flush radar + 3 launchers, semi-active radar missiles
  | 'sa8' // 9K33 Osa — single amphibious vehicle, command guided
  | 'sa10' // S-300PS — Flap Lid + Clam Shell + vertical launch TELs, long range, TVM
  | 'sa15' // 9K330 Tor — single vehicle, vertical launch, command guided, short range
  | 'sa18' // 9K38 Igla MANPADS team — passive IR, no radar (no RWR warning!)
  | 'zsu23' // ZSU-23-4 Shilka radar-directed AAA
  | 'ad_boat'; // IRGC Navy air-defence fast boat: a MOVING SAM (SA-15-like radar SAM + shoulder-launched SA-18s, sim/boats.ts)

export type GroundTargetType =
  | 'ewr' // early warning radar
  | 'bunker' // command bunker
  | 'fuel' // fuel tanks
  | 'hangar' // hardened aircraft shelter
  | 'parked_jet' // parked enemy fighter
  | 'truck' // supply truck (can move along a path)
  | 'tank' // armour (can move)
  | 'ship' // corvette / frigate (can move)
  | 'factory' // industrial building
  | 'bridge' // bridge span
  | 'suicide_boat' // IRGC Navy unmanned explosive boat (Ya Mahdi type): chases a ship and rams it (sim/boats.ts)
  | 'missile_boat'; // IRGC Navy Peykaap II missile boat: closes to launch range, counts down, fires a Kowsar (sim/boats.ts)

/**
 * Civil merchant ship class of a neutral `'ship'` ground entity (GroundTargetEntity.vessel):
 * picks the model, hull size and callouts. Military ships (corvettes, landing ships) have none.
 * 'tanker' is a ~250 m crude carrier (the escort mission's protected ship).
 */
/** 'ferry': a 34 m harbour catamaran on the ferry timetable (A Stroll in the Park: missions/runtime/shipping.ts). */
export type VesselClass = 'container' | 'cruise' | 'tanker' | 'ferry';

export type WeaponId =
  | 'gun' // GAU-22/A 25 mm, 180 rds
  | 'aim120' // AIM-120D AMRAAM — active radar BVR missile
  | 'aim9x' // AIM-9X Sidewinder — IR, high off-boresight via HMD
  | 'gbu31' // GBU-31 JDAM — 2000 lb GPS guided bomb
  | 'gbu39' // GBU-39 SDB — 250 lb GPS guided glide bomb (standoff)
  | 'gbu53' // GBU-53/B StormBreaker (SDB II): datalinked glide bomb with a tri-mode terminal seeker, hits moving targets
  | 'aargm'; // AGM-88G AARGM-ER — anti-radiation missile for SEAD

/** Every munition that can exist as a MissileEntity (player + enemy + SAM). */
export type MunitionId =
  | Exclude<WeaponId, 'gun'>
  | 'r73' // AA-11 Archer, IR
  | 'r27' // AA-10 Alamo, semi-active radar (launcher must keep lock)
  | 'r77' // AA-12 Adder, active radar
  | 'kab500' // KAB-500S-E, satellite-guided 500 kg bomb (enemy strike jets, carried on the 'gbu31' slot)
  | 'm_3m9' // SA-6 missile, semi-active radar
  | 'm_9m33' // SA-8 missile, command guided
  | 'm_48n6' // SA-10 missile, track-via-missile / command
  | 'm_9m330' // SA-15 missile, command guided
  | 'm_igla' // SA-18 MANPADS missile, IR
  | 'kowsar'; // Kowsar anti-ship missile of the missile boat: visual only, flown by sim/boats.ts, never a target

export type LoadoutId =
  | 'a2a_stealth'
  | 'strike_stealth'
  | 'sead_stealth'
  | 'strike_sdb2'
  /** 8× GBU-53/B + 2× AIM-120D: only in missions that list it in allowedLoadouts (the boat swarm, #82). */
  | 'strike_sdb2_full'
  /** 8× GBU-53/B + 2× AARGM-ER, no air-to-air missile: the boat swarm's only loadout (#136). */
  | 'strike_maritime'
  | 'a2a_beast'
  | 'strike_beast'
  /** Nothing in the bays or on the pylons: the gun only (free flight's default, #113). */
  | 'clean';

/** Throttle axis 0..1. 0 = idle, AB_DETENT = 100% military (dry) power, 1 = max afterburner. */
export const AB_DETENT = 0.9;

/** Stick/throttle/trigger state. Produced by the player's InputSystem or by an AiBrain. */
export interface ControlInput {
  /** -1..1, +1 = full aft stick (nose up). */
  pitch: number;
  /** -1..1, +1 = full right stick (roll right). */
  roll: number;
  /** -1..1, +1 = right rudder (nose right). */
  yaw: number;
  /** 0..1, see AB_DETENT. */
  throttle: number;
  /** Speed brake held. */
  airbrake: boolean;
  /** Gun trigger held. */
  fireGun: boolean;
  /** Weapon release (pickle / missile) button held — combat system acts on the rising edge. */
  fireWeapon: boolean;
  /** Flare dispense button held (rising edge = one salvo; held = program repeats). */
  flare: boolean;
  /** Chaff dispense button held. */
  chaff: boolean;
}

export function neutralControls(): ControlInput {
  return { pitch: 0, roll: 0, yaw: 0, throttle: 0.75, airbrake: false, fireGun: false, fireWeapon: false, flare: false, chaff: false };
}

/** Cockpit caution / warning items (ICAWS). Computed each frame for the player. */
export type WarningId =
  | 'pull_up' // ground collision predicted
  | 'altitude' // below safe altitude, descending
  | 'stall' // AoA beyond limit / departure
  | 'over_g' // load factor exceeding limit
  | 'bingo' // fuel at bingo
  | 'fuel_low'
  | 'engine_fire'
  | 'engine_fail'
  | 'hydraulics'
  | 'damage' // airframe damaged
  | 'missile' // missile approach warning (DAS/MAWS)
  | 'spike' // enemy fire-control radar lock on us (RWR)
  | 'flares_low'
  | 'chaff_low'
  | 'speed_low';

/** Pre-rendered voice clips in public/audio/voice/<id>.mp3 (generated by tools/gen-voices.sh). */
export type VoiceId =
  // "Bitching Betty" ICAWS voice (female, cockpit)
  | 'b_missile' // "Missile. Missile."
  | 'b_pull_up' // "Pull up. Pull up."
  | 'b_altitude' // "Altitude. Altitude."
  | 'b_bingo' // "Bingo. Bingo."
  | 'b_fuel_low' // "Fuel low."
  | 'b_engine_fire' // "Engine fire. Engine fire."
  | 'b_warning' // "Warning. Warning."
  | 'b_over_g' // "Over G. Over G."
  | 'b_aoa' // "Angle of attack."
  | 'b_flares_low' // "Flares low."
  | 'b_chaff_low' // "Chaff low."
  | 'b_hydraulics' // "Hydraulics."
  | 'b_speed' // "Speed. Speed."
  // Player / wingman brevity calls (male, radio)
  | 'p_fox3' // "Fox three."
  | 'p_fox2' // "Fox two."
  | 'p_rifle' // "Rifle." (air-to-ground guided munition)
  | 'p_magnum' // "Magnum." (anti-radiation missile)
  | 'p_guns' // "Guns, guns."
  | 'p_splash' // "Splash one."
  | 'p_spike' // "Spike." (locked by fighter radar)
  | 'p_mud_spike' // "Mud spike." (locked by SAM radar)
  | 'p_defending' // "Defending!"
  | 'p_winchester' // "Winchester." (out of weapons)
  | 'p_bingo' // "Bingo fuel, RTB."
  | 'p_copy' // "Copy."
  | 'p_engaged' // "Engaged."
  | 'p_target_destroyed' // "Target destroyed."
  // AWACS (controller, radio)
  | 'a_bandits' // "Bandits, bandits."
  | 'a_new_picture' // "New picture, multiple groups."
  | 'a_sam_launch' // "SAM launch! SAM launch!"
  | 'a_good_kill' // "Good kill, good kill."
  | 'a_mission_complete' // "Mission complete. Return to base."
  | 'a_mission_failed' // "Mission failed."
  | 'a_objective_complete' // "Objective complete."
  | 'a_rtb' // "Return to base."
  | 'a_eject' // "Eject! Eject!"
  | 'a_friendly_down'; // "Friendly down."

export type ExplosionSize = 'tiny' | 'small' | 'medium' | 'large' | 'huge';

/** Difficulty tuning knobs. Values live in core/data.ts (DIFFICULTIES). */
export interface DifficultyParams {
  id: Difficulty;
  label: string;
  description: string;
  /** Multiplier applied to damage the PLAYER receives. */
  playerDamageScale: number;
  /** 0..1 generic AI skill (aim, energy management, tactics). */
  aiSkill: number;
  /** Seconds before AI reacts to new threats / opportunities. */
  aiReactionTime: number;
  /** Max G AI pilots will pull. */
  aiMaxG: number;
  /** Multiplier on enemy missile hit probability (via seeker/fuse/countermeasure resistance). */
  enemyMissileSkill: number;
  /** Multiplier on SAM detection + engagement range. */
  samRangeScale: number;
  /** Seconds SAM needs from track to launch. */
  samReactionTime: number;
  /** Seconds for the player radar to achieve a hard lock. */
  playerLockTime: number;
  /** Probability multiplier that the player's flares/chaff decoy a missile. */
  countermeasureEffectiveness: number;
  /** Flight assists: auto-trim, stall/spin protection, g-limiter, auto-rudder. */
  flightAssist: boolean;
  /**
   * Auto-GCAS on the player's jet: the automatic fly-up before the ground. Recruit only; from Pilot up
   * the player can fly into the ground (owner's call, 2026-10-04).
   */
  autoGcas: boolean;
  /** Screen blackout/redout from sustained G. */
  gEffects: boolean;
  /** Extra seconds of warning/min range padding on HUD shoot cues. */
  generousShootCues: boolean;
  /** Multiplier on number of enemies spawned by missions (≥1 extra enemies on higher levels). */
  enemyCountScale: number;
  /** Multiplier for score. */
  scoreMultiplier: number;
  /** Player can survive this many direct missile hits (1 = first hit is not always fatal). */
  playerMissileHitsToKill: number;
  /** Fuel burn multiplier. */
  fuelBurnScale: number;
}

export interface QualitySettings {
  level: QualityLevel;
  /** Max device pixel ratio for the WebGL canvas. */
  pixelRatio: number;
  /** Camera far plane / fog distance in metres. */
  drawDistance: number;
  /** 0 = coarse, 1 = normal, 2 = fine terrain mesh. */
  terrainDetail: 0 | 1 | 2;
  /**
   * Real 43 m LiDAR terrain detail (Auckland, a lazily loaded ≈ 1.2 MB download). Only takes effect
   * with terrainDetail 2 (the 2048² heightfield); low / medium never download it.
   */
  hdTerrain: boolean;
  /**
   * Real aerial photo of the CBD and waterfront (Auckland, a lazily loaded ≈ 270 kB / 630 kB download on
   * the medium / high tier: terrainDetail 1 → 2048², 2 → 4096²). Low never downloads it.
   */
  aerialPhoto: boolean;
  /** Number of cloud billboards/puffs. */
  cloudCount: number;
  /** Multiplier on particle budgets (smoke, sparks, debris). */
  particleScale: number;
  /** Enable shadow map for the player jet only. */
  shadows: boolean;
  antialias: boolean;
  /** Bloom over the world pass (src/render/Bloom.ts, #139): the sun, glints on the water, night lights. */
  postfx: boolean;
  /** Scenery object density multiplier (trees/buildings). */
  sceneryDensity: number;
  /** Foam wakes behind moving ships and ferries (one draw call for all of them). */
  wakes: boolean;
  /** Visual-only harbour ferries (Auckland), 0 = none; capped by the fleet size (render/traffic/ferryRoutes.ts). */
  ferries: number;
  /** LINZ railway lines (Auckland) as ballast-and-track ribbons (one draw call); off = no tracks drawn. */
  railways: boolean;
  /**
   * How far past its target the target camera (PiP) draws, in metres: its far plane is the camera's
   * distance to the target plus this (the fog reaches the horizon colour there), so distant terrain,
   * the city and scenery are culled from the second pass. It reaches further for a high target, so the
   * ground in the frame stays inside it (targetCamFar). 0 = the main camera's far plane (the whole
   * scene again).
   */
  targetCamRange: number;
  /**
   * The target camera draws the static scenery detail too (city, roads and rail, airfield buildings,
   * tree / house scatter, runway and apron markings, night lights and their reflections:
   * EnvironmentApi.targetCamOmit). Off = the PiP shows the target over terrain, water, sky and clouds only.
   */
  targetCamScenery: boolean;
}

export type ControlScheme = 'stick' | 'tilt';

export interface Settings {
  difficulty: Difficulty;
  quality: QualityLevel | 'auto';
  controlScheme: ControlScheme;
  invertPitch: boolean;
  /** 0.25..2 */
  stickSensitivity: number;
  /** 0.25..2 */
  tiltSensitivity: number;
  /** Swap stick and throttle sides. Default: throttle left, stick right (like the real F-35). */
  leftHanded: boolean;
  masterVolume: number; // 0..1
  sfxVolume: number; // 0..1
  voiceVolume: number; // 0..1
  /** Adaptive soundtrack volume (0 = music off). */
  musicVolume: number; // 0..1
  haptics: boolean;
  /** Show on-screen hints/tutorial prompts. */
  hints: boolean;
  /** HMD symbology colour. */
  hudColor: 'green' | 'amber' | 'cyan';
  /** Vertical field of view in degrees for external/cockpit views. */
  fov: number;
  /** Show FPS counter. */
  showFps: boolean;
  /** Default camera when a mission starts. */
  defaultView: 'cockpit' | 'hud' | 'chase';
  /** Target camera: small picture-in-picture view of the designated / locked target. */
  targetCam: boolean;
  /**
   * Weapon window (hud/hmd/wpnCam.ts): your missile or bomb followed to the target, in the target
   * camera's slot. 'compact' keeps the slot's size for the final seconds, 'dynamic' grows it.
   */
  missileCam: 'off' | 'compact' | 'dynamic';
  /** HD terrain on the high quality tier (see QualitySettings.hdTerrain). Off: procedural detail, no download. */
  hdTerrain: boolean;
  /** Aerial photo of the CBD and waterfront on the medium / high tier (see QualitySettings.aerialPhoto). Off: procedural ground, no download. */
  aerialPhoto: boolean;
}
