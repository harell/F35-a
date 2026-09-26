/**
 * DEV ONLY — headless audio check (Playwright + Chromium, no speakers needed).
 *
 *   node src/audio/dev/audioCheck.mjs [--url=http://localhost:5173/labs/audio-lab.html] [--out=/tmp/f35-audio-check]
 *                                     [--only=scenario,scenario] [--seconds=3]
 *
 * 1. opens labs/audio-lab.html, taps "Unlock audio" (a real user gesture)
 * 2. waits for every voice clip to be fetched + decoded and prints the HTTP statuses
 * 3. runs each lab scenario, records the master output through a ScriptProcessor tap and
 *    writes <out>/<scenario>.wav plus a spectrogram PNG (ffmpeg) and level stats
 * 4. prints console errors / warnings
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
const url = args.url || 'http://localhost:5173/labs/audio-lab.html';
const out = args.out || '/tmp/f35-audio-check';
const seconds = args.seconds ? Number(args.seconds) : undefined;
fs.mkdirSync(out, { recursive: true });

function writeWav(file, sr, l, r) {
  const n = l.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

const f32 = (b64) => {
  const b = Buffer.from(b64, 'base64');
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
const logs = [];
const voiceRequests = [];
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('response', (r) => {
  if (r.url().includes('/audio/voice/')) voiceRequests.push(`${r.status()} ${r.url().split('/').pop()}`);
});
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(500);
const before = await page.evaluate(() => window.__audioLab.state());
console.log('before gesture:', JSON.stringify(before));
await page.getByText('▶ Unlock audio').tap();
await page.waitForTimeout(600);
const report = await page.evaluate(() => window.__audioLab.loaded());
const ok = report.filter((r) => r.status === 200 && r.decoded).length;
console.log(`voices: ${ok}/${report.length} fetched (200) + decoded; responses seen: ${voiceRequests.length}`);
for (const r of report) if (!(r.status === 200 && r.decoded)) console.log('  voice problem:', JSON.stringify(r));
console.log('after gesture:', JSON.stringify(await page.evaluate(() => window.__audioLab.state())));

const all = await page.evaluate(() => window.__audioLab.scenarios());
const only = args.only ? String(args.only).split(',') : all;
for (const name of only) {
  const rec = await page.evaluate(([n, s]) => window.__audioLab.record(n, s), [name, seconds]);
  const l = f32(rec.l);
  const r = f32(rec.r);
  const wav = path.join(out, `${name}.wav`);
  writeWav(wav, rec.sampleRate, l, r);
  let peak = 0;
  let sum = 0;
  let clip = 0;
  for (let i = 0; i < l.length; i++) {
    const a = Math.max(Math.abs(l[i]), Math.abs(r[i]));
    peak = Math.max(peak, a);
    sum += (l[i] * l[i] + r[i] * r[i]) / 2;
    if (a >= 0.999) clip++;
  }
  const rmsDb = 10 * Math.log10(sum / Math.max(1, l.length) + 1e-12);
  console.log(`${name.padEnd(18)} ${(l.length / rec.sampleRate).toFixed(2)} s  rms ${rmsDb.toFixed(1)} dBFS  peak ${(20 * Math.log10(peak + 1e-12)).toFixed(1)} dBFS  clipped ${clip}`);
  try {
    execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-lavfi', 'showspectrumpic=s=800x260:legend=1:fscale=log:color=intensity', path.join(out, `${name}.png`)]);
  } catch (e) {
    console.log('  (spectrogram failed)', e.message);
  }
}
console.log(logs.length ? logs.slice(0, 40).join('\n') : 'no console errors');
await browser.close();
