/**
 * Touch-interaction + menu-flow check against the real game (phone landscape, headless Chromium).
 *
 *   node e2e/ui-touch.mjs [--base=http://localhost:5173/] [--part=flight|menus|all]
 *
 * flight: ?mission=c01&autostart=1 → multi-touch stick + throttle, AB detent/double-tap, FIRE/GUN/CMS,
 *         TGT/WPN/RADAR, CAM tap + long-press padlock, look drag, tap designation in the target (padlock)
 *         view, pause → resume, then the fly() hook from the pause menu → c02's pause menu → quit → main menu.
 * menus:  first launch (fresh context): New pilot card → Start training → Training list → briefing → back
 *         → Training list; then splash → main menu (Not now on the card) → settings round-trip → campaign
 *         → briefing → back → campaign list → briefing (tabs, loadout) → FLY → pause → quit → main menu,
 *         instant action → briefing → back → setup → back → main menu, credits, fly() from the main
 *         menu → quit → main menu.
 * Uses CDP Input.dispatchTouchEvent so several fingers can be down at once. Screenshots go to
 * e2e/screenshots/ui/touch-*.png. Exits non-zero on failure.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
  }),
);
const base = args.base || 'http://localhost:5173/';
const part = args.part || 'all';
fs.mkdirSync('e2e/screenshots/ui', { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const CTX_OPTS = {
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};
const ctx = await browser.newContext(CTX_OPTS);

let failures = 0;
const check = (cond, msg, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

async function touchApi(page) {
  const cdp = await ctx.newCDPSession(page);
  const fingers = new Map();
  // `timestamp` (s since epoch) pins the event times: CDP otherwise stamps an event when it is
  // dispatched, which waits for the previous event's ack, i.e. a slow SwiftShader frame. A 60 ms
  // tap then reached the page as a ~500 ms press, and 'quick tap on the view' failed.
  const send = (type, timestamp) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: [...fingers.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 6, radiusY: 6, force: 1 })),
      ...(timestamp !== undefined ? { timestamp } : {}),
    });
  return {
    async down(id, x, y, timestamp) {
      fingers.set(id, { x, y });
      await send('touchStart', timestamp);
    },
    async move(id, x, y, steps = 6) {
      const p = fingers.get(id);
      const sx = p.x;
      const sy = p.y;
      for (let i = 1; i <= steps; i++) {
        p.x = sx + ((x - sx) * i) / steps;
        p.y = sy + ((y - sy) * i) / steps;
        await send('touchMove');
        await page.waitForTimeout(16);
      }
    },
    async up(id, timestamp) {
      // touchEnd lists the remaining touches
      const p = fingers.get(id);
      fingers.delete(id);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [...fingers.entries()].map(([fid, q]) => ({ x: q.x, y: q.y, id: fid })),
        ...(timestamp !== undefined ? { timestamp } : {}),
      });
      return p;
    },
    /** A tap of exactly `holdMs` as the page sees it, however slow the frames are. */
    async tap(x, y, holdMs = 60) {
      const t0 = Date.now() / 1000;
      await this.down(99, x, y, t0);
      await page.waitForTimeout(holdMs);
      await this.up(99, t0 + holdMs / 1000);
    },
  };
}

/** Wait until the game has run two more frames (input is polled once per frame). */
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

/** A screenshot with room for a loaded box: one SwiftShader frame can take seconds there (default 30 s timed out). */
const shot = (page, name) => page.screenshot({ path: `e2e/screenshots/ui/${name}.png`, timeout: 120_000 });

/** Quit from the pause menu: both taps from the page, so a slow frame can't let the 2.6 s confirm window lapse. */
const quitFromPause = (page) =>
  page.evaluate(() => {
    const b = document.querySelector('.scr-pause:not(.is-leaving) .pz-btns .ui-btn.danger:last-child');
    b.click();
    b.click();
  });

/** fly() a mission and wait until it is running (the hook takes over from any screen or mission). */
async function flyHook(page, id, timeout = 120_000) {
  await page.evaluate((m) => window.__f35.fly(m), id);
  return page
    .waitForFunction((m) => window.__f35.state().mission === m && window.__f35.state().missionState === 'running' && !window.__f35.state().paused, id, { timeout })
    .then(() => true, () => false);
}

const rectOf = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}, sel);

/* ───────────────────────── flight controls ───────────────────────── */
async function flight() {
  console.log('\n[flight] touch controls in c01');
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  if (args.debug) page.on('console', (m) => m.type() === 'log' && console.log('    ·', m.text()));
  await page.goto(`${base}?mission=c01&autostart=1&view=chase`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__f35?.state?.().inMission && window.__f35.state().player, null, { timeout: 120_000 }); // a mission load under a loaded box can pass 60 s
  await page.waitForTimeout(1500);
  const t = await touchApi(page);
  const controls = () => page.evaluate(() => ({ ...window.__f35.game.input.controls }));
  // spies on look/taps consumed by Game
  await page.evaluate(() => {
    const inp = window.__f35.game.input;
    window.__spy = { yaw: 0, pitch: 0, taps: [], handled: [], cmds: [] };
    const cl = inp.consumeLook.bind(inp);
    inp.consumeLook = () => {
      const r = cl();
      window.__spy.yaw += r.yaw;
      window.__spy.pitch += r.pitch;
      return r;
    };
    const ct = inp.consumeTaps.bind(inp);
    inp.consumeTaps = () => {
      const r = ct();
      for (const x of r) window.__spy.taps.push({ ...x });
      return r;
    };
    for (const c of ['cycleWeapon', 'cycleTarget', 'camera', 'pause', 'radar', 'lookReset', 'padlock']) inp.on(c, () => window.__spy.cmds.push(c));
    // the frame loop hands every consumed tap to Game.handleTap: record which view each one landed in
    const game = window.__f35.game;
    const ht = game.handleTap.bind(game);
    game.handleTap = (x, y, s) => {
      window.__spy.handled.push({ x, y, view: s.rig.mode });
      return ht(x, y, s);
    };
  });

  if (args.debug)
    await page.evaluate(() => {
      for (const ty of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture'])
        document.addEventListener(ty, (e) => console.log(ty, e.pointerId, Math.round(e.clientX), Math.round(e.clientY), String(e.target.className).slice(0, 30)), true);
    });
  // visible controls
  const vis = await page.evaluate(() => {
    const el = document.querySelector('.f35-ctl');
    return el && !el.classList.contains('is-disabled') && el.dataset.touch === '1';
  });
  check(vis, 'touch controls visible in flight');

  // ── stick (right thumb) + throttle (left thumb) at the same time ──
  const thr = await rectOf(page, '.ctl-throttle');
  const handle = await rectOf(page, '.thr-handle');
  const c0 = await controls();
  await t.down(1, 720, 290);
  await t.move(1, 720, 350);
  const held = await controls();
  check(held.pitch > 0.6, 'stick: thumb pulled down → nose-up pitch', `pitch=${held.pitch.toFixed(2)}`);
  await t.move(1, 780, 350);
  const diag = await controls();
  check(diag.roll > 0.5 && diag.pitch > 0.5, 'stick: diagonal gives roll + pitch', `roll=${diag.roll.toFixed(2)} pitch=${diag.pitch.toFixed(2)}`);
  // second finger on the throttle while the stick is held
  await t.down(2, handle.cx, handle.cy);
  await t.move(2, handle.cx, thr.y + 2, 10);
  const both = await controls();
  check(both.throttle > c0.throttle + 0.1 && both.roll > 0.5, 'multi-touch: throttle moves while the stick is held', `throttle ${c0.throttle.toFixed(2)} → ${both.throttle.toFixed(2)}`);
  check(both.throttle > 0.9, 'throttle pushed through the detent into AB', `throttle=${both.throttle.toFixed(3)}`);
  await shot(page, 'touch-stick-throttle');
  await t.up(2);
  await t.up(1);
  await page.waitForTimeout(250);
  const rel = await controls();
  check(Math.abs(rel.pitch) < 0.05 && Math.abs(rel.roll) < 0.05, 'stick springs back to centre on release', `pitch=${rel.pitch.toFixed(3)} roll=${rel.roll.toFixed(3)}`);
  check(Math.abs(rel.throttle - both.throttle) < 0.02, 'throttle is persistent after release', `throttle=${rel.throttle.toFixed(3)}`);

  // detent: slide down from AB stops in the gate at MIL before dropping below
  const h2 = await rectOf(page, '.thr-handle');
  await t.down(3, h2.cx, h2.cy);
  await t.move(3, h2.cx, h2.cy + 0.22 * thr.h, 5);
  const inGate = await controls();
  check(inGate.throttle <= 0.9001 && inGate.throttle >= 0.85, 'sliding back from AB lands on/near the MIL detent', `throttle=${inGate.throttle.toFixed(3)}`);
  await t.move(3, h2.cx, Math.min(388, h2.cy + thr.h), 10);
  const idle = await controls();
  check(idle.throttle === 0 && idle.airbrake, 'throttle to the idle stop = IDLE + speed brake', `throttle=${idle.throttle} airbrake=${idle.airbrake}`);
  await t.up(3);

  // (double-tap gestures are checked in the DOM-only lab part: under software GL each touch
  //  dispatch blocks for a whole ~0.5-1 s frame, so two taps can't land inside 320 ms here)

  // ── weapon buttons ──
  const fire = await rectOf(page, '.b-fire');
  const label = await page.evaluate(() => document.querySelector('.b-fire')?.textContent);
  check(/AMRAAM/.test(label ?? '') && /×4/.test(label ?? ''), 'FIRE shows the selected weapon and count', label);
  await t.down(4, fire.cx, fire.cy);
  await settle(page);
  const fw = await controls();
  check(fw.fireWeapon, 'FIRE held → controls.fireWeapon');
  await t.up(4);
  const gun = await rectOf(page, '.b-gun');
  await t.down(5, gun.cx, gun.cy);
  await settle(page);
  const fg = await controls();
  check(fg.fireGun, 'GUN held → controls.fireGun');
  const cms = await rectOf(page, '.b-cms');
  await t.down(6, cms.cx, cms.cy);
  await settle(page);
  const fc = await controls();
  check(fc.flare && fc.chaff && fc.fireGun, 'CMS held with GUN (two fingers) → flare + chaff + gun');
  await t.up(6);
  await t.up(5);

  // ── command buttons ──
  for (const [sel, cmd] of [
    ['.b-tgt', 'cycleTarget'],
    ['.b-wpn', 'cycleWeapon'],
    ['.b-radar', 'radar'],
  ]) {
    const r = await rectOf(page, sel);
    await t.tap(r.cx, r.cy);
    await settle(page);
    const cmds = await page.evaluate(() => window.__spy.cmds.slice());
    check(cmds.includes(cmd), `${sel} → ${cmd}`);
  }
  const wlabel = await page.evaluate(() => document.querySelector('.b-fire')?.textContent);
  check(wlabel !== label, 'FIRE label follows the weapon selection', `${label} → ${wlabel}`);
  const radarLbl = await page.evaluate(() => document.querySelector('.b-radar')?.textContent);
  check(/EMCON/.test(radarLbl ?? ''), 'RDR button shows EMCON after toggling', radarLbl);

  // camera: tap cycles, long-press → padlock
  const view0 = (await page.evaluate(() => window.__f35.state().view)) ?? '';
  const cam = await rectOf(page, '.b-cam');
  await t.tap(cam.cx, cam.cy);
  await page.waitForTimeout(150);
  const view1 = await page.evaluate(() => window.__f35.state().view);
  check(view1 !== view0, 'CAM tap cycles the view', `${view0} → ${view1}`);
  await t.down(7, cam.cx, cam.cy);
  await page.waitForTimeout(650);
  await t.up(7);
  await page.waitForTimeout(150);
  const cmds2 = await page.evaluate(() => window.__spy.cmds.slice());
  check(cmds2.includes('padlock'), 'CAM long-press → padlock');

  // ── look drag + tap on the free view ──
  await t.down(8, 420, 170);
  await t.move(8, 520, 140, 8);
  await t.up(8);
  await page.waitForTimeout(100);
  const spy = await page.evaluate(() => window.__spy);
  check(spy.yaw > 0.1 && spy.pitch > 0.02, 'drag on the centre = look around (right/up)', `yaw=${spy.yaw.toFixed(2)} pitch=${spy.pitch.toFixed(2)}`);
  check(spy.taps.length === 0, 'a drag is not reported as a tap');
  // the tap stays in the target (padlock) view, where it designates like in every other view (#71).
  // The CAM sequence above can end in another view (under SwiftShader a CAM tap's touchEnd can arrive
  // after the 480 ms long-press timer, so the 'tap' is a padlock), so pin the view for this check.
  const tapView = await page.evaluate(() => {
    if (window.__f35.state().view !== 'target') window.__f35.setView('target');
    return window.__f35.state().view;
  });
  await settle(page);
  await t.tap(430, 180);
  // the game reads taps once per frame, and a SwiftShader frame takes far longer than the 100 ms this
  // used to wait, so the read came before the frame that consumes the tap (in every view)
  await settle(page);
  const tapSeen = await page.evaluate(() => ({ taps: window.__spy.taps.slice(), handled: window.__spy.handled.slice() }));
  const { taps } = tapSeen;
  check(tapView === 'target' && taps.length === 1 && Math.abs(taps[0].x - 430) < 2, `quick tap on the view (${tapView}) → consumeTaps`, JSON.stringify(taps));
  check(
    tapSeen.handled.length === 1 && Math.abs(tapSeen.handled[0].x - 430) < 2 && tapSeen.handled[0].view === 'target',
    'the consumed tap reaches Game.handleTap in the target view',
    JSON.stringify(tapSeen.handled),
  );
  // Game.handleTap designates the box under a tap in the target view. One evaluate, no frame in between,
  // so the padlock can't move the box: find another contact's box with hud.pick, tap it, read the designation.
  let tgtTap = null;
  for (let i = 0; i < 6 && !tgtTap?.box; i++) {
    if (i) await settle(page);
    tgtTap = await page.evaluate(() => {
      const g = window.__f35.game;
      const s = g.session;
      const p = s?.world.player;
      if (!s || !p?.alive) return { view: s?.rig.mode ?? null, box: null, why: 'no live player' };
      if (s.rig.mode !== 'target') window.__f35.setView('target');
      const view = s.rig.mode;
      const before = p.radar.designatedId;
      const contactIds = new Set(p.radar.contacts.map((c) => c.id));
      let box = null;
      for (let y = 40; y < 280 && !box; y += 12)
        for (let x = 60; x < 784 && !box; x += 12) {
          const id = g.hud.pick(x, y);
          const e = id == null ? null : s.world.getEntity(id);
          if (e?.alive && id !== before && contactIds.has(id) && e.team !== p.team) box = { id, x, y };
        }
      if (!box) return { view, before, box: null, why: 'no other contact on screen' };
      g.handleTap(box.x, box.y, s);
      return { view, before, box, after: p.radar.designatedId };
    });
  }
  check(
    tgtTap.view === 'target' && tgtTap.box && tgtTap.after === tgtTap.box.id,
    "target view: Game.handleTap on another contact's box designates it",
    JSON.stringify(tgtTap),
  );
  // ── pause via the button, resume via the menu ──
  const pause = await rectOf(page, '.b-pause');
  await t.tap(pause.cx, pause.cy);
  await page.waitForTimeout(500);
  const ps = await page.evaluate(() => ({ paused: window.__f35.state().paused, menu: !!document.querySelector('.scr-pause'), ctl: document.querySelector('.f35-ctl').classList.contains('is-disabled') }));
  check(ps.paused && ps.menu && ps.ctl, 'PAUSE → game paused, pause menu shown, controls hidden', JSON.stringify(ps));
  await shot(page, 'touch-pause');
  const resume = await rectOf(page, '.scr-pause .ui-btn.primary');
  await t.tap(resume.cx, resume.cy);
  await page.waitForTimeout(500);
  const rs = await page.evaluate(() => ({ paused: window.__f35.state().paused, menu: !!document.querySelector('.scr-pause:not(.is-leaving)') }));
  check(!rs.paused && !rs.menu, 'RESUME → flying again', JSON.stringify(rs));
  await shot(page, 'touch-flight');

  // ── the fly() hook over the pause menu (#71): the new mission's pause menu still opens ──
  await page.evaluate(() => {
    window.__f35.pause();
    window.__f35.fly('c02');
    window.__f35.pause();
  });
  const fp = await page
    .waitForFunction(() => window.__f35.state().mission === 'c02' && !!document.querySelector('.scr-pause:not(.is-leaving)'), null, { timeout: 120_000 })
    .then(() => page.evaluate(() => ({ mission: window.__f35.state().mission, paused: window.__f35.state().paused, menu: true })), () =>
      page.evaluate(() => ({ mission: window.__f35.state().mission, paused: window.__f35.state().paused, menu: false })),
    );
  check(fp.mission === 'c02' && fp.paused && fp.menu, "pause(); fly('c02'); pause() → c02's pause menu", JSON.stringify(fp));
  // the autostart flow ends in the main menu, and so does the mission fly() put in its place
  if (fp.menu) await quitFromPause(page);
  const back = await page.waitForSelector('.scr-main:not(.is-leaving)', { timeout: 30_000 }).then(() => true, () => false);
  check(back && !(await page.evaluate(() => window.__f35.state().inMission)), 'quit the fly() mission → main menu');
  check(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));
  await page.close();
}

/* ───────────────────────── menu flow ───────────────────────── */
/** First launch in a fresh context (empty storage): the New pilot card's 'Start training' → Training list. */
async function onboarding() {
  console.log('\n[menus] first launch: New pilot card (fresh context)');
  const fresh = await browser.newContext(CTX_OPTS);
  const page = await fresh.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('.scr-splash', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.tap('.scr-splash');
  await page.waitForSelector('.scr-main:not(.is-leaving)', { timeout: 10000 });
  await page.waitForTimeout(700);
  check(await page.isVisible('.mm-onboard'), 'first launch shows the New pilot card');
  await page.screenshot({ path: 'e2e/screenshots/ui/flow-2-onboard.png' });
  await page.tap('.mm-onboard .mo-btns .ui-btn.primary');
  await page.waitForSelector('.scr-missions.kind-training:not(.is-leaving) .mcard');
  const lessons = await page.evaluate(() => [...document.querySelectorAll('.scr-missions:not(.is-leaving) .mcard .mc-num')].map((e) => e.textContent));
  check(lessons.length >= 3 && lessons[0] === 'T01', "'Start training' opens the Training list", lessons.join(','));
  // Back on a training briefing returns to the Training list, not the main menu
  await page.tap('.scr-missions:not(.is-leaving) .mcard');
  await page.waitForSelector('.scr-brief:not(.is-leaving)');
  await page.waitForTimeout(500);
  await page.tap('.scr-brief .back-btn');
  await page.waitForSelector('.scr-missions.kind-training:not(.is-leaving)');
  check(!(await page.$('.scr-main:not(.is-leaving)')), 'training briefing back → Training list');
  await page.tap('.scr-missions:not(.is-leaving) .back-btn');
  await page.waitForSelector('.scr-main:not(.is-leaving)');
  await page.waitForTimeout(300);
  check(!(await page.$('.mm-onboard')), 'Training list back → main menu, the New pilot card stays dismissed');
  check(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));
  await fresh.close();
}

async function menus() {
  await onboarding();
  console.log('\n[menus] real game flow');
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('.scr-splash', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'e2e/screenshots/ui/flow-1-splash.png' });
  await page.tap('.scr-splash');
  await page.waitForSelector('.scr-main:not(.is-leaving)', { timeout: 10000 });
  await page.waitForTimeout(700);
  check(true, 'splash → main menu');
  // a fresh save shows the New pilot card over the menu rows: 'Not now' dismisses it
  if (await page.$('.mm-onboard')) {
    await page.tap('.mm-onboard .mo-btns .ui-btn.ghost');
    await page.waitForSelector('.mm-onboard', { state: 'detached' });
    check(true, "New pilot card → 'Not now' dismisses it");
  }
  await page.screenshot({ path: 'e2e/screenshots/ui/flow-2-main.png' });

  const t = await touchApi(page);
  // settings round-trip (change difficulty → Done) + touch scrolling inside the settings list
  await page.tap('.mm-item[data-id="settings"]');
  await page.waitForSelector('.scr-settings:not(.is-leaving)');
  await page.tap('.set-tab:nth-child(4)');
  await page.waitForTimeout(250);
  const sc = await rectOf(page, '.set-content');
  await t.down(1, sc.cx, sc.y + sc.h - 20);
  await t.move(1, sc.cx, sc.y + 30, 8);
  await t.up(1);
  await page.waitForTimeout(400);
  const st = await page.evaluate(() => document.querySelector('.set-content').scrollTop);
  check(st > 20, 'settings list scrolls with a vertical swipe', `scrollTop=${Math.round(st)}`);
  await page.tap('.set-tab:nth-child(1)');
  await page.waitForTimeout(200);
  await page.tap('.diff-card[data-id="ace"]');
  await page.tap('.scr-settings .scr-head .ui-btn.primary');
  await page.waitForSelector('.scr-main:not(.is-leaving)');
  const diff = await page.evaluate(() => window.__f35.game.settings.difficulty);
  check(diff === 'ace', 'settings resolve with the edited object and the game applies it', diff);

  // campaign → briefing
  await page.tap('.mm-item[data-id="campaign"]');
  await page.waitForSelector('.scr-missions:not(.is-leaving) .mcard');
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'e2e/screenshots/ui/flow-3-campaign.png' });
  const row = await rectOf(page, '.ml-row');
  const sl0 = await page.evaluate(() => document.querySelector('.ml-row').scrollLeft);
  await t.down(2, row.x + row.w - 60, row.cy);
  await t.move(2, row.x + 60, row.cy, 8);
  await t.up(2);
  await page.waitForTimeout(500);
  const sl1 = await page.evaluate(() => document.querySelector('.ml-row').scrollLeft);
  check(Math.abs(sl1 - sl0) > 40, 'mission cards scroll with a horizontal swipe (and the swipe is not a tap)', `scrollLeft ${Math.round(sl0)} → ${Math.round(sl1)}`);
  check(!!(await page.evaluate(() => document.querySelector('.scr-missions:not(.is-leaving)'))), 'swiping over a card does not open it');
  const lockedCount = await page.evaluate(() => document.querySelectorAll('.mcard.st-locked').length);
  if (lockedCount) {
    await page.evaluate(() => document.querySelector('.mcard.st-locked').scrollIntoView({ inline: 'center' }));
    await page.waitForTimeout(200);
    await page.tap('.mcard.st-locked');
    await page.waitForTimeout(300);
    const stillThere = await page.evaluate(() => !!document.querySelector('.scr-missions:not(.is-leaving)') && !!document.querySelector('.ui-toast'));
    check(stillThere, 'tapping a locked mission shows a toast and stays on the list');
  }
  const openSuggested = async () => {
    await page.evaluate(() => document.querySelector('.scr-missions:not(.is-leaving) .mcard.is-suggested').scrollIntoView({ inline: 'center' }));
    await page.waitForTimeout(200);
    await page.tap('.scr-missions:not(.is-leaving) .mcard.is-suggested');
    await page.waitForSelector('.scr-brief:not(.is-leaving)');
  };
  await openSuggested();
  await page.waitForTimeout(500);
  await page.tap('.scr-brief .back-btn');
  await page.waitForSelector('.scr-missions.kind-campaign:not(.is-leaving) .mcard');
  check(!(await page.$('.scr-main:not(.is-leaving)')), 'campaign briefing back → campaign list');
  await page.waitForTimeout(400);
  await openSuggested();
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'e2e/screenshots/ui/flow-4-briefing.png' });
  const brief = await page.evaluate(() => ({ badge: document.querySelector('.br-diff .badge')?.textContent, map: document.querySelector('.br-map-canvas')?.width }));
  check(brief.badge === 'Ace' && brief.map > 100, 'briefing shows the difficulty label and a drawn intel map', JSON.stringify(brief));
  await page.tap('.br-tab:nth-child(3)');
  await page.waitForTimeout(250);
  const cards = await page.evaluate(() => [...document.querySelectorAll('.lo-card')].map((c) => c.dataset.id));
  check(cards.length >= 1, 'hangar lists the allowed loadouts', cards.join(','));
  if (cards.length > 1) await page.tap(`.lo-card[data-id="${cards[1]}"]`);
  await page.screenshot({ path: 'e2e/screenshots/ui/flow-5-hangar.png' });
  await page.tap('.scr-brief .ui-btn.primary');
  await page.waitForFunction(() => window.__f35.state().inMission, null, { timeout: 120_000 }); // a mission load under a loaded box can pass 60 s
  const lo = await page.evaluate(() => window.__f35.game.session?.loadout ?? null);
  check(cards.length < 2 || lo === cards[1], 'FLY starts the mission with the picked loadout', lo);
  await page.waitForTimeout(1500);

  // pause → quit (two taps) → main menu
  await page.evaluate(() => window.__f35.pause());
  await page.waitForSelector('.scr-pause:not(.is-leaving)');
  const quit = '.scr-pause .pz-btns .ui-btn.danger:last-child';
  await page.tap(quit);
  await page.waitForTimeout(200);
  const armed = await page.evaluate((s) => document.querySelector(s).textContent, quit);
  check(/tap to quit/i.test(armed), 'quit needs confirmation', armed);
  // confirm from the page: under SwiftShader on a busy box a second tap can land after the 2.6 s arm
  // window (frames crawl behind the pause menu), which just re-arms the button. Re-arm first if so.
  await page.evaluate((s) => {
    const b = document.querySelector(s);
    if (!b.classList.contains('is-armed')) b.click();
    b.click();
  }, quit);
  await page.waitForSelector('.scr-main:not(.is-leaving)', { timeout: 15000 });
  check(true, 'quit → back to the main menu');
  if (await page.evaluate(() => window.__f35.state().inMission)) console.log('    note: Game keeps the quit session alive behind the menu (see integration notes)');

  // instant action → briefing → back → back
  await page.waitForTimeout(400);
  await page.tap('.mm-item[data-id="instant"]');
  await page.waitForSelector('.scr-instant:not(.is-leaving)');
  await page.tap('.ia-mode[data-id="sam_gauntlet"]');
  await page.tap('.scr-instant .ui-btn.primary');
  await page.waitForSelector('.scr-brief:not(.is-leaving)');
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'e2e/screenshots/ui/flow-6-ia-briefing.png' });
  check(true, 'instant action → briefing');
  await page.tap('.scr-brief .back-btn');
  await page.waitForSelector('.scr-instant:not(.is-leaving)');
  const mode = await page.evaluate(() => document.querySelector('.scr-instant:not(.is-leaving) .ia-mode.is-on')?.dataset.id);
  check(mode === 'sam_gauntlet', 'briefing back → Instant Action setup (keeps the picked mode)', mode);
  await page.tap('.scr-instant:not(.is-leaving) .back-btn');
  await page.waitForSelector('.scr-main:not(.is-leaving)');
  check(true, 'setup back → main menu');
  // credits
  await page.tap('.mm-item[data-id="credits"]');
  await page.waitForSelector('.scr-credits:not(.is-leaving)');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.scr-main:not(.is-leaving)');
  check(true, 'credits + Escape → main menu');
  // fly() from the main menu (#71): the menu's wait is dropped, and quitting brings the menu back
  await page.waitForTimeout(400);
  const flying = await flyHook(page, 'c01');
  check(flying && !(await page.$('.scr-main:not(.is-leaving)')), 'fly() from the main menu → c01 running, menu gone');
  await page.evaluate(() => window.__f35.pause());
  const paused = await page.waitForSelector('.scr-pause:not(.is-leaving)', { timeout: 30_000 }).then(() => true, () => false);
  if (paused) await quitFromPause(page);
  const menuBack = await page.waitForSelector('.scr-main:not(.is-leaving)', { timeout: 30_000 }).then(() => true, () => false);
  check(paused && menuBack, 'quit the fly() mission → main menu');
  check(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));
  await page.close();
}


/* ───────────────────────── DOM-only gestures (fast page, real timings) ───────────────────────── */
async function lab() {
  console.log('\n[lab] double-tap gestures, left-handed and tilt layouts (ui-lab.html, no WebGL)');
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}labs/ui-lab.html?screen=controls`, { waitUntil: 'load' });
  // wait for the first input.update() to lay the controls out
  await page.waitForFunction(() => (document.querySelector('.ctl-throttle')?.getBoundingClientRect().height ?? 0) > 50);
  await page.evaluate(() => {
    window.__cmds = [];
    for (const c of ['lookReset', 'recenterTilt', 'pause']) window.__input.on(c, () => window.__cmds.push(c));
  });
  if (args.debug) {
    page.on('console', (m) => m.type() === 'log' && console.log('    ·', m.text()));
    await page.evaluate(() => {
      for (const ty of ['pointerdown', 'pointerup', 'pointercancel'])
        document.addEventListener(ty, (e) => console.log(ty, e.pointerId, Math.round(e.timeStamp), Math.round(e.clientX), Math.round(e.clientY), String(e.target.className).slice(0, 30)), true);
    });
  }
  const t = await touchApi(page);
  const thr = () => page.evaluate(() => window.__input.controls.throttle);
  // warm-up touch: the very first input event on a fresh page can take >300 ms to process
  await t.tap(430, 60, 20);
  await page.waitForTimeout(500);
  const h = await rectOf(page, '.thr-handle');
  await t.tap(h.cx, h.cy, 40);
  await page.waitForTimeout(80);
  await t.tap(h.cx, h.cy, 40);
  await page.waitForTimeout(250);
  await settle(page);
  check((await thr()) === 1, 'double-tap throttle → MAX AB', String(await thr()));
  await page.waitForTimeout(400);
  const h2 = await rectOf(page, '.thr-handle');
  await t.tap(h2.cx, h2.cy, 40);
  await page.waitForTimeout(80);
  await t.tap(h2.cx, h2.cy, 40);
  await page.waitForTimeout(250);
  await settle(page);
  check(Math.abs((await thr()) - 0.9) < 1e-9, 'double-tap again → MIL', String(await thr()));
  const abCls = await page.evaluate(() => document.querySelector('.ctl-throttle').className);
  check(!/is-ab/.test(abCls), 'AB styling cleared at MIL', abCls);
  await t.tap(430, 180, 30);
  await page.waitForTimeout(60);
  await t.tap(433, 183, 30);
  await settle(page);
  check((await page.evaluate(() => window.__cmds)).includes('lookReset'), 'double-tap on the view → lookReset');
  await page.close();

  // left-handed: the stick lives bottom-left
  const lh = await ctx.newPage();
  await lh.goto(`${base}labs/ui-lab.html?screen=controls&left=1`, { waitUntil: 'load' });
  await lh.waitForFunction(() => (document.querySelector('.ctl-throttle')?.getBoundingClientRect().height ?? 0) > 50);
  const t2 = await touchApi(lh);
  await t2.down(1, 130, 300);
  await t2.move(1, 70, 300);
  await settle(lh);
  const c = await lh.evaluate(() => ({ ...window.__input.controls }));
  check(c.roll < -0.6, 'left-handed: stick in the lower-left zone (drag left = roll left)', `roll=${c.roll.toFixed(2)}`);
  const thrX = (await rectOf(lh, '.ctl-throttle')).cx;
  check(thrX > 844 / 2, 'left-handed: throttle on the right', `x=${Math.round(thrX)}`);
  await t2.up(1);
  await lh.screenshot({ path: 'e2e/screenshots/ui/touch-left-handed.png' });
  await lh.close();

  // tilt scheme: stick hidden, RECENTER shown and wired
  const tp = await ctx.newPage();
  await tp.goto(`${base}labs/ui-lab.html?screen=controls&tilt=1`, { waitUntil: 'load' });
  await tp.waitForFunction(() => (document.querySelector('.ctl-throttle')?.getBoundingClientRect().height ?? 0) > 50);
  await tp.evaluate(() => {
    window.__cmds = [];
    window.__input.on('recenterTilt', () => window.__cmds.push('recenterTilt'));
  });
  const vis = await tp.evaluate(() => ({
    stick: getComputedStyle(document.querySelector('.ctl-stick')).display,
    rec: getComputedStyle(document.querySelector('.b-recenter')).display,
  }));
  check(vis.stick === 'none' && vis.rec !== 'none', 'tilt: stick hidden, RECENTER visible', JSON.stringify(vis));
  const rc = await rectOf(tp, '.b-recenter');
  const t3 = await touchApi(tp);
  await t3.tap(rc.cx, rc.cy);
  await settle(tp);
  check((await tp.evaluate(() => window.__cmds)).includes('recenterTilt'), 'RECENTER → recenterTilt command');
  // simulated device orientation: landscape (90°), phone tilted back 35° then turned right
  const roll = await tp.evaluate(async () => {
    const fire = (beta, gamma) => window.dispatchEvent(Object.assign(new Event('deviceorientation'), { alpha: 0, beta, gamma }));
    fire(0, -55); // neutral pose for angle 0 portrait-equivalent; recenter uses it
    window.__input.recenterTilt();
    fire(0, -55);
    await new Promise((r) => setTimeout(r, 50));
    fire(20, -55);
    await new Promise((r) => setTimeout(r, 400));
    return window.__input.controls.roll;
  });
  check(Math.abs(roll) > 0.3, 'tilt: orientation change after recenter produces roll', `roll=${roll.toFixed(2)}`);
  await tp.screenshot({ path: 'e2e/screenshots/ui/touch-tilt.png' });
  await tp.close();
  check(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));
}

if (part === 'lab' || part === 'all') await lab();
if (part === 'flight' || part === 'all') await flight();
if (part === 'menus' || part === 'all') await menus();
await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
