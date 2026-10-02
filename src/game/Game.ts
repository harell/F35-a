/**
 * F35-A — application / integration layer.
 * OWNERSHIP: orchestrator. Wires every module together through the contracts in
 * core/contracts.ts and sim/api.ts, runs the app state machine and the main loop.
 *
 * URL parameters (handy for testing on a phone or from Playwright):
 *   ?mission=<id>&loadout=<id>&autostart=1   skip menus and fly a mission immediately
 *                                            (test hooks only: dev server / VITE_TEST_HOOKS=1, see TEST_HOOKS)
 *   ?difficulty=recruit|pilot|veteran|ace    override difficulty
 *   ?quality=low|medium|high                 override quality
 *   ?view=cockpit|hud|chase|orbit|...        initial camera
 *   ?fps=1                                   FPS counter
 *   ?seed=<n>                                (test hooks) fixed combat RNG seed, and the sim clock held:
 *                                            only __f35.simulate() advances it (__f35.hold(false) lets
 *                                            it run), so browser perf reads reproduce (#66)
 */
import { ACESFilmicToneMapping, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import { EventBus } from '../core/events';
import { DIFFICULTIES, GAME_BUILD, QUALITY_PRESETS, TEST_HOOKS } from '../core/data';
import { loadSettings, resolveQuality, saveSettings } from '../core/settings';
import type {
  AudioApi,
  CameraRigApi,
  CampaignProgress,
  CockpitApi,
  EffectsApi,
  EntityRendererApi,
  EnvironmentApi,
  FrameContext,
  HudApi,
  InputApi,
  MissionDef,
  MissionResult,
  MissionRunnerApi,
  UiApi,
} from '../core/contracts';
import type { CameraMode, ControlInput, LoadoutId, QualityLevel, QualitySettings, Settings } from '../core/types';
import type { SimWorld } from '../sim/api';
import { createSimWorld } from '../sim/World';
import { forceDestroy } from './forceDestroy';
import { createCombatSystem, createCombatSystemSeeded } from '../sim/weapons/CombatSystem';
import { createAiBrain } from '../ai';
import { createEnvironment } from '../world/Environment';
import { createEntityRenderer } from '../render/EntityRenderer';
import { createEffects } from '../render/effects/Effects';
import { createCameraRig } from '../render/CameraRig';
import { TargetCam, targetCamOmitFor } from '../render/TargetCam';
import { pipView } from '../hud/hmd/pip';
import { createHud } from '../hud/Hud';
import { createCockpit } from '../hud/Cockpit';
import { createAudio } from '../audio/AudioSystem';
import { createInput } from '../input/Input';
import { createUi } from '../ui/Ui';
import { tag as analyticsTag, track, upgrade } from '../analytics/clarity';
import {
  CAMPAIGN,
  CAMPAIGNS,
  TRAINING,
  buildInstantMission,
  createMissionRunner,
  loadProgress,
  nextMissionAfter,
  nextMissionLabel,
  recordResult,
  missionById,
  missionDifficulty,
  saveProgress,
  terrainPadsFor,
  followActiveScheme,
} from '../missions';
import { COLLAPSE } from '../core/skyTower';
import { destroyLandmark, hitSkyTower } from '../sim/landmarks';
import { FlowInterrupt } from './flow';
import { testSeed } from './testParams';

const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;
/** Seconds the mission keeps running after success/failure before the debrief. */
const END_DELAY_SUCCESS = 6;
const END_DELAY_FAILED = 5;
/** …or until the Sky Tower's collapse has played out (it fails the mission the moment it is hit). */
const END_DELAY_COLLAPSE = COLLAPSE.ruinsAt + 2.6;

type MissionOutcome = 'next' | 'retry' | 'menu';

interface Session {
  def: MissionDef;
  loadout: LoadoutId;
  scene: Scene;
  env: EnvironmentApi;
  world: SimWorld;
  runner: MissionRunnerApi;
  entities: EntityRendererApi;
  effects: EffectsApi;
  rig: CameraRigApi;
  cockpit: CockpitApi;
  targetCam: TargetCam;
  endTimer: number;
  lastViewMode: CameraMode | null;
  unsubscribers: (() => void)[];
  resolve: (outcome: 'ended' | 'restart' | 'quit') => void;
}

export class Game {
  readonly events = new EventBus();
  settings: Settings;
  quality: QualitySettings;
  progress: CampaignProgress;

  readonly renderer: WebGLRenderer;
  readonly hud: HudApi;
  readonly audio: AudioApi;
  readonly input: InputApi;
  readonly ui: UiApi;

  private session: Session | null = null;
  private paused = false;
  private pauseMenuOpen = false;
  /** runSession() is building a mission (the session isn't flying yet). */
  private missionLoading = false;
  /** Every screen the app flow waits on goes through `flow.ask()`, so fly() can take over from it. */
  private readonly flow = new FlowInterrupt();
  /** Test hooks: the mission fly() asked for, until the main menu loop starts it. */
  private pendingFly: { def: MissionDef; loadout: LoadoutId } | null = null;
  /** Test hooks: pause() came during a fly() hand-over or a load; open the menu once the mission is ready. */
  private pauseWhenReady = false;
  private lastFrame = performance.now();
  private accumulator = 0;
  private frameTimes: number[] = [];
  private dynScale = 1;
  private dynTimer = 0;
  private fpsEl: HTMLDivElement | null = null;
  private fpsAccum = { frames: 0, time: 0 };
  private wakeLock: { release(): Promise<void> } | null = null;
  private readonly params = new URLSearchParams(location.search);
  /** Test hooks: AI flies the player's jet / scripted control override. */
  private autopilot = false;
  /** Test hooks: the real-time loop doesn't step the sim; only simulate() moves its clock (`?seed=`, hold()). */
  private simHeld = false;
  private controlOverride: Partial<ControlInput> | null = null;
  private screen = { width: 1, height: 1, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } };
  private safeProbe: HTMLDivElement;

  constructor(private readonly root: HTMLElement) {
    this.settings = loadSettings();
    const pd = this.params.get('difficulty');
    if (pd && pd in DIFFICULTIES) this.settings.difficulty = pd as Settings['difficulty'];
    const pq = this.params.get('quality');
    if (pq && pq in QUALITY_PRESETS) this.settings.quality = pq as QualityLevel;
    if (this.params.get('fps') === '1') this.settings.showFps = true;
    const ph = this.params.get('hdterrain');
    if (ph === '0' || ph === '1') this.settings.hdTerrain = ph === '1';
    const pa = this.params.get('aerial');
    if (pa === '0' || pa === '1') this.settings.aerialPhoto = pa === '1';

    const glCanvas = root.querySelector<HTMLCanvasElement>('#gl')!;
    const hudCanvas = root.querySelector<HTMLCanvasElement>('#hud')!;
    const controlsRoot = root.querySelector<HTMLElement>('#controls')!;
    const uiRoot = root.querySelector<HTMLElement>('#ui')!;

    // Probe quality with a throwaway context so we can pick antialias before creating the renderer.
    const probe = document.createElement('canvas').getContext('webgl2');
    this.quality = resolveQuality(this.settings, probe);
    (probe?.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null)?.loseContext?.();

    this.renderer = new WebGLRenderer({
      canvas: glCanvas,
      antialias: this.quality.antialias,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.info.autoReset = false; // count world + cockpit passes together

    this.safeProbe = document.createElement('div');
    this.safeProbe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(this.safeProbe);

    this.hud = createHud(hudCanvas, this.events);
    this.audio = createAudio(this.events);
    this.input = createInput(controlsRoot, this.settings);
    this.ui = createUi(uiRoot, { uiClick: () => this.audio.uiClick(), build: GAME_BUILD });
    this.progress = loadProgress();
    this.applySettings();

    this.bindCommands();
    this.bindEvents();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.session && !this.paused) this.openPauseMenu();
    });
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());

    if (TEST_HOOKS) (window as unknown as { __f35: unknown }).__f35 = this.debugApi();
    this.tagSettings();
  }

  /** Session tags describing how this player has the game set up (Clarity filters). */
  private tagSettings(): void {
    analyticsTag('difficulty', this.settings.difficulty);
    analyticsTag('quality', this.quality.level);
    analyticsTag('quality_setting', this.settings.quality);
    analyticsTag('control_scheme', this.settings.controlScheme);
  }

  /* ─────────────────────────── App flow ─────────────────────────── */

  async start(): Promise<void> {
    const autostart = TEST_HOOKS && this.params.get('autostart') === '1';
    if (!autostart) {
      // (a fly() over the splash skips the gesture: the main menu loop flies its mission)
      if (await this.flow.run(() => this.flow.ask(this.ui.showSplash()))) await this.onUserGesture();
    }
    void this.audio.load();
    const missionId = TEST_HOOKS ? this.params.get('mission') : null;
    if (missionId && !this.pendingFly) {
      const def = missionById(missionId) ?? CAMPAIGN[0];
      const loadout = (this.params.get('loadout') as LoadoutId | null) ?? def.recommendedLoadout;
      await this.flow.run(() => (autostart ? this.missionFlow(def, loadout) : this.missionFlow(def)));
    }
    await this.mainMenu();
  }

  private async onUserGesture(): Promise<void> {
    await this.audio.unlock();
    if (this.settings.controlScheme === 'tilt') await this.input.requestMotionPermission();
    const isTouch = matchMedia('(pointer: coarse)').matches;
    if (isTouch) {
      try {
        await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' } as FullscreenOptions);
        await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
      } catch {
        /* iOS Safari: no element fullscreen / orientation lock — the PWA manifest handles it */
      }
    }
  }

  private async mainMenu(): Promise<never> {
    for (;;) {
      // a fly() that took over the flow (from any screen or mission) ends up here: fly its mission,
      // and when that one is over the main menu comes back like after any other flight
      await this.flow.run(() => this.mainMenuStep());
    }
  }

  private async mainMenuStep(): Promise<void> {
    const fly = this.pendingFly;
    if (fly) {
      this.pendingFly = null;
      await this.missionFlow(fly.def, fly.loadout);
      return;
    }
    this.pauseWhenReady = false;
    const choice = await this.flow.ask(this.ui.showMainMenu());
    track(`menu_${choice}`);
    // Menus may change saved progress themselves (e.g. skipping a mission), so re-read it.
    this.progress = loadProgress();
    if (choice === 'campaign') {
      await this.campaignMenu();
    } else if (choice === 'training') {
      await this.pickAndFly(() => this.ui.showTraining(TRAINING, this.progress));
    } else if (choice === 'instant') {
      await this.pickAndFly(async () => {
        const opts = await this.ui.showInstantAction();
        return opts ? buildInstantMission(opts) : null;
      });
    } else if (choice === 'settings') {
      await this.editSettings();
    } else if (choice === 'credits') {
      await this.flow.ask(this.ui.showCredits());
    }
  }

  /** Campaign picker → that campaign's mission list; Back on the list returns to the picker. */
  private async campaignMenu(): Promise<void> {
    for (;;) {
      const campaign = await this.flow.ask(this.ui.showCampaigns(CAMPAIGNS, this.progress));
      if (!campaign) return;
      if ((await this.pickAndFly(() => this.ui.showCampaign(campaign, this.progress))) === 'menu') return;
      this.progress = loadProgress();
    }
  }

  /**
   * Mission list / Instant Action setup → missionFlow; Back on the briefing returns to that screen.
   * Resolves 'back' when the player backs out of that screen, 'menu' when a mission flow ended.
   */
  private async pickAndFly(pick: () => Promise<MissionDef | null>): Promise<'back' | 'menu'> {
    for (;;) {
      const def = await this.flow.ask(pick());
      if (!def) return 'back';
      if ((await this.missionFlow(def)) !== 'back') return 'menu';
      this.progress = loadProgress();
    }
  }

  /**
   * Briefing → fly → debrief loop. Resolves 'back' when the player backs out of a briefing (the
   * caller shows the screen they came from), 'menu' when they leave from the debrief or pause menu.
   */
  private async missionFlow(first: MissionDef, presetLoadout?: LoadoutId): Promise<'back' | 'menu'> {
    let def: MissionDef | null = first;
    let loadout = presetLoadout ?? null;
    while (def) {
      if (!loadout) {
        const brief = await this.flow.ask(this.ui.showBriefing(def, this.settings));
        if (!brief) return 'back';
        loadout = brief.loadout;
      }
      const outcome = await this.playMission(def, loadout);
      if (outcome === 'retry') continue;
      if (outcome === 'next') {
        def = nextMissionAfter(def.id);
        loadout = null;
        continue;
      }
      return 'menu';
    }
    return 'menu';
  }

  private async playMission(def: MissionDef, loadout: LoadoutId): Promise<MissionOutcome> {
    for (;;) {
      const end = await this.runSession(def, loadout);
      if (end === 'restart') {
        track('mission_restart');
        continue;
      }
      if (end === 'quit') {
        track('mission_quit');
        this.teardownSession();
        return 'menu';
      }
      const result = this.finishSession();
      if (!result) return 'menu';
      this.trackResult(result);
      // campaign → next mission, training → next lesson (T03 → the first campaign mission)
      const next = result.success ? nextMissionLabel(def.id) : null;
      const choice = await this.flow.ask(this.ui.showDebrief(result, next));
      return choice;
    }
  }

  private trackResult(result: MissionResult): void {
    track(result.success ? 'mission_success' : 'mission_failed');
    analyticsTag('mission_result', `${result.missionId}:${result.success ? 'success' : 'failed'}`);
    analyticsTag('mission_grade', `${result.missionId}:${result.grade}`);
    if (result.campaignComplete) {
      track('campaign_complete');
      upgrade('campaign_complete');
    }
  }

  /** Builds the world for a mission and resolves when it ends (or the player restarts/quits). */
  private async runSession(def: MissionDef, loadout: LoadoutId): Promise<'ended' | 'restart' | 'quit'> {
    this.teardownSession();
    this.missionLoading = true;
    // test hooks (autopilot, controls override) belong to one mission: never leak into the next
    this.autopilot = false;
    this.controlOverride = null;
    // training always flies at Pilot, whatever the setting (missionDifficulty)
    const difficultyId = missionDifficulty(def, this.settings.difficulty);
    const difficulty = DIFFICULTIES[difficultyId];
    this.ui.hideAll();
    this.ui.showLoading(0, 'Preparing mission');
    await nextFrame();

    const scene = new Scene();
    const pads = terrainPadsFor(def);
    // (the Sky Tower is never destroyed for good: every start and restart builds it intact)
    const env = await createEnvironment(scene, this.renderer, {
      theater: def.theater,
      timeOfDay: def.timeOfDay,
      weather: def.weather,
      seed: def.seed,
      features: def.features,
      pads,
      quality: this.quality,
      onProgress: (f, label) => this.ui.showLoading(0.05 + f * 0.75, label),
    });
    this.ui.showLoading(0.82, 'Spawning forces');
    await nextFrame();

    // test hooks: `?seed=` makes the run reproducible: a fixed combat seed, and the sim clock held at
    // t = 0 for the driver's simulate() (the real-time loop would otherwise run a frame-rate-dependent
    // 0.2–0.4 s first)
    const seed = testSeed(this.params, TEST_HOOKS);
    this.simHeld = seed !== null;
    const combat = seed !== null ? createCombatSystemSeeded(seed) : createCombatSystem();
    const world = createSimWorld({ terrain: env.terrain, difficulty, events: this.events, combat });
    const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty, events: this.events });
    runner.setup(world, loadout);

    this.ui.showLoading(0.9, 'Arming weapons');
    await nextFrame();
    const entities = createEntityRenderer(scene, world, env, this.quality);
    const effects = createEffects(scene, world, this.events, env, this.quality);
    const rig = createCameraRig(world, entities, this.settings);
    scene.add(rig.camera);
    const cockpit = createCockpit(this.events, this.quality);

    const initialView = (this.params.get('view') as CameraMode | null) ?? this.settings.defaultView;
    rig.setMode(initialView);

    const endPromise = new Promise<'ended' | 'restart' | 'quit'>((resolve) => {
      this.session = {
        def,
        loadout,
        scene,
        env,
        world,
        runner,
        entities,
        effects,
        rig,
        cockpit,
        targetCam: new TargetCam(world, entities),
        endTimer: -1,
        lastViewMode: null,
        unsubscribers: [],
        resolve,
      };
    });
    this.paused = true; // hold the sim until the mission is fully ready
    this.applyViewMode(rig.mode);
    this.resize();
    // Compile every material now instead of hitching mid-flight on first sight.
    this.ui.showLoading(0.96, 'Compiling shaders');
    try {
      entities.update(this.frameContext(0, this.session));
      env.update(this.frameContext(0, this.session));
      await this.renderer.compileAsync(scene, rig.camera);
    } catch {
      /* compileAsync unsupported — fall back to lazy compilation */
    }
    this.input.setThrottle(0.68);
    this.input.setEnabled(true);
    this.hud.setVisible(true);
    this.paused = false;
    this.accumulator = 0;
    this.lastFrame = performance.now();
    this.ui.showLoading(1, 'Ready');
    this.ui.hideLoading();
    track('mission_start');
    track(`mission_start_${def.kind}`);
    analyticsTag('mission', def.id);
    analyticsTag('mission_kind', def.kind);
    analyticsTag('loadout', loadout);
    analyticsTag('difficulty', difficultyId);
    void this.requestWakeLock();
    this.audio.setPaused(false);
    this.missionLoading = false;
    // test hooks: a fly() during the load replaces this mission; a pause() during it opens the menu now
    if (this.pendingFly) this.session?.resolve('quit');
    else if (this.pauseWhenReady) {
      this.pauseWhenReady = false;
      this.openPauseMenu();
    }
    return endPromise;
  }

  /** Collects the result, updates progress and destroys the session. */
  private finishSession(): MissionResult | null {
    const s = this.session;
    if (!s) return null;
    const result = s.runner.result(s.world);
    this.progress = recordResult(this.progress, result);
    saveProgress(this.progress);
    this.teardownSession();
    return result;
  }

  private teardownSession(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.input.setEnabled(false);
    this.hud.setVisible(false);
    this.hud.update(this.frameContext(0, null));
    this.audio.stopAll();
    s.unsubscribers.forEach((u) => u());
    s.runner.dispose?.();
    s.cockpit.dispose();
    s.rig.dispose();
    s.effects.dispose();
    s.entities.dispose();
    s.world.dispose();
    s.env.dispose();
    s.scene.clear();
    this.renderer.renderLists.dispose();
    void this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
  }

  private async editSettings(): Promise<void> {
    this.settings = await this.flow.ask(this.ui.showSettings({ ...this.settings }));
    saveSettings(this.settings);
    this.applySettings();
  }

  private applySettings(): void {
    const s = this.settings;
    this.audio.setVolumes(s.masterVolume, s.sfxVolume, s.voiceVolume);
    this.audio.setMusicVolume?.(s.musicVolume ?? 0.6);
    this.input.applySettings(s);
    const q = resolveQuality(s, this.renderer?.getContext());
    // Antialias can't change without recreating the context; keep the rest live.
    this.quality = { ...q, antialias: this.quality?.antialias ?? q.antialias };
    this.dynScale = 1;
    if (this.session) this.session.rig.camera.fov = s.fov;
    this.ensureFpsCounter();
    this.resize();
  }

  /* ─────────────────────────── Commands & events ─────────────────────────── */

  private bindCommands(): void {
    const i = this.input;
    i.on('pause', () => {
      if (this.session && !this.pauseMenuOpen) this.openPauseMenu();
    });
    i.on('camera', () => {
      const s = this.session;
      if (!s || this.paused) return;
      this.applyViewMode(s.rig.nextMode());
    });
    i.on('padlock', () => {
      const s = this.session;
      if (!s || this.paused) return;
      s.rig.setMode(s.rig.mode === 'target' ? this.settings.defaultView : 'target');
      this.applyViewMode(s.rig.mode);
    });
    i.on('missileCam', () => {
      const s = this.session;
      if (!s || this.paused) return;
      s.rig.setMode(s.rig.mode === 'missile' ? this.settings.defaultView : 'missile');
      this.applyViewMode(s.rig.mode);
    });
    i.on('lookReset', () => this.session?.rig.resetLook());
    i.on('recenterTilt', () => this.input.recenterTilt());
    i.on('cycleWeapon', () => {
      const s = this.session;
      if (s?.world.player?.alive && !this.paused) s.world.combat.cycleWeapon(s.world.player, s.world);
    });
    i.on('cycleTarget', () => {
      const s = this.session;
      if (s?.world.player?.alive && !this.paused) s.world.combat.cycleTarget(s.world.player, s.world);
    });
    i.on('radar', () => {
      const s = this.session;
      const p = s?.world.player;
      if (s && p?.alive && !this.paused) {
        s.world.combat.setRadarEmitting(p, !p.radar.emitting, s.world);
        this.events.emit('hud:message', { text: p.radar.emitting ? 'RADAR ON' : 'EMCON — RADAR SILENT', duration: 1.5, tone: 'info' });
      }
    });
  }

  private bindEvents(): void {
    const e = this.events;
    const buzz = (ms: number | number[]) => {
      if (this.settings.haptics && 'vibrate' in navigator) navigator.vibrate(ms);
    };
    const isPlayer = (id: number | null | undefined) => id != null && id === this.session?.world.player?.id;

    e.on('player:hit', ({ amount }) => {
      this.session?.rig.shake(Math.min(1, 0.3 + amount / 60));
      buzz([60, 30, 90]);
    });
    e.on('player:down', ({ reason }) => {
      track(`player_down_${reason}`);
      this.session?.rig.shake(1);
      buzz(300);
    });
    e.on('munition:launch', ({ shooter }) => {
      if (isPlayer(shooter.id)) {
        this.session?.rig.shake(0.12);
        buzz(25);
      }
    });
    e.on('destroyed', ({ attackerId }) => {
      if (isPlayer(attackerId)) buzz([30, 40, 30]);
    });
    e.on('explosion', ({ position, size }) => {
      const s = this.session;
      if (!s) return;
      const d = s.rig.camera.position.distanceTo(position);
      const mag = { tiny: 0.05, small: 0.15, medium: 0.35, large: 0.6, huge: 1 }[size];
      const k = mag * Math.max(0, 1 - d / (400 + mag * 1500));
      if (k > 0.02) s.rig.shake(k);
    });
    e.on('gun:state', ({ shooterId, firing }) => {
      if (firing && isPlayer(shooterId)) buzz(15);
    });
    // the Sky Tower (it is never saved: the next sortie stands it up again)
    e.on('landmark:damaged', ({ landmark }) => {
      if (this.session?.world.landmarks.includes(landmark)) buzz([60, 40, 60]);
    });
    e.on('landmark:destroyed', ({ landmark }) => {
      if (this.session?.world.landmarks.includes(landmark)) buzz([80, 40, 200]);
    });
  }

  private openPauseMenu(): void {
    const s = this.session;
    if (!s || this.pauseMenuOpen) return;
    this.pauseMenuOpen = true;
    this.paused = true;
    this.input.setEnabled(false);
    this.audio.setPaused(true);
    const loop = async (): Promise<void> => {
      for (;;) {
        const choice = await this.flow.ask(this.ui.showPause(s.runner));
        if (choice === 'settings') {
          await this.editSettings();
          continue;
        }
        this.pauseMenuOpen = false;
        if (choice === 'resume') {
          this.paused = false;
          this.input.setEnabled(true);
          this.audio.setPaused(false);
          this.lastFrame = performance.now();
        } else {
          s.resolve(choice === 'restart' ? 'restart' : 'quit');
        }
        return;
      }
    };
    // a fly() that takes over closes the menu itself (see flyFromHook) and ends this loop
    void this.flow.run(loop);
  }

  private applyViewMode(mode: CameraMode): void {
    const s = this.session;
    if (!s) return;
    s.lastViewMode = mode;
    const inside = mode === 'cockpit' || mode === 'hud';
    s.entities.setPlayerVisible(!inside);
    s.cockpit.visible = mode === 'cockpit';
    this.hud.setVisible(mode !== 'tactical');
  }

  /* ─────────────────────────── Main loop ─────────────────────────── */

  private frame(): void {
    const now = performance.now();
    const rawDt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    const dt = Math.min(0.1, Math.max(0, rawDt));
    this.trackPerformance(rawDt);

    const s = this.session;
    if (!s) {
      this.input.update(dt, this.frameContext(dt, null));
      this.followControlScheme();
      return;
    }

    const ctx = this.frameContext(dt, s);
    this.input.update(dt, ctx);
    this.followControlScheme();

    if (!this.paused) {
      // Player controls → sim (not while the clock is held: simulate() feeds them per step, and the
      // frames before it must not leave a frame-count-dependent input on the jet)
      const p = s.world.player;
      if (p?.alive && !this.autopilot && !this.simHeld) {
        Object.assign(p.input, this.input.controls);
        if (this.controlOverride) Object.assign(p.input, this.controlOverride);
      }

      // Look-around & taps
      const look = this.input.consumeLook();
      if (look.yaw || look.pitch) s.rig.look(look.yaw, look.pitch);
      for (const tap of this.input.consumeTaps()) this.handleTap(tap.x, tap.y, s);

      // Fixed-step simulation (test hooks: a held clock only moves with simulate())
      this.accumulator = this.simHeld ? 0 : this.accumulator + dt;
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        s.world.step(FIXED_DT);
        s.runner.update(s.world, FIXED_DT);
        this.accumulator -= FIXED_DT;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0; // slow device: drop time instead of spiralling

      // Mission end handling
      if (s.runner.state !== 'running') {
        if (s.endTimer < 0) {
          const collapse = s.world.landmarks.some((l) => !l.alive);
          s.endTimer = s.runner.state === 'success' ? END_DELAY_SUCCESS : collapse ? END_DELAY_COLLAPSE : END_DELAY_FAILED;
        }
        s.endTimer -= dt;
        if (s.endTimer <= 0) {
          s.resolve('ended');
          this.paused = true; // freeze until the debrief takes over
        }
      }
    } else {
      this.input.consumeTaps();
      this.input.consumeLook();
    }

    // Presentation
    const fctx = this.frameContext(dt, s);
    s.env.update(fctx);
    s.entities.update(fctx);
    s.rig.update(fctx);
    // The rig can change mode on its own (death cam, missile cam hand-back) — keep cockpit/HUD in sync.
    if (s.rig.mode !== s.lastViewMode) this.applyViewMode(s.rig.mode);
    s.effects.update(fctx);
    const ctx2 = this.frameContext(dt, s); // camera may have moved/changed mode
    s.cockpit.update(ctx2, s.rig.headLocal);
    this.renderer.info.reset();
    this.renderer.render(s.scene, s.rig.camera);
    if (s.cockpit.visible) s.cockpit.render(this.renderer);
    // target camera window (rect + target from the HUD's last frame; the HUD draws its chrome next)
    // (low quality: a short far plane and no scenery detail, so the PiP doesn't draw the whole scene again)
    const q = this.quality;
    s.targetCam.render(this.renderer, s.scene, pipView, s.rig.camera.far, q.targetCamRange, targetCamOmitFor(q, s.env.targetCamOmit));
    this.hud.update(ctx2);
    this.audio.update(ctx2);
  }

  /** Tilt chosen but no orientation data: Input flies the stick, so say so and re-word the hints. */
  private followControlScheme(): void {
    const toast = followActiveScheme(this.settings.controlScheme, this.input.activeScheme);
    if (toast) this.ui.toast(toast);
  }

  private handleTap(x: number, y: number, s: Session): void {
    const p = s.world.player;
    if (!p?.alive) return;
    if (s.cockpit.visible && s.cockpit.handleTap(x / this.screen.width, y / this.screen.height)) return;
    const id = this.hud.pick(x, y);
    if (id != null) s.world.combat.designate(p, id, s.world);
  }

  private frameContext(dt: number, s: Session | null): FrameContext {
    const g = this;
    return {
      dt,
      time: s?.world.time ?? 0,
      world: s?.world as SimWorld,
      player: s?.world.player ?? null,
      camera: s?.rig.camera as FrameContext['camera'],
      viewMode: s?.rig.mode ?? 'cockpit',
      focusId: s?.rig.focusId ?? null,
      mission: s?.runner ?? null,
      settings: g.settings,
      quality: g.quality,
      paused: g.paused,
      screen: g.screen,
    };
  }

  /* ─────────────────────────── Screen & performance ─────────────────────────── */

  private resize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const cs = getComputedStyle(this.safeProbe);
    this.screen = {
      width: w,
      height: h,
      dpr: Math.min(window.devicePixelRatio || 1, 2),
      safe: {
        top: parseFloat(cs.paddingTop) || 0,
        right: parseFloat(cs.paddingRight) || 0,
        bottom: parseFloat(cs.paddingBottom) || 0,
        left: parseFloat(cs.paddingLeft) || 0,
      },
    };
    this.renderer.setPixelRatio(Math.max(0.5, this.quality.pixelRatio * this.dynScale));
    this.renderer.setSize(w, h, true);
    this.hud.resize(w, h, this.screen.dpr);
    if (this.session) {
      this.session.rig.resize(w, h);
      this.session.cockpit.resize(w, h);
    }
    const touch = matchMedia('(pointer: coarse)').matches;
    const portrait = touch && h > w;
    this.ui.setRotateHint(portrait);
    // Rotating to portrait mid-mission (or a phone call UI) must not leave the jet flying blind.
    if (portrait && this.session && !this.paused) this.openPauseMenu();
  }

  /** Dynamic resolution: drop pixel ratio when the frame time is consistently high. */
  private trackPerformance(rawDt: number): void {
    if (this.fpsEl) {
      this.fpsAccum.frames++;
      this.fpsAccum.time += rawDt;
      if (this.fpsAccum.time >= 0.5) {
        const fps = this.fpsAccum.frames / this.fpsAccum.time;
        const info = this.renderer.info.render;
        this.fpsEl.textContent = `${fps.toFixed(0)} fps · ${(this.quality.pixelRatio * this.dynScale).toFixed(2)}x · ${info.calls} dc · ${(info.triangles / 1000).toFixed(0)}k tri`;
        this.fpsAccum = { frames: 0, time: 0 };
      }
    }
    if (!this.session || this.paused || rawDt > 0.25) return;
    this.frameTimes.push(rawDt);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    this.dynTimer += rawDt;
    if (this.dynTimer < 2 || this.frameTimes.length < 60) return;
    this.dynTimer = 0;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    const old = this.dynScale;
    if (avg > 1 / 40) this.dynScale = Math.max(0.55, this.dynScale - 0.12);
    else if (avg < 1 / 58 && this.dynScale < 1) this.dynScale = Math.min(1, this.dynScale + 0.06);
    if (old !== this.dynScale) this.resize();
  }

  private ensureFpsCounter(): void {
    if (this.settings.showFps && !this.fpsEl) {
      this.fpsEl = document.createElement('div');
      this.fpsEl.className = 'fps-counter';
      this.fpsEl.style.cssText =
        'position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top) + 2px);font:11px monospace;color:#9f9;background:rgba(0,0,0,.4);padding:1px 6px;border-radius:3px;z-index:50;pointer-events:none';
      document.body.appendChild(this.fpsEl);
    } else if (!this.settings.showFps && this.fpsEl) {
      this.fpsEl.remove();
      this.fpsEl = null;
    }
  }

  private async requestWakeLock(): Promise<void> {
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wl) this.wakeLock = await wl.request('screen');
    } catch {
      /* not supported / denied */
    }
  }

  /* ─────────────────────────── Test hooks ─────────────────────────── */

  /**
   * fly(): take over from whatever is up (a menu, briefing, debrief, the pause menu or a mission) and
   * fly `def` from the main menu loop, so the app flow stays one loop: no screen is left waiting for an
   * answer and quitting the new mission returns to the main menu (#71).
   */
  private flyFromHook(def: MissionDef, loadout: LoadoutId): void {
    this.pendingFly = { def, loadout };
    this.ui.hideAll();
    this.pauseMenuOpen = false;
    this.flow.abort(); // rejects the screen the flow (or the pause menu's loop) waits on
    this.session?.resolve('quit'); // a running mission ends like a quit (no result recorded)
  }

  private debugApi() {
    return {
      game: this,
      state: () => {
        const s = this.session;
        const p = s?.world.player;
        return {
          inMission: !!s,
          paused: this.paused,
          mission: s?.def.id ?? null,
          /** The difficulty the running mission flies at (a lesson: Pilot whatever the setting). */
          difficulty: s?.world.difficulty.id ?? null,
          missionState: s?.runner.state ?? null,
          time: s?.world.time ?? 0,
          view: s?.rig.mode ?? null,
          player: p
            ? {
                alive: p.alive,
                health: p.health,
                pos: p.position.toArray(),
                ias: p.flight.ias,
                alt: p.flight.altitude,
                weapon: p.selectedWeapon,
                locked: p.radar.lockedId,
                designated: p.radar.designatedId,
                warnings: [...p.warnings],
              }
            : null,
          counts: s
            ? {
                aircraft: s.world.aircraft.filter((a) => a.alive).length,
                missiles: s.world.missiles.filter((m) => m.alive).length,
                sams: s.world.sams.filter((m) => m.alive).length,
                ground: s.world.ground.filter((m) => m.alive).length,
              }
            : null,
          skyTower: s ? (s.world.landmarks.find((l) => l.id === 'skytower')?.alive ?? null) : null,
          /** Enemy hits on the Sky Tower (0 intact, 1 damaged; null = no tower this sortie). */
          skyTowerHits: s ? (s.world.landmarks.find((l) => l.id === 'skytower')?.hits ?? null) : null,
          objectives: s?.runner.objectives ?? [],
          // the last rendered frame (world + cockpit + PiP); `pip`: whether the target camera window was
          // open and drawn in it, and what its pass cost (a read with the PiP open isn't comparable to one
          // without: it adds 20–55 calls at full range)
          renderer: {
            calls: this.renderer.info.render.calls,
            triangles: this.renderer.info.render.triangles,
            pip: {
              open: pipView.open,
              drawn: s?.targetCam.lastTargetId != null,
              calls: s?.targetCam.lastStats.calls ?? 0,
              triangles: s?.targetCam.lastStats.triangles ?? 0,
            },
          },
          held: this.simHeld,
        };
      },
      /** Programmatically start a mission (tests), from any screen or mission; quitting it returns to the main menu. */
      fly: (id: string, loadout?: LoadoutId) => {
        const def = missionById(id);
        if (!def) throw new Error(`no mission ${id}`);
        this.flyFromHook(def, loadout ?? def.recommendedLoadout);
      },
      setView: (mode: CameraMode) => {
        this.session?.rig.setMode(mode);
        if (this.session) this.applyViewMode(this.session.rig.mode);
      },
      command: (cmd: 'cycleWeapon' | 'cycleTarget' | 'radar') => {
        const s = this.session;
        const p = s?.world.player;
        if (!s || !p) return;
        if (cmd === 'cycleWeapon') s.world.combat.cycleWeapon(p, s.world);
        if (cmd === 'cycleTarget') s.world.combat.cycleTarget(p, s.world);
        if (cmd === 'radar') s.world.combat.setRadarEmitting(p, !p.radar.emitting, s.world);
      },
      /** Open the pause menu; right after a fly() (or during a load) it opens once that mission is ready. */
      pause: () => {
        if (this.pendingFly || this.missionLoading) this.pauseWhenReady = true;
        else this.openPauseMenu();
      },
      /** Let an AI fighter brain fly the player's jet (for automated playtests). */
      autopilot: (on: boolean, role: 'fighter' | 'wingman' | 'interceptor' = 'fighter') => {
        const p = this.session?.world.player;
        this.autopilot = on;
        if (p) p.ai = on ? createAiBrain(role, { skill: 0.9 }) : null;
      },
      /**
       * Fast-forward the simulation by `seconds` without rendering (fixed 60 Hz steps, player
       * controls from autopilot/override/current input). For automated playtests on slow GPUs.
       */
      simulate: (seconds: number) => {
        const s = this.session;
        if (!s) return null;
        const steps = Math.round(seconds / FIXED_DT);
        for (let i = 0; i < steps && s.runner.state === 'running'; i++) {
          const p = s.world.player;
          if (p?.alive && !this.autopilot) {
            Object.assign(p.input, this.input.controls);
            if (this.controlOverride) Object.assign(p.input, this.controlOverride);
          }
          s.world.step(FIXED_DT);
          s.runner.update(s.world, FIXED_DT);
        }
        return (window as unknown as { __f35: { state: () => unknown } }).__f35.state();
      },
      /** Hold the sim clock (only simulate() advances it; `?seed=` starts every mission held) or let it run in real time. Per mission. */
      hold: (on = true) => {
        this.simHeld = on;
        this.accumulator = 0;
        this.lastFrame = performance.now();
        return on;
      },
      /** Override (merge) player controls, e.g. {pitch: 1, throttle: 1}; null clears. */
      controls: (c: Partial<ControlInput> | null) => {
        this.controlOverride = c;
      },
      /** Weapons can't hurt the player's jet (crashing still kills): keeps a scripted run alive until a later moment. Per mission. */
      invulnerable: (on = true) => {
        const w = this.session?.world as (SimWorld & { realApplyDamage?: SimWorld['applyDamage'] }) | undefined;
        if (!w) return false;
        const real = (w.realApplyDamage ??= w.applyDamage.bind(w));
        w.applyDamage = on ? (target, ...rest) => void (target !== w.player && real(target, ...rest)) : real;
        return true;
      },
      /** Destroy an entity (id) or every live member of a mission group (id string), credited to the player or to nobody (a two-hit tanker takes both hits). */
      destroy: (target: number | string, byPlayer = false) => {
        const w = this.session?.world;
        if (!w) return 0;
        const hit = [...w.aircraft, ...w.sams, ...w.ground].filter((e) => e.alive && (typeof target === 'number' ? e.id === target : e.groupId === target));
        for (const e of hit) forceDestroy(w, e, byPlayer ? (w.player?.id ?? null) : null);
        return hit.length;
      },
      /** Pin the camera at `pos` looking at `look` (scenery checks without a driver); null hands it back to the rig. */
      camera: (pos: [number, number, number] | null, look: [number, number, number] = [0, 0, 0]) => {
        const rig = this.session?.rig as (CameraRigApi & { rigUpdate?: CameraRigApi['update'] }) | undefined;
        if (!rig) return false;
        const update = (rig.rigUpdate ??= rig.update);
        rig.update = pos
          ? () => {
              rig.camera.position.set(pos[0], pos[1], pos[2]);
              rig.camera.up.set(0, 1, 0); // level: the rig may have left a banked up vector
              rig.camera.lookAt(look[0], look[1], look[2]);
              rig.camera.updateMatrixWorld();
            }
          : update;
        return true;
      },
      /** Skip the end-of-mission outro: the debrief opens on the next rendered frame (the outro counts render time, not simulate()). */
      skipOutro: () => {
        const s = this.session;
        if (!s || s.runner.state === 'running') return false;
        s.endTimer = 0.01;
        return true;
      },
      /** Knock the Sky Tower down as if the player's JDAM hit it at height `y` (m above its base, from the east). */
      destroySkyTower: (y = 120) => {
        const s = this.session;
        const lm = s?.world.landmarks.find((l) => l.id === 'skytower');
        const p = s?.world.player;
        if (!s || !lm || !p) return false;
        destroyLandmark(lm, this.events, s.world.time, new Vector3(lm.base.x + 12, lm.base.y + y, lm.base.z), p.id, 'gbu31', p.position);
        return true;
      },
      /** An enemy hit on the Sky Tower at height `y` (m above its base, from the east): the first damages it, the second collapses it. Returns the hit count (0 = no tower standing). */
      hitSkyTower: (y = 150) => {
        const s = this.session;
        const lm = s?.world.landmarks.find((l) => l.id === 'skytower');
        if (!s || !lm) return 0;
        return hitSkyTower(s.world, { point: new Vector3(lm.base.x + 30, lm.base.y + y, lm.base.z) });
      },
      /** Target camera (PiP) state: window rect, target shown, last rendered target. */
      targetCam: () => ({
        open: pipView.open,
        anim: pipView.anim,
        targetId: pipView.targetId,
        rect: [pipView.vx, pipView.vy, pipView.vw, pipView.vh],
        rendered: this.session?.targetCam.lastTargetId ?? null,
        camera: this.session?.targetCam.camera.position.toArray().map((v) => Math.round(v)) ?? null,
      }),
      // + the Instant Action scenario built on a fixed site (Wiri defence) so the e2e sweep covers it
      missions: () => [...CAMPAIGNS.flatMap((c) => c.missions), ...TRAINING, missionById('ia_defend_auckland')!].map((m) => ({ id: m.id, title: m.title, kind: m.kind })),
      vec: (x: number, y: number, z: number) => new Vector3(x, y, z),
    };
  }
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
