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
  /** "Operation Desert Lance" */
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
  /** Mission-specific script (spawns, objectives, triggers) — schema owned by src/missions/schema.ts. */
  script: MissionScript;
}

export interface ObjectiveStatus {
  id: string;
  label: string;
  state: 'pending' | 'active' | 'complete' | 'failed';
  primary: boolean;
  progress?: { done: number; total: number };
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
  /** Final campaign mission completed (show the campaign ending). */
  campaignComplete?: boolean;
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
  deps: { createAi: CreateAiBrain; difficulty: DifficultyParams; events: EventBus },
) => MissionRunnerApi;

export interface InstantActionOptions {
  mode: 'dogfight' | 'sam_gauntlet' | 'strike' | 'survival';
  theater: TheaterId;
  timeOfDay: TimeOfDay;
  weather: Weather;
  enemyType: AircraftType | 'mixed';
  enemyCount: number;
}

export interface CampaignProgress {
  /** Mission ids the player can fly. */
  unlocked: string[];
  /** Best result per mission id. */
  best: Record<string, { score: number; grade: MissionResult['grade']; difficulty: Difficulty }>;
  totals: { missions: number; airKills: number; groundKills: number; deaths: number };
}

/* ───────────────────────── Menus / UI (UI agent) ───────────────────────── */

export type MainMenuChoice = 'campaign' | 'instant' | 'training' | 'settings' | 'credits';

export interface UiApi {
  /** Title screen with "TAP TO START" (resolves on the user gesture — used to unlock audio). */
  showSplash(): Promise<void>;
  showLoading(fraction: number, label: string): void;
  hideLoading(): void;
  showMainMenu(): Promise<MainMenuChoice>;
  /** Campaign mission list/map. Resolves the chosen mission or null (back). */
  showCampaign(missions: MissionDef[], progress: CampaignProgress): Promise<MissionDef | null>;
  showTraining(missions: MissionDef[], progress: CampaignProgress): Promise<MissionDef | null>;
  showInstantAction(): Promise<InstantActionOptions | null>;
  /** Briefing + intel map + loadout (hangar) selection. Null = back. */
  showBriefing(mission: MissionDef, settings: Settings): Promise<{ loadout: LoadoutId } | null>;
  /** Settings editor; resolves with the edited settings when closed. */
  showSettings(settings: Settings): Promise<Settings>;
  showPause(mission: MissionRunnerApi | null): Promise<'resume' | 'restart' | 'settings' | 'quit'>;
  showDebrief(result: MissionResult, hasNext: boolean): Promise<'next' | 'retry' | 'menu'>;
  showCredits(): Promise<void>;
  /** Portrait-orientation overlay ("rotate your phone"). */
  setRotateHint(visible: boolean): void;
  /** Short non-blocking message. */
  toast(text: string): void;
  hideAll(): void;
}
/** src/ui/Ui.ts → export const createUi: CreateUi */
export type CreateUi = (root: HTMLElement, deps: { uiClick: () => void; version: string }) => UiApi;
