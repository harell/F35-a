/**
 * DEV ONLY — audio-lab.html: buttons for every sound and voice, sliders for the engine /
 * flight state, view-mode switch, level meter, plus `window.__audioLab` hooks used by the
 * headless check (src/audio/dev/audioCheck.mjs) to run scenarios and record the output.
 */
import type { ExplosionSize, VoiceId, WarningId, WeaponId } from '../../core/types';
import { AudioSystem } from '../AudioSystem';
import { VOICE_IDS } from '../voice/voiceIds';
import { LabWorld, type LabControls } from './labWorld';

const lab = new LabWorld();
const audio = new AudioSystem(lab.events);
audio.setVolumes(0.9, 0.9, 1);
const loadDone = audio.load((f) => setStatus(`(clips fetched ${(f * 100).toFixed(0)} %)`));

/* ───────────────────────── UI ───────────────────────── */

const root = document.getElementById('lab')!;
const statusEl = document.getElementById('status')!;
const meterEl = document.getElementById('meter') as HTMLDivElement;
let statusText = '';
function setStatus(s: string): void {
  statusText = s;
}

function section(title: string): HTMLElement {
  const s = document.createElement('section');
  const h = document.createElement('h2');
  h.textContent = title;
  s.appendChild(h);
  root.appendChild(s);
  return s;
}

function button(parent: HTMLElement, label: string, fn: () => void, hold?: (down: boolean) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (hold) {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      hold(true);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => hold(false));
  } else b.addEventListener('click', fn);
  parent.appendChild(b);
  return b;
}

function slider(parent: HTMLElement, label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void): void {
  const w = document.createElement('label');
  const span = document.createElement('span');
  const inp = document.createElement('input');
  inp.type = 'range';
  inp.min = String(min);
  inp.max = String(max);
  inp.step = String(step);
  inp.value = String(get());
  const show = () => (span.textContent = `${label} ${Number(inp.value).toFixed(step < 1 ? 2 : 0)}`);
  inp.addEventListener('input', () => {
    set(Number(inp.value));
    show();
  });
  show();
  w.append(span, inp);
  parent.appendChild(w);
}

function select<K extends keyof LabControls>(parent: HTMLElement, label: string, key: K, options: LabControls[K][]): void {
  const w = document.createElement('label');
  w.textContent = label + ' ';
  const s = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = String(o);
    opt.textContent = String(o);
    s.appendChild(opt);
  }
  s.value = String(lab.controls[key]);
  s.addEventListener('change', () => {
    (lab.controls as unknown as Record<string, unknown>)[key] = s.value;
  });
  w.appendChild(s);
  parent.appendChild(w);
}

const start = section('Audio');
button(start, '▶ Unlock audio', () => void audio.unlock());
button(start, 'UI click', () => audio.uiClick());
button(start, 'Pause / resume', () => {
  lab.controls.paused = !lab.controls.paused;
  audio.setPaused(lab.controls.paused);
});
button(start, 'Stop all', () => audio.stopAll());

const flight = section('Jet & view');
select(flight, 'View', 'view', ['cockpit', 'hud', 'chase', 'orbit', 'flyby', 'missile', 'tactical']);
select(flight, 'Quality', 'quality', ['low', 'medium', 'high']);
slider(flight, 'Throttle', 0, 1, 0.01, () => lab.controls.throttle, (v) => (lab.controls.throttle = v));
slider(flight, 'IAS m/s', 60, 420, 1, () => lab.controls.ias, (v) => (lab.controls.ias = v));
slider(flight, 'AoA °', 0, 30, 0.5, () => lab.controls.alphaDeg, (v) => (lab.controls.alphaDeg = v));
slider(flight, 'G', -1, 9.5, 0.1, () => lab.controls.g, (v) => (lab.controls.g = v));
slider(flight, 'Buffet', 0, 1, 0.01, () => lab.controls.buffet, (v) => (lab.controls.buffet = v));

const fly = section('Flybys');
button(fly, 'Su-27 flyby 280 m/s AB', () => lab.flyby(280, 'su27', 1));
button(fly, 'MiG-29 flyby 220 m/s dry', () => lab.flyby(220, 'mig29', 0));
button(fly, 'Su-35 SUPERSONIC 520 m/s', () => lab.flyby(520, 'su35', 1));
button(fly, 'Tu-22M3 bomber 230 m/s', () => lab.flyby(230, 'tu22m', 0));

const weap = section('Weapons');
button(weap, 'GUN (hold)', () => undefined, (down) => lab.gun(down));
button(weap, 'AIM-120 (bay)', () => lab.launchPlayer('aim120'));
button(weap, 'AIM-9X (rail)', () => lab.launchPlayer('aim9x'));
button(weap, 'GBU-31 drop', () => lab.launchPlayer('gbu31'));
button(weap, 'Flare', () => lab.countermeasure('flare'));
button(weap, 'Chaff', () => lab.countermeasure('chaff'));
button(weap, 'Enemy cannon 500 m', () => lab.remoteGun('gsh301', 500, 1.2));
button(weap, 'ZSU-23 burst 1.5 km', () => lab.remoteGun('zsu23', 1500, 2));
for (const w of ['gun', 'aim120', 'aim9x', 'gbu31'] as WeaponId[]) button(weap, `select ${w}`, () => lab.events.emit('weapon:select', { ownerId: lab.player.id, weapon: w }));
button(weap, 'Denied', () => lab.events.emit('weapon:denied', { ownerId: lab.player.id, weapon: 'aim120', reason: 'NO TARGET' }));
button(weap, 'Radar lock', () => lab.events.emit('lock', { ownerId: lab.player.id, targetId: 5, locked: true }));
button(weap, 'Lock lost', () => lab.events.emit('lock', { ownerId: lab.player.id, targetId: 5, locked: false }));
button(weap, 'Designate', () => lab.events.emit('designate', { ownerId: lab.player.id, targetId: 5 }));

const boom = section('Explosions, SAMs, hits');
for (const [size, d] of [
  ['tiny', 80],
  ['small', 150],
  ['medium', 400],
  ['large', 1500],
  ['huge', 6000],
] as [ExplosionSize, number][]) {
  button(boom, `${size} @ ${d} m`, () => lab.explode(size, d, 'ground'));
}
button(boom, 'large @ 300 m water', () => lab.explode('large', 300, 'water'));
button(boom, 'SA-6 launch 4 km', () => lab.launchSam(4000, 'm_3m9'));
button(boom, 'SA-10 launch 9 km', () => lab.launchSam(9000, 'm_48n6'));
button(boom, 'R-77 launch 3 km', () => lab.launchEnemy(3000));
button(boom, 'Hit (light)', () => lab.hit(12));
button(boom, 'Hit (heavy)', () => lab.hit(60));
button(boom, 'Bullet strikes', () => {
  for (let i = 0; i < 6; i++) setTimeout(() => lab.events.emit('gun:impact', { position: lab.player.position, surface: 'target', targetId: lab.player.id }), i * 70);
});
button(boom, 'Mach 1 (transonic)', () => lab.events.emit('transonic', { aircraft: lab.player, supersonic: true }));

const av = section('RWR / MAWS / AIM-9X');
select(av, 'RWR', 'rwr', ['none', 'search', 'track', 'track_sam', 'launch']);
select(av, 'AIM-9X', 'growl', ['off', 'search', 'locked']);
button(av, 'MAWS on/off', () => (lab.controls.maws = !lab.controls.maws));
for (const k of ['fighter', 'sam', 'aaa', 'ewr'] as const)
  button(av, `RWR new ${k}`, () => lab.events.emit('rwr:new', { contact: { sourceId: 1, kind: k, symbol: '?', bearing: 0, strength: 0.5, state: 'search', age: 0 } }));

const warn = section('Warnings (Betty)');
const WARNINGS: WarningId[] = ['pull_up', 'missile', 'engine_fire', 'engine_fail', 'over_g', 'stall', 'altitude', 'hydraulics', 'damage', 'bingo', 'fuel_low', 'speed_low', 'flares_low', 'chaff_low', 'spike'];
for (const w of WARNINGS) {
  const l = document.createElement('label');
  l.className = 'chk';
  const c = document.createElement('input');
  c.type = 'checkbox';
  c.addEventListener('change', () => lab.setWarning(w, c.checked));
  l.append(c, document.createTextNode(w));
  warn.appendChild(l);
}

const voices = section('Voice clips');
for (const id of VOICE_IDS) button(voices, id, () => audio.playVoice(id as VoiceId));
button(voices, 'radio (text only)', () => lab.events.emit('radio', { from: 'DARKSTAR', text: 'Picture clean.' }));
button(voices, 'radio queue ×3', () => {
  lab.events.emit('radio', { from: 'DARKSTAR', text: 'Bandits', voice: 'a_bandits', priority: 2 });
  lab.events.emit('radio', { from: 'VIPER 2', text: 'Engaged', voice: 'p_engaged', priority: 1 });
  lab.events.emit('radio', { from: 'DARKSTAR', text: 'SAM launch', voice: 'a_sam_launch', priority: 3 });
});

/* ───────────────────────── meter + recording tap ───────────────────────── */

let analyser: AnalyserNode | null = null;
let recL: Float32Array[] = [];
let recR: Float32Array[] = [];
let recording = false;
let tapReady = false;
function ensureTap(): void {
  const core = audio.core;
  if (tapReady || !core) return;
  const ctx = core.env.ctx;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  core.env.mixer.output.connect(analyser);
  const sp = ctx.createScriptProcessor(4096, 2, 2);
  sp.onaudioprocess = (e) => {
    if (!recording) return;
    recL.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    recR.push(new Float32Array(e.inputBuffer.getChannelData(1)));
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  core.env.mixer.output.connect(sp);
  sp.connect(mute);
  mute.connect(ctx.destination);
  tapReady = true;
}

const meterBuf = new Float32Array(2048);
let peakHold = 0;
function drawMeter(): void {
  if (!analyser) return;
  analyser.getFloatTimeDomainData(meterBuf);
  let s = 0;
  let pk = 0;
  for (const v of meterBuf) {
    s += v * v;
    pk = Math.max(pk, Math.abs(v));
  }
  const rmsDb = 10 * Math.log10(s / meterBuf.length + 1e-12);
  peakHold = Math.max(pk, peakHold * 0.97);
  meterEl.style.width = `${Math.max(0, Math.min(100, (rmsDb + 60) * (100 / 60)))}%`;
  meterEl.title = `${rmsDb.toFixed(1)} dB`;
  meterEl.dataset.db = rmsDb.toFixed(1);
  meterEl.style.background = peakHold > 0.98 ? '#f44' : '#5c5';
}

function b64(a: Float32Array): string {
  const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function concat(chunks: Float32Array[]): Float32Array {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/* ───────────────────────── scenarios (automation) ───────────────────────── */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scenario → [setup, default record length (s)]. Recording starts right before setup. */
const SCENARIOS: Record<string, [() => Promise<void> | void, number]> = {
  bed_cockpit_idle: [() => set({ view: 'cockpit', throttle: 0.05, ias: 140, alphaDeg: 4 }), 3],
  bed_cockpit_cruise: [() => set({ view: 'cockpit', throttle: 0.9, ias: 260, alphaDeg: 3 }), 3],
  bed_cockpit_ab_highg: [() => set({ view: 'cockpit', throttle: 1, ias: 330, alphaDeg: 16, g: 7.5, buffet: 0.6 }), 4],
  bed_chase_mil: [() => set({ view: 'chase', throttle: 0.9, ias: 260 }), 3],
  bed_chase_ab: [() => set({ view: 'chase', throttle: 1, ias: 300 }), 3],
  flyby_player: [() => set({ view: 'flyby', throttle: 1, ias: 240 }), 6.5],
  flyby_ai: [
    async () => {
      set({ view: 'cockpit', throttle: 0.3, ias: 120 });
      lab.flyby(280, 'su27', 1, 1200);
    },
    6,
  ],
  flyby_super: [
    async () => {
      set({ view: 'chase', throttle: 0.2, ias: 90 });
      lab.flyby(520, 'su35', 1, 1500);
    },
    6,
  ],
  iso_gun: [
    async () => {
      set({ view: 'cockpit', throttle: 0.3, ias: 120 });
      await wait(300);
      lab.gun(true);
      await wait(1300);
      lab.gun(false);
    },
    3.2,
  ],
  iso_missile: [
    async () => {
      set({ view: 'cockpit', throttle: 0.3, ias: 120 });
      await wait(300);
      lab.launchPlayer('aim120');
    },
    4,
  ],
  iso_explosion_close: [
    async () => {
      set({ view: 'chase', throttle: 0.05, ias: 90 });
      await wait(200);
      lab.explode('large', 150, 'ground');
    },
    3.5,
  ],
  iso_explosion_far: [
    async () => {
      set({ view: 'chase', throttle: 0.05, ias: 90 });
      lab.explode('huge', 1600, 'ground');
    },
    8,
  ],
  iso_hits: [
    async () => {
      set({ view: 'cockpit', throttle: 0.05, ias: 90 });
      await wait(200);
      lab.hit(60);
      await wait(700);
      for (let i = 0; i < 5; i++) {
        lab.events.emit('gun:impact', { position: lab.player.position, surface: 'target', targetId: lab.player.id });
        await wait(90);
      }
    },
    2.2,
  ],
  iso_countermeasures: [
    async () => {
      set({ view: 'cockpit', throttle: 0.05, ias: 90 });
      for (let i = 0; i < 3; i++) {
        await wait(250);
        lab.countermeasure('flare');
      }
      for (let i = 0; i < 3; i++) {
        await wait(250);
        lab.countermeasure('chaff');
      }
    },
    2.4,
  ],
  sam: [
    async () => {
      set({ view: 'cockpit', throttle: 0.6, ias: 220, rwr: 'launch' });
      lab.launchSam(1500, 'm_3m9');
    },
    9,
  ],
  rwr_maws: [() => set({ view: 'cockpit', throttle: 0.4, ias: 200, rwr: 'track', maws: true }), 3],
  growl: [
    async () => {
      set({ view: 'cockpit', throttle: 0.4, ias: 200, growl: 'search' });
      await wait(1500);
      lab.controls.growl = 'locked';
    },
    3.5,
  ],
  betty: [
    () => {
      set({ view: 'cockpit', throttle: 0.6, ias: 220 });
      lab.setWarning('fuel_low', true);
      lab.setWarning('pull_up', true);
    },
    5,
  ],
  radio: [
    () => {
      set({ view: 'cockpit', throttle: 0.6, ias: 220 });
      lab.events.emit('radio', { from: 'DARKSTAR', text: 'Bandits', voice: 'a_bandits', priority: 2 });
      lab.events.emit('radio', { from: 'VIPER 1', text: 'Fox three', voice: 'p_fox3', priority: 2 });
    },
    5,
  ],
  avionics_clicks: [
    async () => {
      set({ view: 'cockpit', throttle: 0.05, ias: 90 });
      const e = lab.events;
      const id = lab.player.id;
      e.emit('rwr:new', { contact: { sourceId: 1, kind: 'fighter', symbol: '29', bearing: 0, strength: 0.5, state: 'search', age: 0 } });
      await wait(500);
      e.emit('lock', { ownerId: id, targetId: 5, locked: true });
      await wait(500);
      e.emit('weapon:select', { ownerId: id, weapon: 'aim9x' });
      await wait(400);
      e.emit('weapon:denied', { ownerId: id, weapon: 'aim120', reason: 'x' });
      await wait(400);
      lab.setWarning('hydraulics', true);
      await wait(300);
      audio.uiClick();
    },
    3.5,
  ],
};

function set(c: Partial<LabControls>): void {
  Object.assign(lab.controls, c);
}

/** Quiet default state between recordings. */
function reset(): void {
  audio.stopAll();
  lab.clear();
  for (const w of WARNINGS) lab.setWarning(w, false);
  set({ view: 'cockpit', throttle: 0.05, ias: 90, rwr: 'none', maws: false, growl: 'off', paused: false, alphaDeg: 3, g: 1, buffet: 0 });
}

(window as unknown as { __audioLab: unknown }).__audioLab = {
  audio,
  lab,
  unlock: () => audio.unlock(),
  loaded: () => loadDone.then(() => [...audio.bank.report.values()]),
  state: () => ({
    ctx: audio.core?.env.ctx.state ?? 'none',
    sampleRate: audio.core?.env.ctx.sampleRate ?? 0,
    currentTime: audio.core?.env.ctx.currentTime ?? 0,
    decoded: audio.bank.decodedCount,
    oneShots: audio.core?.env.pool.count ?? 0,
    session: !!audio.session,
    db: meterEl.dataset.db ?? null,
  }),
  scenarios: () => Object.keys(SCENARIOS),
  /** Reset, run a scenario, record its length (or `seconds`) of master output → base64 Float32 L/R. */
  async record(name: string, seconds?: number) {
    ensureTap();
    reset();
    await wait(1200); // let spool-downs / fades from the previous scenario settle
    const sc = SCENARIOS[name];
    const t0 = performance.now();
    recL = [];
    recR = [];
    recording = true;
    await sc?.[0]();
    const len = (seconds ?? sc?.[1] ?? 3) * 1000;
    await wait(Math.max(0, len - (performance.now() - t0)));
    recording = false;
    const L = concat(recL);
    const R = concat(recR);
    return { sampleRate: audio.core?.env.ctx.sampleRate ?? 48000, l: b64(L), r: b64(R) };
  },
};

/* ───────────────────────── loop ───────────────────────── */

let last = performance.now();
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  lab.step(dt);
  audio.update(lab.frame(dt));
  ensureTap();
  drawMeter();
  const core = audio.core;
  statusEl.textContent = `${core ? core.env.ctx.state : 'locked — tap anywhere'} · clips decoded ${audio.bank.decodedCount}/${VOICE_IDS.length} · one-shots ${core?.env.pool.count ?? 0} · ${lab.controls.view} · rpm ${lab.player.flight.engineRpm.toFixed(2)} AB ${lab.player.flight.afterburner.toFixed(2)} ${statusText}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
