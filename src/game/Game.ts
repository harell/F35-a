/**
 * F35-A — application / integration layer.
 * OWNERSHIP: orchestrator. Wires every module together through the contracts in
 * core/contracts.ts and sim/api.ts, runs the app state machine and the main loop.
 *
 * URL parameters (handy for testing on a phone or from Playwright):
 *   ?mission=<id>&loadout=<id>&autostart=1   skip menus and fly a mission immediately
 *   ?difficulty=recruit|pilot|veteran|ace    override difficulty
 *   ?quality=low|medium|high                 override quality
 *   ?view=cockpit|hud|chase|orbit|...        initial camera
 *   ?fps=1                                   FPS counter
 */
import { ACESFilmicToneMapping, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import { EventBus } from '../core/events';
import { DIFFICULTIES, GAME_VERSION, QUALITY_PRESETS } from '../core/data';
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
import type { CameraMode, LoadoutId, QualityLevel, QualitySettings, Settings } from '../core/types';
import type { SimWorld } from '../sim/api';
import { createSimWorld } from '../sim/World';
import { createCombatSystem } from '../sim/weapons/CombatSystem';
import { createAiBrain } from '../ai';
import { createEnvironment } from '../world/Environment';
import { createEntityRenderer } from '../render/EntityRenderer';
import { createEffects } from '../render/effects/Effects';
import { createCameraRig } from '../render/CameraRig';
import { createHud } from '../hud/Hud';
import { createCockpit } from '../hud/Cockpit';
import { createAudio } from '../audio/AudioSystem';
import { createInput } from '../input/Input';
import { createUi } from '../ui/Ui';
import {
  CAMPAIGN,
  TRAINING,
  buildInstantMission,
  createMissionRunner,
  loadProgress,
  nextMissionAfter,
  recordResult,
  saveProgress,
  terrainPadsFor,
} from '../missions';

const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;
/** Seconds the mission keeps running after success/failure before the debrief. */
const END_DELAY_SUCCESS = 6;
const END_DELAY_FAILED = 5;

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
  endTimer: number;
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
  private lastFrame = performance.now();
  private accumulator = 0;
  private frameTimes: number[] = [];
  private dynScale = 1;
  private dynTimer = 0;
  private fpsEl: HTMLDivElement | null = null;
  private fpsAccum = { frames: 0, time: 0 };
  private wakeLock: { release(): Promise<void> } | null = null;
  private readonly params = new URLSearchParams(location.search);
  private screen = { width: 1, height: 1, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } };
  private safeProbe: HTMLDivElement;

  constructor(private readonly root: HTMLElement) {
    this.settings = loadSettings();
    const pd = this.params.get('difficulty');
    if (pd && pd in DIFFICULTIES) this.settings.difficulty = pd as Settings['difficulty'];
    const pq = this.params.get('quality');
    if (pq && pq in QUALITY_PRESETS) this.settings.quality = pq as QualityLevel;
    if (this.params.get('fps') === '1') this.settings.showFps = true;

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

    this.safeProbe = document.createElement('div');
    this.safeProbe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(this.safeProbe);

    this.hud = createHud(hudCanvas, this.events);
    this.audio = createAudio(this.events);
    this.input = createInput(controlsRoot, this.settings);
    this.ui = createUi(uiRoot, { uiClick: () => this.audio.uiClick(), version: GAME_VERSION });
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

    (window as unknown as { __f35: unknown }).__f35 = this.debugApi();
  }

  /* ─────────────────────────── App flow ─────────────────────────── */

  async start(): Promise<void> {
    const autostart = this.params.get('autostart') === '1';
    if (!autostart) {
      await this.ui.showSplash();
      await this.onUserGesture();
    }
    void this.audio.load();
    const missionId = this.params.get('mission');
    if (missionId) {
      const def = [...CAMPAIGN, ...TRAINING].find((m) => m.id === missionId) ?? CAMPAIGN[0];
      const loadout = (this.params.get('loadout') as LoadoutId | null) ?? def.recommendedLoadout;
      if (autostart) await this.missionFlow(def, loadout);
      else await this.missionFlow(def);
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
      const choice = await this.ui.showMainMenu();
      if (choice === 'campaign') {
        const def = await this.ui.showCampaign(CAMPAIGN, this.progress);
        if (def) await this.missionFlow(def);
      } else if (choice === 'training') {
        const def = await this.ui.showTraining(TRAINING, this.progress);
        if (def) await this.missionFlow(def);
      } else if (choice === 'instant') {
        const opts = await this.ui.showInstantAction();
        if (opts) await this.missionFlow(buildInstantMission(opts));
      } else if (choice === 'settings') {
        await this.editSettings();
      } else if (choice === 'credits') {
        await this.ui.showCredits();
      }
    }
  }

  /** Briefing → fly → debrief loop. Returns to the caller (menu) when the player leaves. */
  private async missionFlow(first: MissionDef, presetLoadout?: LoadoutId): Promise<void> {
    let def: MissionDef | null = first;
    let loadout = presetLoadout ?? null;
    while (def) {
      if (!loadout) {
        const brief = await this.ui.showBriefing(def, this.settings);
        if (!brief) return;
        loadout = brief.loadout;
      }
      const outcome = await this.playMission(def, loadout);
      if (outcome === 'retry') continue;
      if (outcome === 'next') {
        def = nextMissionAfter(def.id);
        loadout = null;
        continue;
      }
      return;
    }
  }

  private async playMission(def: MissionDef, loadout: LoadoutId): Promise<MissionOutcome> {
    for (;;) {
      const end = await this.runSession(def, loadout);
      if (end === 'restart') continue;
      if (end === 'quit') return 'menu';
      const result = this.finishSession();
      if (!result) return 'menu';
      const hasNext = result.success && def.kind === 'campaign' && !!nextMissionAfter(def.id);
      const choice = await this.ui.showDebrief(result, hasNext);
      return choice;
    }
  }

  /** Builds the world for a mission and resolves when it ends (or the player restarts/quits). */
  private async runSession(def: MissionDef, loadout: LoadoutId): Promise<'ended' | 'restart' | 'quit'> {
    this.teardownSession();
    const difficulty = DIFFICULTIES[this.settings.difficulty];
    this.ui.hideAll();
    this.ui.showLoading(0, 'Preparing mission');
    await nextFrame();

    const scene = new Scene();
    const pads = terrainPadsFor(def);
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

    const combat = createCombatSystem();
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
        endTimer: -1,
        unsubscribers: [],
        resolve,
      };
    });
    this.applyViewMode(rig.mode);
    this.resize();
    this.input.setThrottle(def.player.speed > 200 ? 0.82 : 0.75);
    this.input.setEnabled(true);
    this.hud.setVisible(true);
    this.paused = false;
    this.accumulator = 0;
    this.lastFrame = performance.now();
    this.ui.showLoading(1, 'Ready');
    this.ui.hideLoading();
    void this.requestWakeLock();
    this.audio.setPaused(false);
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
    this.settings = await this.ui.showSettings({ ...this.settings });
    saveSettings(this.settings);
    this.applySettings();
  }

  private applySettings(): void {
    const s = this.settings;
    this.audio.setVolumes(s.masterVolume, s.sfxVolume, s.voiceVolume);
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
    e.on('player:down', () => {
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
        const choice = await this.ui.showPause(s.runner);
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
    void loop();
  }

  private applyViewMode(mode: CameraMode): void {
    const s = this.session;
    if (!s) return;
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
      return;
    }

    const ctx = this.frameContext(dt, s);
    this.input.update(dt, ctx);

    if (!this.paused) {
      // Player controls → sim
      const p = s.world.player;
      if (p?.alive) Object.assign(p.input, this.input.controls);

      // Look-around & taps
      const look = this.input.consumeLook();
      if (look.yaw || look.pitch) s.rig.look(look.yaw, look.pitch);
      for (const tap of this.input.consumeTaps()) this.handleTap(tap.x, tap.y, s);

      // Fixed-step simulation
      this.accumulator += dt;
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
        if (s.endTimer < 0) s.endTimer = s.runner.state === 'success' ? END_DELAY_SUCCESS : END_DELAY_FAILED;
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
    s.effects.update(fctx);
    const ctx2 = this.frameContext(dt, s); // camera may have moved/changed mode
    s.cockpit.update(ctx2, s.rig.headLocal);
    this.renderer.render(s.scene, s.rig.camera);
    if (s.cockpit.visible) s.cockpit.render(this.renderer);
    this.hud.update(ctx2);
    this.audio.update(ctx2);
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
    this.ui.setRotateHint(touch && h > w);
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
          objectives: s?.runner.objectives ?? [],
          renderer: { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles },
        };
      },
      /** Programmatically start a mission (tests). */
      fly: (id: string, loadout?: LoadoutId) => {
        const def = [...CAMPAIGN, ...TRAINING].find((m) => m.id === id);
        if (!def) throw new Error(`no mission ${id}`);
        this.ui.hideAll();
        void this.missionFlow(def, loadout ?? def.recommendedLoadout);
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
      pause: () => this.openPauseMenu(),
      missions: () => [...CAMPAIGN, ...TRAINING].map((m) => ({ id: m.id, title: m.title, kind: m.kind })),
      vec: (x: number, y: number, z: number) => new Vector3(x, y, z),
    };
  }
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
