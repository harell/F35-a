/**
 * F35-A — presentation / app-layer contracts (render, HUD, cockpit, audio, input, UI, missions).
 * OWNERSHIP: orchestrator. Do not edit. Each module exports a `create*` factory with the
 * exact name + path listed next to its type so src/game/Game.ts can wire everything.
 */
import type { Object3D, PerspectiveCamera, Quaternion, Scene, Vector3, WebGLRenderer } from 'three';
import type { EventBus } from './events';
import type {
  AircraftType,
  CameraMode,
  ControlInput,
  ControlScheme,
  Difficulty,
  DifficultyParams,
  LoadoutId,
  QualitySettings,
  Settings,
  TheaterId,
  TimeOfDay,
  VoiceId,
  Weather,
} from './types';
import type { AircraftEntity } from '../sim/entities';
import type { CreateAiBrain, SimWorld, TerrainQuery } from '../sim/api';
import type { MissionScript } from '../missions/schema';

/* ───────────────────────── Per-frame context ───────────────────────── */

export interface FrameContext {
  /** Real frame delta (s), clamped to ≤ 0.1. Still > 0 while paused (for UI anims) — check `paused`. */
  dt: number;
  /** Sim time (s). */
  time: number;
  world: SimWorld;
  player: AircraftEntity | null;
  camera: PerspectiveCamera;
  viewMode: CameraMode;
  /** Entity the camera is focused on (player, missile in missile-cam, target in target view). */
  focusId: number | null;
  mission: MissionRunnerApi | null;
  settings: Settings;
  quality: QualitySettings;
  paused: boolean;
  /** CSS pixel size of the viewport + safe-area insets (notches). */
  screen: { width: number; height: number; dpr: number; safe: { top: number; right: number; bottom: number; left: number } };
}

/* ───────────────────────── World rendering (WORLD agent) ───────────────────────── */

export type SceneryFeatureType = 'airbase' | 'town' | 'city' | 'industrial' | 'port' | 'village' | 'forest' | 'farmland';

export interface SceneryFeature {
  type: SceneryFeatureType;
  /** World XZ centre (m). */
  x: number;
  z: number;
  /** Yaw (deg) — runway direction for airbases. */
  rotation?: number;
  /** Radius/extent scale (1 = default). */
  size?: number;
  /** Flatten terrain under the feature (default true for airbase/town/city/industrial/port). */
  flatten?: boolean;
  /** Airbase: one of the theatre's real airfields (src/core/airfields.ts), set by the world module. */
  airfield?: string;
  /**
   * Real footprint to level instead of the default shape: a ring, flat [x0, z0, x1, z1, ...] (world m),
   * e.g. an airfield's runway strips, taxiways and aprons from OpenStreetMap. Set by the world module.
   */
  outline?: number[];
}

export interface EnvironmentOptions {
  theater: TheaterId;
  timeOfDay: TimeOfDay;
  weather: Weather;
  seed: number;
  features: SceneryFeature[];
  /** Extra flat pads (e.g. under SAM sites) — {x, z, radius}. */
  pads: { x: number; z: number; radius: number }[];
  quality: QualitySettings;
  onProgress?: (fraction: number, label: string) => void;
}

export interface EnvironmentApi {
  readonly terrain: TerrainQuery;
  /** Unit vector pointing TO the sun (or moon at night). */
  readonly sunDirection: Vector3;
  readonly isNight: boolean;
  /** Fog colour / distance for other modules that render custom materials. */
  readonly fogColor: number;
  /**
   * Static scenery detail the target camera (PiP) leaves out of its pass when
   * QualitySettings.targetCamScenery is off (low quality): the scenery group (city, roads and rail,
   * airfield buildings, runway and apron markings, tree / house scatter, night lights) and the lights'
   * water reflections. Terrain, water, sky and clouds stay. Nothing a PiP target is drawn by may be in
   * here.
   */
  readonly targetCamOmit?: readonly Object3D[];
  /**
   * Landmark visuals (the Sky Tower) inside targetCamOmit that the target camera still draws when it
   * shows that landmark (the tower hit or collapsing, hud/hmd/pip.ts pipLandmarkFocus).
   */
  readonly targetCamLandmarks?: readonly Object3D[];
  update(ctx: FrameContext): void;
  dispose(): void;
}
/** src/world/Environment.ts → export const createEnvironment: CreateEnvironment */
export type CreateEnvironment = (scene: Scene, renderer: WebGLRenderer, opts: EnvironmentOptions) => Promise<EnvironmentApi>;

/* ───────────────────────── Entity visuals (MODELS agent) ───────────────────────── */

export interface EntityRendererApi {
  /** Create/destroy/animate visuals for all world entities (aircraft, missiles, SAMs, ground, decoys). */
  update(ctx: FrameContext): void;
  /** Pilot eye position in aircraft local space (nose = -Z). */
  getEyeOffset(type: AircraftType): Vector3;
  getObject(entityId: number): Object3D | null;
  /** Hide the player's own jet (cockpit views). */
  setPlayerVisible(visible: boolean): void;
  /**
   * Re-evaluate every visual's LOD / visibility for a second viewpoint (the target camera) right before
   * rendering it: the target and its neighbours get their close-up models, the player's jet is shown.
   * The next update() restores everything for the main camera.
   * @param maxDist  hide aircraft farther than this (m) for this view: the target camera's short far
   *                 plane on low quality (their flame meshes aren't frustum-culled, so a far plane alone
   *                 still draws them)
   */
  prepareView?(camPos: Vector3, maxDist?: number): void;
  dispose(): void;
}
/** src/render/EntityRenderer.ts → export const createEntityRenderer: CreateEntityRenderer */
export type CreateEntityRenderer = (scene: Scene, world: SimWorld, env: EnvironmentApi, quality: QualitySettings) => EntityRendererApi;

export interface EffectsApi {
  /** Missile smoke trails, AB flames glow, explosions, fire/smoke columns, tracers, flares, chaff,
   *  contrails, wingtip vortices, vapor cones, debris, water splashes, dust. */
  update(ctx: FrameContext): void;
  dispose(): void;
}
/** src/render/effects/Effects.ts → export const createEffects: CreateEffects */
export type CreateEffects = (scene: Scene, world: SimWorld, events: EventBus, env: EnvironmentApi, quality: QualitySettings) => EffectsApi;

export interface CameraRigApi {
  readonly camera: PerspectiveCamera;
  readonly mode: CameraMode;
  /** Entity currently followed. */
  readonly focusId: number | null;
  /** Head orientation relative to the aircraft body (cockpit/hud modes); identity = looking out the nose. */
  readonly headLocal: Quaternion;
  setMode(mode: CameraMode): void;
  /** Cycle cockpit → hud → chase → orbit → target → missile → flyby → tactical (skipping unavailable). */
  nextMode(): CameraMode;
  /** Look-around deltas (rad) from touch drag / mouse / right stick. */
  look(dYaw: number, dPitch: number): void;
  resetLook(): void;
  /** Screen shake impulse (0..1). */
  shake(intensity: number): void;
  update(ctx: FrameContext): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
/** src/render/CameraRig.ts → export const createCameraRig: CreateCameraRig */
export type CreateCameraRig = (world: SimWorld, entities: EntityRendererApi, settings: Settings) => CameraRigApi;

/* ───────────────────────── Cockpit + HMD (HUD agent) ───────────────────────── */

export interface CockpitApi {
  /** Shown only in 'cockpit' mode. */
  visible: boolean;
  /** Update PCD pages (TSD, radar, SMS, FUEL/ENG, ICAWS, RWR) and canopy animation. */
  update(ctx: FrameContext, headLocal: Quaternion): void;
  /** Second render pass after the world: clears depth and draws the cockpit with a near-plane camera. */
  render(renderer: WebGLRenderer): void;
  resize(width: number, height: number): void;
  /** Touch on the PCD (normalised screen coords) → page switching. Returns true if consumed. */
  handleTap(nx: number, ny: number): boolean;
  dispose(): void;
}
/** src/hud/Cockpit.ts → export const createCockpit: CreateCockpit */
export type CreateCockpit = (events: EventBus, quality: QualitySettings) => CockpitApi;

export interface HudApi {
  /** Draws the HMD symbology on the overlay canvas (all views except tactical). */
  update(ctx: FrameContext): void;
  resize(width: number, height: number, dpr: number): void;
  setVisible(visible: boolean): void;
  /** Tap at CSS px → id of entity whose HUD box was tapped (designate), or null. */
  pick(x: number, y: number): number | null;
  dispose(): void;
}
/** src/hud/Hud.ts → export const createHud: CreateHud */
export type CreateHud = (canvas: HTMLCanvasElement, events: EventBus) => HudApi;

/* ───────────────────────── Audio (AUDIO agent) ───────────────────────── */

export interface AudioApi {
  /** Call from a user gesture (tap) — resumes the AudioContext (iOS/Android autoplay policy). */
  unlock(): Promise<void>;
  /** Fetch + decode voice clips (public/audio/voice/*.mp3). Never rejects (missing clips are skipped). */
  load(onProgress?: (fraction: number) => void): Promise<void>;
  /** Continuous sounds: engine, afterburner, wind, gun, RWR tones, AIM-9 growl, warnings. */
  update(ctx: FrameContext): void;
  setVolumes(master: number, sfx: number, voice: number): void;
  /** Soundtrack volume 0..1 (0 = off). */
  setMusicVolume?(volume: number): void;
  /** Mute/duck in-mission sounds while paused. */
  setPaused(paused: boolean): void;
  playVoice(id: VoiceId): void;
  uiClick(): void;
  /** Stop every in-mission sound (mission end / restart). */
  stopAll(): void;
  dispose(): void;
}
/** src/audio/AudioSystem.ts → export const createAudio: CreateAudio */
export type CreateAudio = (events: EventBus) => AudioApi;

/* ───────────────────────── Input (UI agent) ───────────────────────── */

export type InputCommand =
  | 'cycleWeapon'
  | 'cycleTarget'
  | 'camera'
  | 'pause'
  | 'radar' // toggle radar emission (EMCON)
  | 'lookReset'
  | 'padlock' // jump to target view
  | 'missileCam'
  | 'recenterTilt';

export interface InputApi {
  /** Player flight controls (throttle is a persistent lever, not spring-loaded). */
  readonly controls: ControlInput;
  /**
   * The scheme actually flying: 'stick' when tilt is selected but no orientation data arrived
   * (sensor missing, permission denied), so the touch stick took over.
   */
  readonly activeScheme: ControlScheme;
  /** Poll devices, update touch controls & labels. */
  update(dt: number, ctx: FrameContext): void;
  on(cmd: InputCommand, fn: () => void): () => void;
  /** Look-around deltas accumulated since the last call (rad). */
  consumeLook(): { yaw: number; pitch: number };
  /** Taps on the 3D view that are not on a control (CSS px) — for HUD target picking / PCD taps. */
  consumeTaps(): { x: number; y: number }[];
  /** Show/hide on-screen controls and enable/disable capture. */
  setEnabled(enabled: boolean): void;
  setThrottle(value: number): void;
  applySettings(settings: Settings): void;
  /** iOS 13+ needs DeviceOrientationEvent.requestPermission() from a gesture. */
  requestMotionPermission(): Promise<boolean>;
  recenterTilt(): void;
  dispose(): void;
}
/** src/input/Input.ts → export const createInput: CreateInput */
export type CreateInput = (root: HTMLElement, settings: Settings) => InputApi;

/* ───────────────────────── Missions (MISSIONS agent) ───────────────────────── */

export type WaypointKind = 'nav' | 'ip' | 'target' | 'cap' | 'rtb';

export interface Waypoint {
  id: string;
  label: string;
  position: Vector3;
  /** Capture radius (m). */
  radius: number;
  kind: WaypointKind;
}

export interface IntelMarker {
  kind: 'sam' | 'air' | 'target' | 'friendly' | 'airbase';
  label: string;
  x: number;
  z: number;
  /** Threat ring radius (m) for SAMs. */
  radius?: number;
}

export interface MissionDef {
  id: string;
  kind: 'campaign' | 'training' | 'instant';
  /** Order within its list (campaign mission number). */
  index: number;
  /** "Harbour Watch" */
  title: string;
  /** One-line summary for list screens. */
  subtitle: string;
  theater: TheaterId;
  timeOfDay: TimeOfDay;
  weather: Weather;
  seed: number;
  /** Briefing paragraphs. */
  briefing: string[];
  /** Objective bullet points shown on the briefing screen. */
  objectiveText: string[];
  recommendedLoadout: LoadoutId;
  allowedLoadouts: LoadoutId[];
  /** Player start (world XZ metres, altitude MSL m, heading deg, speed m/s). */
  player: { x: number; z: number; altitude: number; heading: number; speed: number; fuel?: number };
  features: SceneryFeature[];
  /** Briefing map markers. */
  intel: IntelMarker[];
  /** Mission time limit (s), optional. */
  timeLimit?: number;
  /**
   * Rounds in the player's gun, overriding the loadout's `gunAmmo` (180) at launch, for
   * missions designed around the gun. A number, or per difficulty
   * (`{ recruit: 400, veteran: 300 }`): a difficulty left out takes the nearest easier one listed,
   * else the easiest listed. Leave it out to keep the loadout's rounds.
   */
  gunAmmo?: number | Partial<Record<Difficulty, number>>;
  /** Mission-specific script (spawns, objectives, triggers) — schema owned by src/missions/schema.ts. */
  script: MissionScript;
}

/** Campaign ids: the IRGC campaign over Auckland (epic #72). */
export type CampaignId = 'irgc';

/**
 * A campaign: an ordered chain of missions with its own unlocks and ending. Each campaign's first
 * mission is always unlocked and winning one unlocks the next in the same campaign. Mission ids are
 * unique across every campaign and training, so progress (keyed by mission id) never mixes them up.
 */
export interface CampaignDef {
  id: CampaignId;
  /** "IRGC · Interspecies Revolutionary Guard Corps" */
  name: string;
  /** One line for the campaign picker. */
  description: string;
  /** In order (MissionDef.index is the mission number within this campaign). Empty = coming soon. */
  missions: MissionDef[];
  /**
   * false = disabled: the code, the missions and their tests stay, but the player never sees the
   * campaign (no menu entry, training doesn't lead into it) and playtests skip it. Default true.
   */
  enabled?: boolean;
}

export interface ObjectiveStatus {
  id: string;
  label: string;
  state: 'pending' | 'active' | 'complete' | 'failed';
  primary: boolean;
  progress?: { done: number; total: number };
  /** The hostile group a protect objective counts on its HUD line ("STRIKERS 3"): its jets left in the fight. */
  threat?: { label: string; left: number };
}

export interface MissionResult {
  missionId: string;
  title: string;
  success: boolean;
  reason: string;
  difficulty: Difficulty;
  /** Mission time (s). */
  time: number;
  score: number;
  grade: 'S' | 'A' | 'B' | 'C' | 'D' | 'F';
  kills: { air: number; sam: number; ground: number };
  friendlyLosses: number;
  shotsFired: number;
  hits: number;
  /** 0..1 */
  accuracy: number;
  damageTaken: number;
  objectives: ObjectiveStatus[];
  /** Debrief advice (why you failed / how to do better). */
  tips?: string[];
  /** Awards earned this sortie (e.g. 'Distinguished Flying Cross', 'Bridge Runner'). */
  medals?: { id: string; name: string; description: string }[];
  /** Final mission of a campaign completed (show that campaign's ending: the mission id names it). */
  campaignComplete?: boolean;
  /** Free flight (A Stroll in the Park): no grade, no score, nothing recorded in the career. */
  freeFlight?: boolean;
  /** Codex entry that explains what ended a failed sortie (e.g. 'mud' after a radar SAM hit); the debrief links to it. */
  codexId?: string;
}

export interface MissionRunnerApi {
  readonly def: MissionDef;
  readonly state: 'running' | 'success' | 'failed';
  readonly objectives: ObjectiveStatus[];
  readonly waypoints: Waypoint[];
  /** Current steering waypoint (HUD steering cue / TSD). */
  readonly currentWaypoint: Waypoint | null;
  /** Tutorial / contextual hint for the HUD (null = none). */
  readonly hint: string | null;
  /** Spawn the player (with loadout), friendlies, enemies, SAMs, targets. */
  setup(world: SimWorld, loadout: LoadoutId): void;
  /** Objectives, triggers, radio, reinforcements, failure checks. Emits 'objective' and 'mission:end'. */
  update(world: SimWorld, dt: number): void;
  result(world: SimWorld): MissionResult;
  /** Detach event handlers / free references (called by Game on teardown). */
  dispose?(): void;
}
/** src/missions/MissionRunner.ts → export const createMissionRunner: CreateMissionRunner */
export type CreateMissionRunner = (
  def: MissionDef,
  deps: {
    createAi: CreateAiBrain;
    difficulty: DifficultyParams;
    events: EventBus;
    /** Civil helicopters flying at once (the quality tier's; default 3). */
    helicopters?: number;
  },
) => MissionRunnerApi;

export interface InstantActionOptions {
  /** 'stroll' is A Stroll in the Park: free flight with no hostiles (enemyType / enemyCount unused). */
  mode: 'stroll' | 'dogfight' | 'sam_gauntlet' | 'strike' | 'defend';
  theater: TheaterId;
  timeOfDay: TimeOfDay;
  weather: Weather;
  enemyType: AircraftType | 'mixed';
  enemyCount: number;
}

/**
 * The player's progress over every campaign and training, keyed by mission id (ids are unique
 * across campaigns, so one campaign's unlocks never touch another's).
 */
export interface CampaignProgress {
  /** Mission ids the player can fly. */
  unlocked: string[];
  /** Best result per mission id. */
  best: Record<string, { score: number; grade: MissionResult['grade']; difficulty: Difficulty }>;
  totals: { missions: number; airKills: number; groundKills: number; deaths: number };
}

/* ───────────────────────── Menus / UI (UI agent) ───────────────────────── */

export type MainMenuChoice = 'campaign' | 'instant' | 'training' | 'codex' | 'settings' | 'credits';

export interface UiApi {
  /** Title screen with "TAP TO START" (resolves on the user gesture — used to unlock audio). */
  showSplash(): Promise<void>;
  showLoading(fraction: number, label: string): void;
  hideLoading(): void;
  showMainMenu(): Promise<MainMenuChoice>;
  /** Campaign picker (one card per campaign). Resolves the chosen campaign or null (back). */
  showCampaigns(campaigns: CampaignDef[], progress: CampaignProgress): Promise<CampaignDef | null>;
  /** One campaign's mission list/map. Resolves the chosen mission or null (back). */
  showCampaign(campaign: CampaignDef, progress: CampaignProgress): Promise<MissionDef | null>;
  showTraining(missions: MissionDef[], progress: CampaignProgress): Promise<MissionDef | null>;
  showInstantAction(): Promise<InstantActionOptions | null>;
  /** Briefing + intel map + loadout (hangar) selection. Null = back. */
  showBriefing(mission: MissionDef, settings: Settings): Promise<{ loadout: LoadoutId } | null>;
  /** Settings editor; resolves with the edited settings when closed. */
  showSettings(settings: Settings): Promise<Settings>;
  showPause(mission: MissionRunnerApi | null): Promise<'resume' | 'restart' | 'settings' | 'quit'>;
  /**
   * Debrief screen. `next` labels the button that flies the next mission or lesson ('Next mission',
   * 'Next lesson', 'Start the campaign': nextMissionLabel() in src/missions), null when there is none.
   */
  showDebrief(result: MissionResult, next: string | null): Promise<'next' | 'retry' | 'menu'>;
  showCredits(): Promise<void>;
  /** Codex: weapons, warnings and threats, open at an entry id if given. Resolves on Back. */
  showCodex(entry?: string): Promise<void>;
  /** Portrait-orientation overlay ("rotate your phone"). */
  setRotateHint(visible: boolean): void;
  /** Short non-blocking message. */
  toast(text: string): void;
  hideAll(): void;
}
/** src/ui/Ui.ts → export const createUi: CreateUi */
export type CreateUi = (root: HTMLElement, deps: { uiClick: () => void; build: string }) => UiApi;
