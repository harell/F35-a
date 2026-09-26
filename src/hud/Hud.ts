/**
 * F35-A — HMD symbology overlay (Canvas2D, DPR aware).
 *
 * The real F-35 has no physical HUD: everything is on the helmet-mounted display. In the cockpit and
 * hud views this draws the full HMD (conformal flight path marker, pitch ladder, targets, weapon cues,
 * threats); external views get a compact "external HUD" with a radar inset; the tactical map only gets a
 * minimal label/objective overlay. Event-driven feeds (messages, radio subtitles, kill feed, hit markers,
 * G / hit vignettes) live in HudState.
 *
 * Draw modules live in ./hmd/* and share one HudFrame object (no per-frame allocation).
 */
import type { CreateHud, FrameContext, HudApi } from '../core/contracts';
import type { WeaponId } from '../core/types';
import { loadHudFont } from './font';
import { drawExternalBlock, drawInset, drawMissileCam, drawTacticalOverlay } from './hmd/external';
import { WARNING_INFO, WEAPON_BREVITY, killText } from './hmd/format';
import { drawAltColumn, drawBankScale, drawFpm, drawHeadingTape, drawLadder, drawSpeedColumn, drawWaterline } from './hmd/flight';
import { HudState, makeFrame, type HudMode } from './hmd/frame';
import { hitFlash, stepGEffects } from './hmd/gEffects';
import { computeLayout, makeLayout } from './hmd/layout';
import { Vignettes, drawHint, drawHitMarkers, drawKillFeed, drawMessages, drawObjectives, drawRadio } from './hmd/overlays';
import { paletteFor } from './hmd/palette';
import { Pen } from './hmd/pen';
import { PickRegistry } from './hmd/picking';
import { Projector } from './hmd/projector';
import { drawContacts, drawDesignated, drawFriendlies, drawGroundAndSams, drawOwnMissiles, drawWaypoint, waypointBearing } from './hmd/targets';
import { drawDamage, drawIncoming, drawRwrEdge, drawWarnings } from './hmd/threats';
import { drawAim9x, drawAirToGround, drawBrevity, drawDlz, drawGun, drawShootCue, drawWeaponBlock } from './hmd/weapons';

export const createHud: CreateHud = (canvas, events) => {
  const g2 = canvas.getContext('2d', { alpha: true });
  if (!g2) throw new Error('[hud] 2D canvas context unavailable');
  const pen = new Pen(g2);
  const proj = new Projector();
  const picks = new PickRegistry();
  const st = new HudState();
  const L = makeLayout();
  const f = makeFrame(pen, proj, picks, st, L, paletteFor('green'));
  const vignettes = new Vignettes();

  let visible = true;
  let W = Math.max(1, canvas.clientWidth || 1);
  let H = Math.max(1, canvas.clientHeight || 1);
  let reqDpr = 1;
  let dpr = 1;
  let dirty = true;
  let playerTeam: string | null = null;

  void loadHudFont(() => {
    pen.fontsChanged();
  });

  /* ───────────── events → transient state ───────────── */
  const isPlayer = (id: number | null | undefined) => id != null && id === st.playerId;
  const offs = [
    events.on('hud:message', ({ text, duration, tone }) => st.messages.push(text, tone ?? 'info', duration ?? 2.5)),
    events.on('radio', ({ from, text, priority, team }) => st.radio.push(from, text, priority ?? 0, team)),
    events.on('lock', ({ ownerId, targetId, locked }) => {
      if (isPlayer(ownerId) && locked) {
        st.lockAge = 0;
        st.lockId = targetId;
      }
    }),
    events.on('designate', ({ ownerId }) => {
      if (isPlayer(ownerId)) st.dlzScale = 0;
    }),
    events.on('weapon:select', ({ ownerId }) => {
      if (isPlayer(ownerId)) {
        st.weaponAge = 0;
        st.dlzScale = 0;
      }
    }),
    events.on('weapon:denied', ({ ownerId, reason }) => {
      if (isPlayer(ownerId)) {
        st.deniedText = reason.toUpperCase();
        st.deniedAge = 0;
      }
    }),
    events.on('destroyed', ({ entity, attackerId }) => {
      if (entity.kind === 'missile' || entity.kind === 'decoy' || isPlayer(entity.id)) return;
      if (isPlayer(attackerId) && entity.team !== playerTeam) {
        const t = killText(entity);
        if (t) st.kills.push(t, 'good');
        st.addHit(entity.id, true);
      } else if (entity.team === playerTeam && entity.kind === 'aircraft') {
        st.kills.push(((entity.callsign || entity.name) + ' DOWN').toUpperCase(), 'bad');
      } else if (entity.team !== playerTeam && attackerId != null) {
        const t = killText(entity);
        if (t) st.kills.push(t, 'info');
      }
    }),
    events.on('damage', ({ target, attackerId }) => {
      if (!isPlayer(attackerId) || target.team === playerTeam) return;
      if (target.kind === 'aircraft' || target.kind === 'sam' || target.kind === 'ground') st.addHit(target.id, false);
    }),
    events.on('player:hit', ({ amount }) => hitFlash(st.g, amount)),
    events.on('warning', ({ id, active }) => {
      if (active && WARNING_INFO[id] && WARNING_INFO[id].level >= 1) st.warnAge = 0;
    }),
    events.on('munition:launch', ({ missile, shooter }) => {
      if (!isPlayer(shooter.id)) return;
      const w = missile.def.id as WeaponId;
      st.brevity = WEAPON_BREVITY[w] ?? '';
      st.brevityAge = 0;
    }),
    events.on('objective', () => {
      st.objShow = 7;
    }),
  ];

  function applySize(): void {
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    pen.dpr = dpr;
    pen.reset();
  }

  function clear(): void {
    g2!.setTransform(1, 0, 0, 1, 0, 0);
    g2!.clearRect(0, 0, canvas.width, canvas.height);
  }

  function modeOf(ctx: FrameContext): HudMode {
    const v = ctx.viewMode;
    if (v === 'tactical') return 'tactical';
    if (v === 'cockpit' || v === 'hud') return 'hmd';
    return 'external';
  }

  const hud: HudApi = {
    update(ctx) {
      // low quality: cap the overlay resolution
      const want = ctx.quality?.level === 'low' ? Math.min(reqDpr, 1.5) : reqDpr;
      if (want !== dpr) {
        dpr = want;
        applySize();
      }
      if (dirty) clear();
      dirty = false;
      st.step(ctx.dt, ctx.paused);
      if (!ctx.world || !ctx.camera) {
        picks.begin();
        return;
      }
      const p = ctx.player;
      if (p && p.id !== st.playerId) {
        st.reset();
        st.playerId = p.id;
      }
      playerTeam = p?.team ?? null;
      const mode = modeOf(ctx);
      if (!visible && mode !== 'tactical') {
        picks.begin();
        return;
      }
      if (p) stepGEffects(st.g, p.alive ? p.flight.gLoad : 1, ctx.paused ? 0 : ctx.dt, mode === 'hmd' && !!ctx.world.difficulty?.gEffects);

      const pal = paletteFor(ctx.settings.hudColor);
      f.pal = pal;
      pen.outline = pal.outline;
      pen.baseTransform();
      proj.update(ctx.camera, W, H);
      const cockpit = ctx.viewMode === 'cockpit';
      computeLayout(L, W, H, ctx.screen.safe, proj.tanHalfV, cockpit);
      pen.fontScale = L.u;
      picks.begin();
      dirty = true;

      f.ctx = ctx;
      f.world = ctx.world;
      f.mode = mode;
      f.cockpit = cockpit;

      if (!p || !p.alive) {
        // player down: keep the feeds (mission messages, radio, kills)
        drawMessages(f, L.msgY);
        drawKillFeed(f, L.killX, L.killY);
        drawRadio(f);
        return;
      }
      f.p = p;
      const tid = p.radar.lockedId ?? p.radar.designatedId;
      const t = ctx.world.getEntity(tid);
      f.target = t && t.alive && t.team !== p.team && t.kind !== 'missile' && t.kind !== 'decoy' ? t : null;
      f.locked = !!f.target && p.radar.lockedId === f.target.id;
      try {
        f.zone = ctx.world.combat.launchZone(p, ctx.world);
      } catch {
        f.zone = null;
      }

      if (mode === 'tactical') {
        drawTacticalOverlay(f);
        drawObjectives(f, L.objX, L.objY + 16 * L.u, true);
        drawMessages(f, L.msgY);
        drawKillFeed(f, L.killX, L.killY);
        drawRadio(f);
        return;
      }

      const hmd = mode === 'hmd';
      // vision effects under the symbology (so the HMD stays readable)
      vignettes.draw(f);

      drawFpm(f);
      if (hmd) {
        drawLadder(f);
        drawBankScale(f);
        drawWaterline(f);
      }
      drawWaypoint(f);
      drawFriendlies(f);
      drawGroundAndSams(f);
      drawContacts(f);
      drawOwnMissiles(f);
      drawDesignated(f);
      if (hmd) {
        drawAim9x(f);
        drawGun(f);
      }
      const missileBanner = drawIncoming(f);
      drawRwrEdge(f);

      let leftY: number;
      if (hmd) {
        drawHeadingTape(f, waypointBearing(f));
        drawSpeedColumn(f);
        drawAltColumn(f);
        drawDlz(f, L.dlzX, L.dlzTop, L.dlzBottom);
        drawWeaponBlock(f, L.wpnX, L.wpnY);
        leftY = drawObjectives(f, L.objX, L.objY);
        drawHint(f, L.hintY);
      } else {
        leftY = drawExternalBlock(f) + 6 * L.u;
        leftY = drawObjectives(f, L.extX, leftY);
        drawInset(f);
        if (ctx.viewMode === 'missile') drawMissileCam(f);
        else drawHint(f, L.H * 0.2);
      }
      drawDamage(f, hmd ? L.objX : L.extX, leftY + 8 * L.u);

      // centre stack
      let y = L.stackY;
      y = drawShootCue(f, y);
      if (hmd) y = drawAirToGround(f, y);
      y = drawBrevity(f, y);
      drawWarnings(f, y);

      drawMessages(f, L.msgY + (missileBanner ? 30 * L.u : 0));
      drawKillFeed(f, hmd ? L.killX : L.insetCx - L.insetR - 10 * L.u, L.killY);
      drawHitMarkers(f);
      drawRadio(f);
    },

    resize(width, height, d) {
      W = Math.max(1, width);
      H = Math.max(1, height);
      reqDpr = Math.max(1, Math.min(3, d || 1));
      dpr = reqDpr;
      applySize();
      dirty = true;
    },

    setVisible(v) {
      visible = v;
      if (!v) {
        clear();
        picks.begin();
      }
    },

    pick(x, y) {
      return picks.pick(x, y);
    },

    dispose() {
      for (const off of offs) off();
      offs.length = 0;
      clear();
      picks.begin();
    },
  };
  return hud;
};
