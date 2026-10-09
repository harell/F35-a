/**
 * DEV ONLY — in-game audio smoke test: loads a mission with ?autostart=1 (audio locked, must not
 * throw), taps the screen (the audio module self-unlocks on any gesture), then records the real
 * game's master output while driving the jet (AB, views, weapons) and writes WAV + spectrogram.
 *
 *   node src/audio/dev/gameAudioCheck.mjs [--url=http://localhost:5173/?mission=g01&autostart=1&view=cockpit]
 *                                          [--out=/tmp/f35-audio-game] [--seconds=10]
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
  }),
);
const url = args.url || 'http://localhost:5173/?mission=g01&autostart=1&view=cockpit';
const out = args.out || '/tmp/f35-audio-game';
const seconds = Number(args.seconds || 10);
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const page = await context.newPage();
const logs = [];
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__f35?.state?.().inMission, null, { timeout: 60000 });
await page.waitForTimeout(1500);
const locked = await page.evaluate(() => {
  const a = window.__f35.game.audio;
  return { ctx: a.core?.env.ctx.state ?? 'none', session: !!a.session };
});
console.log('before tap (should be locked):', JSON.stringify(locked));
await page.touchscreen.tap(422, 120);
await page.waitForTimeout(1500);
const unlocked = await page.evaluate(() => {
  const a = window.__f35.game.audio;
  return { ctx: a.core?.env.ctx.state ?? 'none', session: !!a.session, voices: a.bank.decodedCount, oneShots: a.core?.env.pool.count ?? 0 };
});
console.log('after tap:', JSON.stringify(unlocked));

// record while flying: AB, weapon release, view changes
const rec = await page.evaluate(async (secs) => {
  const g = window.__f35;
  const a = g.game.audio;
  const ctx = a.core.env.ctx;
  const L = [];
  const R = [];
  const sp = ctx.createScriptProcessor(4096, 2, 2);
  sp.onaudioprocess = (e) => {
    L.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    R.push(new Float32Array(e.inputBuffer.getChannelData(1)));
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  a.core.env.mixer.output.connect(sp);
  sp.connect(mute);
  mute.connect(ctx.destination);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const t = secs * 1000;
  g.controls({ throttle: 1 });
  await wait(t * 0.25);
  g.controls({ throttle: 1, fireWeapon: true });
  await wait(150);
  g.controls({ throttle: 1, fireWeapon: false, flare: true });
  await wait(150);
  g.controls({ throttle: 1, flare: false, fireGun: true });
  await wait(t * 0.12);
  g.controls({ throttle: 0.8, fireGun: false });
  await wait(t * 0.15);
  g.setView('chase');
  await wait(t * 0.25);
  g.setView('flyby');
  await wait(t * 0.2);
  sp.disconnect();
  a.core.env.mixer.output.disconnect(sp);
  const cat = (chunks) => {
    const n = chunks.reduce((s, c) => s + c.length, 0);
    const o = new Float32Array(n);
    let k = 0;
    for (const c of chunks) {
      o.set(c, k);
      k += c.length;
    }
    return o;
  };
  const b64 = (f) => {
    const u8 = new Uint8Array(f.buffer);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  return { sr: ctx.sampleRate, l: b64(cat(L)), r: b64(cat(R)), state: g.state(), oneShots: a.core.env.pool.count };
}, seconds);

const f32 = (b64) => {
  const b = Buffer.from(b64, 'base64');
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
const l = f32(rec.l);
const r = f32(rec.r);
const n = l.length;
const buf = Buffer.alloc(44 + n * 4);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + n * 4, 4);
buf.write('WAVEfmt ', 8);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(rec.sr, 24);
buf.writeUInt32LE(rec.sr * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(n * 4, 40);
let peak = 0;
let sum = 0;
for (let i = 0; i < n; i++) {
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767))), 44 + i * 4);
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767))), 46 + i * 4);
  peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  sum += (l[i] * l[i] + r[i] * r[i]) / 2;
}
const wav = path.join(out, 'game.wav');
fs.writeFileSync(wav, buf);
console.log(`recorded ${(n / rec.sr).toFixed(1)} s  rms ${(10 * Math.log10(sum / Math.max(1, n) + 1e-12)).toFixed(1)} dBFS  peak ${(20 * Math.log10(peak + 1e-12)).toFixed(1)} dBFS  one-shots active ${rec.oneShots}`);
console.log('state', JSON.stringify(rec.state.player), JSON.stringify(rec.state.counts));
try {
  execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-lavfi', 'showspectrumpic=s=900x280:legend=1:fscale=log:color=intensity', path.join(out, 'game.png')]);
  console.log('spectrogram', path.join(out, 'game.png'));
} catch (e) {
  console.log('(spectrogram failed)', e.message);
}
console.log(logs.length ? logs.slice(0, 30).join('\n') : 'no console errors');
await browser.close();
