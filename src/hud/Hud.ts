/**
 * F35-A — HMD symbology overlay (Canvas2D, DPR aware).
 *
 * The real F-35 has no physical HUD: everything is on the helmet-mounted display. In the cockpit and
 * hud views this draws the full HMD (conformal flight path marker, pitch ladder, targets, weapon cues,
 * threats); external views get a compact "external HUD" with a radar inset; the tactical (MAP) view is a
 * full 2D tactical map. Event-driven feeds (messages, radio subtitles, kill feed, hit markers, G / hit
 * vignettes, missile-defeat tracking) live in HudState.
 *
 * Text is managed in fixed zones (see hmd/layout.ts): warning band top-centre above the FPM, one centre
 * message slot below it, kill feed top-right, objectives / hint top-left, paged radio subtitles between
 * the touch clusters (top-centre in the cockpit view). Symbols that must never be covered (FPM, target
 * box, pipper, the jet) register in an occupancy pass first and every text placer dodges them.
 *
 * Draw modules live in ./hmd/* and share one HudFrame object (no per-frame allocation).
 */
import { Quaternion, Vector3 } from 'three';
import type { CreateHud, FrameContext, HudApi } from '../core/contracts';
import type { WeaponId } from '../core/types';
import { loadHudFont } from './font';
import { drawVesselCounters } from './hmd/escort';
import { drawExternalBlock, drawInset, drawMissileCam } from './hmd/external';
import { WARNING_INFO, WEAPON_BREVITY, armOutcomeText, killText } from './hmd/format';
import { classifyHudMessage } from './hmd/feeds';
import { drawAltColumn, drawBankScale, drawFpm, drawHeadingTape, drawLadder, drawSpeedColumn, drawWaterline } from './hmd/flight';
import { HudState, makeFrame, type HudMode, type HudFrame } from './hmd/frame';
import { hitFlash, stepGEffects } from './hmd/gEffects';
import { computeLayout, makeLayout } from './hmd/layout';
import { Vignettes, drawHint, hintHeight, drawHitMarkers, drawKillFeed, killFeedAt, drawMessages, drawObjectives, drawRadio, reserveMessage, reserveRadio, clearMessagePlan, radioColumnBottom, noteThreatCounts } from './hmd/overlays';
import { paletteFor } from './hmd/palette';
import { drawPcdZoom } from './hmd/pcdOverlay';
import { drawPip, pipLandmarkFocus, pipView, resetPip, resetPodZoom, stepPip, stepPod, tapPip } from './hmd/pip';
import { ASSET_LOSS_HOLD, ASSET_LOSS_WINDOW } from './hmd/assetLoss';
import { drawWpn, reserveWpn, resetWpn, stepWpn, tapWpn, wpnState, wpnView } from './hmd/wpnCam';
import { Pen } from './hmd/pen';
import { PICK_RADIUS, PickRegistry } from './hmd/picking';
import { Projector } from './hmd/projector';
import { TacMapState, drawTacticalMap } from './hmd/tacmap';
import {
  drawContacts,
  drawDesignated,
  drawFriendlies,
  drawGroundAndSams,
  drawLockCone,
  drawOwnMissiles,
  drawWaypoint,
  lockCommandedOf,
  reserveSymbols,
  waypointBearing,
  waypointNamed,
  nextWaypointText,
} from './hmd/targets';
import { damageHeight, drawDamage, drawGcas, drawIncoming, drawRwrEdge, drawWarningBand, reserveIncoming, reserveWarningBand } from './hmd/threats';
import { drawAim9x, drawAirToGround, drawCues, drawDlz, drawGun, drawGunCues, drawSeekerLabel, drawWeaponBlock, planCues, weaponBlockLines } from './hmd/weapons';
import { pcdZoom } from './cockpit/zoom';
import { dasWindow } from './cockpit/das';
import { bandExt, clearBandExt, reserveFixedZones, reservePip, resetZoneExtents, zoneExt } from './hmd/zones';
import { COCKPIT_REST_PITCH, TEST_HOOKS } from '../core/data';
import { cloudBase } from '../core/weather';
import { beginDrawn, drawnLast, type DrawnCue } from './hmd/drawn';

/** An outside camera this close to the jet (m) draws the gun funnel and cross too (chase, orbit), and the own missile's motor glow. */
const GUN_DIR_CAM_RANGE = 120;

const _q = new Quaternion();
const _fwd = new Vector3();
/** Head pitch (rad) below which the HMD declutters to keep the PCD readable (cockpit view). */
const DECLUTTER_START = 0.2;
const DECLUTTER_SPAN = 0.14;
const WARNING_LABELS = new Set(Object.values(WARNING_INFO).map((w) => w.label));
/** Tap radius on the tactical map (smaller than the HMD's so empty-map taps zoom). */
const TAC_PICK_RADIUS = 26;

/** Seconds a lesson's objectives summary waits for the column to stay clear of hints before it shows. */
const OBJ_SETTLE = 0.4;
/** Back from a hint with less than this (s) of its time left, a lesson's summary is done: no short flash of the rest. */
const OBJ_MIN_RUN = 2;

/** A rect in CSS px: left, top, width, height. */
export type HudRect = [number, number, number, number];

/** What the HUD drew last frame (test hooks, `__f35.state().hud`; #118). */
export interface HudLayoutRead {
  /** HUD frame counter of the last drawn frame (HudState.frame). */
  frame: number;
  /** The HUD's animation clock (s): message fades, hint paging, blinking. */
  clock: number;
  visible: boolean;
  mode: HudMode;
  /** Gun LCOS pipper: centre and ring radius (CSS px); null = not drawn. */
  pipper: { x: number; y: number; r: number } | null;
  /** The gun funnel's EEGS range bar (#116): centre, length (CSS px) and the target range (m); null = not drawn. */
  funnelBar: { x: number; y: number; len: number; range: number } | null;
  /** The DAS see-through window cut through the cockpit panel (#116): its target, centre and radius; null = closed. */
  das: { id: number; x: number; y: number; r: number } | null;
  /**
   * Steering waypoint: label, its diamond's centre (null = not drawn), its name's text centre (null = not
   * printed by it), and `next`: the fixed NEXT line (by the heading box / in the info block) names it instead.
   */
  steer: { label: string; diamond: [number, number] | null; name: [number, number] | null; next: boolean } | null;
  /** Centre cue lines (SHOOT, IN RANGE, STEER LEFT, FOX 3…), `drawn` false in a blink's off phase. */
  cues: DrawnCue[];
  /** The designated / locked target: its box as drawn (null = off screen or not drawn). */
  designated: { id: number; rect: HudRect | null } | null;
  /** Every tappable target symbol drawn (contact boxes, ground diamonds, SAM symbols; map symbols in the tactical view). */
  boxes: { id: number; kind: string; rect: HudRect }[];
  /**
   * The weapon window (hmd/wpnCam.ts): strip / video / closed, the weapon shown and its outcome
   * ('flight', 'hit', 'kill', 'miss'…), the rect drawn (video or strip), whether it owns the target
   * camera's slot, and the chips under it.
   */
  wpn: { look: string; focusId: number | null; outcome: string | null; rect: HudRect | null; owns: boolean; chips: string[]; flying: number };
}

/** HUD methods that exist only with the test hooks (Hud.ts attaches them under TEST_HOOKS). */
export interface HudTestHooks {
  layoutRead(): HudLayoutRead;
  /**
   * Advance the HUD's clocks and feeds by ctx.dt without drawing (`__f35.simulate(n, { hud: true })`):
   * message and kill-feed lifetimes, the objectives summary, hint paging, radio subtitles.
   */
  stepClock(ctx: FrameContext): void;
}

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
  const tac = new TacMapState();
  const layoutOpts: { external: boolean; leftHanded: boolean; headPitch: number; pip: boolean } = { external: false, leftHanded: false, headPitch: 0, pip: false };
  const lookupEntity = (id: number) => curWorld?.getEntity(id) ?? null;
  const lastBand = { chx0: NaN, chy0: NaN, chx1: NaN, chy1: NaN };
  /** The last friendly / civil loss, and the asset whose loss failed the mission (its shot takes the slot). */
  const loss = { id: -1, at: -1e9, assetId: -1, assetAt: -1e9 };

  let visible = true;
  let W = Math.max(1, canvas.clientWidth || 1);
  let H = Math.max(1, canvas.clientHeight || 1);
  let reqDpr = 1;
  let dpr = 1;
  let dirty = true;
  let playerTeam: string | null = null;
  let lastMode: HudMode = 'hmd';
  let lastView: FrameContext['viewMode'] | '' = '';
  // threat tracker lookups (bound once: no per-frame closures)
  let curWorld: FrameContext['world'] | null = null;
  let curPlayer: FrameContext['player'] = null;
  const missileAlive = (id: number) => {
    const m = curWorld?.getEntity(id);
    return !!m && m.alive;
  };
  const missileDist = (id: number) => {
    const m = curWorld?.getEntity(id);
    return m && curPlayer ? m.position.distanceTo(curPlayer.position) : Infinity;
  };
  // tap picking in a cluster: one of our missiles is already flying at this contact
  const engagedByPlayer = (id: number) => {
    if (!curWorld || !curPlayer) return false;
    for (const m of curWorld.missiles) if (m.alive && m.shooterId === curPlayer.id && m.targetId === id) return true;
    return false;
  };

  void loadHudFont(() => {
    pen.fontsChanged();
  });

  /* ───────────── events → transient state ───────────── */
  const isPlayer = (id: number | null | undefined) => id != null && id === st.playerId;
  const offs = [
    events.on('hud:message', ({ text, duration, tone }) => {
      if (st.inbox.length < 16) st.inbox.push({ text, tone: tone ?? 'info', duration: duration ?? 2.5 });
    }),
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
    events.on('weapon:denied', ({ ownerId, weapon, reason }) => {
      if (isPlayer(ownerId)) {
        st.deniedText = reason.toUpperCase();
        st.deniedAge = 0;
        st.deniedWeapon = weapon;
      }
    }),
    events.on('destroyed', ({ entity, attackerId }) => {
      if (entity.kind === 'missile' || entity.kind === 'decoy' || isPlayer(entity.id)) return;
      if (entity.team === playerTeam || entity.team === 'neutral') {
        loss.id = entity.id;
        loss.at = curWorld?.time ?? 0;
      }
      if (entity.team === 'neutral') return; // civil losses: the mission callouts announce them
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
    events.on('munition:end', ({ missile, targetId, reason, position }) => {
      st.threats.onMunitionEnd(missile.id, targetId, reason, st.playerId);
      if (missile.shooterId !== st.playerId) return;
      wpnState.tracker.onEnd(missile.id, reason, position);
      if (missile.def.guidance === 'anti_radiation') {
        const o = armOutcomeText(curWorld?.getEntity(targetId) ?? null, reason === 'hit' || reason === 'proximity');
        if (o) st.messages.push(o.text, o.tone, 3);
      }
    }),
    events.on('player:hit', ({ amount }) => hitFlash(st.g, amount)),
    events.on('warning', ({ id, active }) => {
      if (active && id !== 'missile' && id !== 'spike') st.warnAge = 0;
    }),
    events.on('munition:launch', ({ missile, shooter }) => {
      if (!isPlayer(shooter.id)) return;
      const w = missile.def.id as WeaponId;
      st.brevity = WEAPON_BREVITY[w] ?? '';
      st.brevityAge = 0;
      st.launched = w;
    }),
    events.on('mission:end', ({ success }) => {
      // a protected asset lost just now failed the mission: show how it went
      const now = curWorld?.time ?? 0;
      if (!success && loss.id >= 0 && now - loss.at <= ASSET_LOSS_WINDOW) {
        loss.assetId = loss.id;
        loss.assetAt = now;
      }
    }),
    events.on('objective', ({ id }) => {
      st.objShow = 6;
      st.objChangedId = id;
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

  /** Route queued 'hud:message' events to their zones (the mission title is known now). */
  function routeInbox(ctx: FrameContext): void {
    if (st.inbox.length === 0) return;
    const title = ctx.mission?.def?.title ?? null;
    for (const m of st.inbox) {
      // a message repeating a warning-band item ("ENGINE FIRE", "BINGO") is already on screen there
      const r = WARNING_LABELS.has(m.text.trim()) ? 'drop' : classifyHudMessage(m.text, title);
      if (r === 'kill') st.kills.merge(m.text, m.tone);
      else if (r === 'title') {
        st.title = m.text;
        st.titleAge = 0;
        st.titleDur = Math.max(2, Math.min(3.5, m.duration));
      } else if (r === 'centre') st.messages.push(m.text, m.tone, m.duration);
    }
    st.inbox.length = 0;
  }

  /** External views: the jet itself is protected from text (chase / orbit / flyby / target). */
  function protectJet(ctx: FrameContext): void {
    const p = ctx.player;
    if (!p || ctx.viewMode === 'missile') return;
    if (!proj.point(p.position, f.sp) || !f.sp.onScreen) return;
    const d = Math.max(1, f.sp.depth);
    const hw = Math.max(24 * L.u, (7.5 / d) * proj.pxPerRad);
    const hh = Math.max(14 * L.u, (3.5 / d) * proj.pxPerRad);
    f.occ.add(f.sp.x - hw, f.sp.y - hh * 1.6, f.sp.x + hw, f.sp.y + hh, 1);
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
      st.step(ctx.dt, ctx.paused, holdsMessage(ctx.player));
      if (TEST_HOOKS) beginDrawn(st.frame);
      if (!ctx.world || !ctx.camera) {
        // no session (teardown): forget everything from the previous mission
        if (st.playerId !== null) {
          st.reset();
          st.playerId = null;
        }
        tac.active = false;
        resetPip();
        resetWpn();
        picks.begin();
        return;
      }
      const p = ctx.player;
      if (p && p.id !== st.playerId) {
        st.resetPlayer();
        st.playerId = p.id;
        resetWpn();
        resetPodZoom();
        loss.id = loss.assetId = -1;
      }
      playerTeam = p?.team ?? null;
      routeInbox(ctx);
      // missile defeat detection runs in every view (and while the HUD is hidden)
      curWorld = ctx.world;
      curPlayer = p;
      if (p && !ctx.paused) st.threats.update(p.incoming, missileAlive, ctx.dt, missileDist);
      // the player's weapons in flight and their outcomes, likewise in every view
      if (p) wpnState.tracker.update(ctx.world.missiles, p.id, lookupEntity, ctx.world.time, pipView.open ? pipView.targetId : null);
      const mode = modeOf(ctx);
      if (mode !== lastMode || ctx.viewMode !== lastView) resetZoneExtents();
      lastView = ctx.viewMode;
      lastMode = mode;
      if (mode !== 'tactical') tac.active = false;
      if (!visible && mode !== 'tactical') {
        resetPip();
        wpnView.anim = 0;
        wpnView.owns = wpnView.open = false;
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
      // head pitch relative to the rest pose (cockpit view; the rest pose is COCKPIT_REST_PITCH below the
      // nose, and the panel pitches with it): moves the glare-shield line, drives declutter
      let headPitch = 0;
      if (cockpit && p) {
        _q.copy(p.quaternion).invert();
        _fwd.copy(proj.forward).applyQuaternion(_q);
        headPitch = Math.asin(Math.max(-1, Math.min(1, _fwd.y))) + COCKPIT_REST_PITCH;
      }
      layoutOpts.external = mode !== 'hmd';
      layoutOpts.leftHanded = !!ctx.settings.leftHanded;
      layoutOpts.headPitch = headPitch;
      // target camera window: only in views with room for it, and only while there is something to show
      const v = ctx.viewMode;
      const pipAllowed =
        ctx.settings.targetCam !== false && p?.alive === true && (v === 'cockpit' || v === 'hud' || v === 'chase' || v === 'orbit' || v === 'flyby') && !(cockpit && pcdZoom.open);
      // (the Sky Tower being hit or falling opens it too, with nothing designated)
      const pipLandmark = pipLandmarkFocus(ctx.world.landmarks, ctx.world.time);
      // a protected asset lost (the mission failed on it): its shot takes the slot over everything,
      // the target camera setting and the weapon window included
      const slotView = p?.alive === true && (v === 'cockpit' || v === 'hud' || v === 'chase' || v === 'orbit' || v === 'flyby') && !(cockpit && pcdZoom.open);
      const lostLm = pipLandmark && !pipLandmark.alive ? pipLandmark : null;
      const lostEnt = loss.assetId >= 0 && ctx.world.time - loss.assetAt < ASSET_LOSS_HOLD ? lookupEntity(loss.assetId) : null;
      const asset = slotView ? (lostLm ?? lostEnt) : null;
      // the weapon window shares the slot (its own setting; not on the tactical map)
      const wpnSetting = ctx.settings.missileCam ?? 'dynamic';
      const wpnAllowed = wpnSetting !== 'off' && slotView && !asset;
      const wpnWants = wpnAllowed && (wpnView.open || wpnView.owns || wpnState.tracker.tracks.some((t) => t.outcome === 'flight'));
      layoutOpts.pip = (pipAllowed && (pipView.open || pipView.anim > 0 || pipLandmark !== null || (p?.radar.lockedId ?? p?.radar.designatedId ?? null) !== null)) || wpnWants || !!asset;
      computeLayout(L, W, H, ctx.screen.safe, proj.tanHalfV, cockpit, layoutOpts);
      pen.fontScale = L.u;
      picks.begin();
      f.occ.clear();
      f.sym.clear();
      // (the weapon window keeps clear of the caution chips as drawn last frame)
      lastBand.chx0 = bandExt.chx0;
      lastBand.chy0 = bandExt.chy0;
      lastBand.chx1 = bandExt.chx1;
      lastBand.chy1 = bandExt.chy1;
      clearBandExt(); // (the kill feed reads the warning band drawn this frame; none drawn yet)
      dirty = true;

      f.ctx = ctx;
      f.world = ctx.world;
      f.mode = mode;
      f.cockpit = cockpit;
      f.declutter = 1;

      if (!p || !p.alive) {
        resetPip();
        resetWpn();
        // player down: keep the feeds (mission messages, radio, kills); the message makes way for the radio
        reserveRadio(f);
        reserveMessage(f, L.msgY);
        drawMessages(f);
        drawKillFeed(f, L.killX, L.killY);
        drawRadio(f);
        return;
      }
      f.p = p;
      const tid = p.radar.lockedId ?? p.radar.designatedId;
      const t = ctx.world.getEntity(tid);
      f.target = t && t.alive && t.team !== p.team && t.kind !== 'missile' && t.kind !== 'decoy' ? t : null;
      f.locked = !!f.target && p.radar.lockedId === f.target.id;
      f.lockCommanded = !!f.target && !f.locked && lockCommandedOf(p);
      try {
        f.zone = ctx.world.combat.launchZone(p, ctx.world);
      } catch {
        f.zone = null;
      }

      const pipTarget = stepPip(L, f.target, lookupEntity, pipAllowed && L.pipW > 0, ctx.paused ? 0 : ctx.dt, pipLandmark, asset && L.pipW > 0 ? asset : null);
      // a ground target / SAM site: the pod view, with its line of sight (terrain, the overcast deck)
      stepPod(pipView.vh > 0 ? pipTarget : null, p.position, ctx.world.terrain, cloudBase(ctx.mission?.def?.weather ?? 'clear'), ctx.paused ? 0 : ctx.dt);
      // the weapon window: a strip under the target camera, the video in its slot for the last seconds
      // (red cues and the Sky Tower cut keep it a strip); while it owns the slot the target camera is
      // neither rendered nor drawn (its bookkeeping, the DESTROYED hold, carries on underneath)
      const pipShown = pipView.vh > 0;
      const pipTgt = pipShown && !pipView.landmark ? pipView.targetId : null;
      const redCue = p.warnings.has('pull_up') || p.incoming.length > 0 || p.warnings.has('stall') || p.flight.stalled;
      const wpnPlan = stepWpn(
        L,
        { now: ctx.world.time, setting: wpnSetting, suppressed: redCue || (pipShown && !!pipView.landmark) },
        wpnAllowed && mode !== 'tactical' && L.pipW > 0,
        pipShown,
        pipTgt,
        ctx.paused ? 0 : ctx.dt,
        15 * L.u,
        mode === 'hmd' ? L.boxY - 16 * L.u : L.ctlTop - 14 * L.u,
        Number.isFinite(lastBand.chx0) ? lastBand : null,
      );
      if (wpnView.owns) pipView.vh = 0;
      if (mode === 'hmd' && wpnView.bottom > 0) {
        // the DLZ scale moves under the window, strip and chips; the kill feed (right-aligned under the
        // target camera) moves left of them: further down it would run into the altitude column
        if (wpnView.bottom + 60 * L.u < L.dlzBottom) L.dlzTop = Math.max(L.dlzTop, wpnView.bottom + 20 * L.u);
        if (wpnView.bottom > L.killY - 10 * L.u) L.killX = Math.min(L.killX, (wpnView.owns ? wpnView.vx : wpnView.sx) - 10 * L.u);
      }

      if (mode === 'tactical') {
        reserveRadio(f);
        const legendBottom = drawTacticalMap(f, tac);
        // objectives only with the legend open (tap 'i'): the map itself stays clear
        if (tac.legendOpen(st.clock)) drawObjectives(f, L.colX, legendBottom + 10 * L.u, true, Math.min(L.colW, 200 * L.u), 7);
        const critical = drawWarningBand(f);
        const cur = st.messages.current;
        if (!critical || (cur && cur.priority >= 4)) {
          reserveMessage(f, L.msgY);
          drawMessages(f);
        }
        drawKillFeed(f, L.killX, L.killY);
        drawRadio(f);
        return;
      }

      const hmd = mode === 'hmd';
      // vision effects under the symbology (so the HMD stays readable)
      vignettes.draw(f);

      // looking down into the cockpit: fade the flight/target symbology so the PCD stays readable
      let declutter = 1;
      if (cockpit) declutter = Math.max(0, Math.min(1, 1 - (-headPitch - DECLUTTER_START) / DECLUTTER_SPAN));
      f.declutter = declutter;
      g2.globalAlpha = declutter;

      // conformal symbology never spills onto the cockpit panel / PCD (clipped at the glare-shield line)
      if (cockpit) {
        g2.save();
        g2.beginPath();
        g2.rect(0, 0, W, Math.max(0, L.cockpitTop - 2));
        // …except through the DAS window, where the panel isn't drawn (#116)
        if (hmd && dasWindow.active) {
          g2.moveTo(dasWindow.x + dasWindow.r, dasWindow.y);
          g2.arc(dasWindow.x, dasWindow.y, dasWindow.r, 0, Math.PI * 2);
        }
        g2.clip();
        pen.reset();
      }
      // 0) the radio pill first: the target box labels and the centre message make way for it (3.3-a/b);
      // the target camera window likewise
      reserveRadio(f);
      reservePip(f);
      reserveWpn(f);
      // the warning band rows too: the target box's labels, pushed off the FPM, mustn't climb into
      // MISSILE / SPIKE (#116)
      reserveWarningBand(f);
      // 1) protected symbols (they register in the occupancy pass): FPM, the incoming-missile arrows and
      // their TTIs (the target box's labels, off-screen cue and centre cues dodge them), pipper / seeker,
      // target box
      drawFpm(f);
      reserveIncoming(f);
      if (hmd) {
        drawAim9x(f);
        drawGun(f);
      } else {
        protectJet(ctx);
        // the gun pass is flown from the chase view on a phone too (playtest 2.1-c): the pipper (a world
        // point) from any outside camera, the funnel and gun cross (directions) only from one near the jet
        if (ctx.viewMode !== 'missile') drawGun(f, ctx.camera.position.distanceToSquared(p.position) < GUN_DIR_CAM_RANGE * GUN_DIR_CAM_RANGE);
      }
      // the world symbols' boxes (contacts, sites, waypoint, friendlies): the off-screen cue and the
      // centre cues dodge them
      const zoomed = cockpit && pcdZoom.open;
      if (!zoomed) reserveSymbols(f);
      drawDesignated(f);
      drawGunCues(f);
      drawSeekerLabel(f);
      g2.globalAlpha = 1;
      // 1b) fixed text blocks (tape, columns, DLZ, weapon block, objectives / hint, kill feed, external
      // info block + inset): every label placed after this dodges them, the ladder knocks out under them
      reserveFixedZones(f);
      // 2) reserve the centre cue + message slots (they dodge the protected symbols + fixed blocks)
      const critical = holdsMessage(p);
      if (!zoomed) {
        const below = planCues(f);
        const cur = st.messages.current;
        if (!critical || (cur && cur.priority >= 4)) reserveMessage(f, Math.max(L.msgY, below + 10 * L.u));
        else clearMessagePlan();
      } else clearMessagePlan();
      // 3) everything else: secondary labels make way for the reserved text
      g2.globalAlpha = declutter;
      if (hmd) drawLockCone(f);
      g2.globalAlpha = 1;
      drawIncoming(f);
      g2.globalAlpha = declutter;
      drawContacts(f);
      drawGroundAndSams(f);
      drawWaypoint(f);
      if (TEST_HOOKS) drawnLast.steer.next = !waypointNamed(f);
      drawFriendlies(f);
      drawOwnMissiles(f, hmd || (ctx.viewMode !== 'missile' && ctx.camera.position.distanceToSquared(p.position) < GUN_DIR_CAM_RANGE * GUN_DIR_CAM_RANGE));
      if (hmd) drawAirToGround(f);
      g2.globalAlpha = 1;
      drawGcas(f);
      drawRwrEdge(f);
      // the ladder goes last: its rungs and numerals are knocked out under every registered text rect
      if (hmd) {
        g2.globalAlpha = declutter;
        drawLadder(f);
        drawBankScale(f);
        drawWaterline(f);
        g2.globalAlpha = 1;
      }
      if (cockpit) {
        g2.restore();
        pen.reset();
        pen.baseTransform();
        g2.globalAlpha = 1;
        if (hmd && dasWindow.active) drawDasFrame(f);
      }

      let colY: number;
      if (hmd) {
        g2.globalAlpha = declutter;
        drawHeadingTape(f, waypointBearing(f), nextWaypointText(f));
        drawSpeedColumn(f);
        drawAltColumn(f);
        drawDlz(f, L.dlzX, L.dlzTop, L.dlzBottom);
        // weapon block: never runs down into the throttle cluster
        const wy = Math.min(L.wpnY, L.ctlTop - 6 * L.u - weaponBlockLines(f) * L.line);
        zoneExt.wpnTop = wy - 0.6 * L.line;
        zoneExt.wpnBottom = drawWeaponBlock(f, L.wpnX, wy);
        zoneExt.wpnRight = L.wpnX + 150 * L.u;
        g2.globalAlpha = 1;
        colY = radioColumnBottom(f);
      } else {
        zoneExt.extBottom = drawExternalBlock(f);
        zoneExt.extRight = L.extX + 210 * L.u;
        colY = zoneExt.extBottom + 8 * L.u;
        drawInset(f);
        if (ctx.viewMode === 'missile') drawMissileCam(f);
      }
      // the escorted ship's hit counter ("TANKER HITS 1/2") heads the top-left column for the whole sortie,
      // so it never jumps when the objectives come and go — not in the missile / target cams
      const escortTop = colY;
      if (ctx.viewMode !== 'missile' && ctx.viewMode !== 'target') colY = drawVesselCounters(f, L.colX, colY);
      // top-left column: objectives (briefly), damage, mission hint — not in the missile / target cams
      // (the fight fills the frame there)
      const colTop = colY;
      noteThreatCounts(f);
      let objHold = false;
      if (ctx.viewMode !== 'missile' && ctx.viewMode !== 'target') {
        // (never down onto the weapon block, which rises above the throttle cluster on short screens)
        const hintMax = hmd && Number.isFinite(zoneExt.wpnTop) ? Math.min(L.colBottom, zoneExt.wpnTop - 10 * L.u) : L.colBottom;
        // a lesson's hint outranks the objectives summary: when both (and the damage block between them)
        // don't fit under the radio, the summary waits, its time held, until no hint is up — even if a
        // radio call ends meanwhile, so it doesn't toggle with the radio — and then a moment longer,
        // so a hint that arrives just after doesn't flash it (playtest 2026-10-02, 4.2-c); a remainder
        // under OBJ_MIN_RUN is dropped rather than flashed
        if (ctx.mission?.def?.kind === 'training') {
          const need = hintHeight(f, L.colW);
          if (need === 0) st.objYield = false;
          else if (!st.objYield) st.objYield = drawObjectives(f, L.colX, colY, false, L.colW, 6, true) + damageHeight(f) + need > hintMax;
          objHold = st.objYield || st.objFree < OBJ_SETTLE;
          if (!objHold && st.objHold && st.objShow < OBJ_MIN_RUN) st.objShow = 0;
        }
        if (!objHold) colY = drawObjectives(f, L.colX, colY, false, L.colW, 6);
        colY = drawDamage(f, L.colX, colY);
        colY = drawHint(f, L.colX, colY + 2 * L.u, L.colW, hintMax);
      } else colY = drawDamage(f, L.colX, colY);
      st.objHold = objHold;
      zoneExt.colBottom = colY > colTop + 1 ? colY : NaN;
      if (!Number.isFinite(zoneExt.colBottom) && colTop > escortTop + 1) zoneExt.colBottom = colTop; // the counter alone

      // target camera window chrome (the 3D view itself is rendered by Game → TargetCam)
      if (!wpnView.owns) drawPip(f, pipTarget);
      drawWpn(f, wpnPlan, pipTgt);

      // PCD zoom overlay (cockpit): above the symbology, below the warning band and radio
      if (zoomed) drawPcdZoom(f);

      drawWarningBand(f);
      if (!zoomed) {
        drawCues(f);
        drawMessages(f);
      }
      // (HMD: under the target camera window it sits left of the DLZ scale; the right edge under the
      // window is its way out of the warning band)
      const kx = hmd ? L.killX : L.insetCx - L.insetR - 10 * L.u;
      // (not out to the right edge while the weapon window sits there)
      const wpnThere = wpnView.bottom > L.killY - 10 * L.u;
      const kb = drawKillFeed(f, kx, L.killY, hmd && !wpnThere ? L.right : kx);
      zoneExt.killLeft = killFeedAt.x - 230 * L.u;
      zoneExt.killRight = killFeedAt.x;
      zoneExt.killBottom = kb > L.killY + 1 ? kb - 8 * L.u : NaN;
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
      if (lastMode === 'tactical') {
        // tap a symbol = designate it; tap the map = next range (10 / 20 / 40 km)
        if (tac.tapLegend(x, y, st.clock)) return null;
        const id = picks.pick(x, y, TAC_PICK_RADIUS, st.clock, engagedByPlayer);
        if (id == null) tac.cycle();
        return id;
      }
      // the PCD zoom overlay swallows taps (the cockpit handles them first)
      if (pcdZoom.open) return null;
      // a tap on the weapon window shows the next weapon in flight
      if (tapWpn(x, y)) return null;
      // a tap on the pod view (a ground target / SAM site) steps its zoom: WIDE → NARROW → ZOOM
      if (tapPip(x, y)) return null;
      return picks.pick(x, y, PICK_RADIUS, st.clock, engagedByPlayer);
    },

    dispose() {
      resetPip();
      resetWpn();
      for (const off of offs) off();
      offs.length = 0;
      clear();
      picks.begin();
    },
  };
  if (TEST_HOOKS) {
    const hooks: HudTestHooks = {
      layoutRead() {
        // (the records of the last update: a hidden HUD or a no-player frame leaves them empty; stepClock
        // doesn't touch them)
        const { pipper: pp, steer: sw } = drawnLast;
        const r1 = (v: number) => Math.round(v * 10) / 10;
        const rect = (x: number, y: number, r: number): HudRect => [r1(x - r), r1(y - r), r1(2 * r), r1(2 * r)];
        const boxes = picks.entries().map((e) => ({ id: e.id, kind: curWorld?.getEntity(e.id)?.kind ?? '?', rect: rect(e.x, e.y, e.r) }));
        const p = curPlayer;
        const tid = p ? (p.radar.lockedId ?? p.radar.designatedId) : null;
        return {
          frame: drawnLast.frame,
          clock: st.clock,
          visible,
          mode: lastMode,
          pipper: pp.drawn ? { x: r1(pp.x), y: r1(pp.y), r: r1(pp.r) } : null,
          funnelBar: drawnLast.funnelBar.drawn ? { x: r1(drawnLast.funnelBar.x), y: r1(drawnLast.funnelBar.y), len: r1(drawnLast.funnelBar.len), range: Math.round(drawnLast.funnelBar.range) } : null,
          das: visible && dasWindow.active ? { id: dasWindow.id, x: r1(dasWindow.x), y: r1(dasWindow.y), r: r1(dasWindow.r) } : null,
          steer: sw.label ? { label: sw.label, diamond: sw.diamond ? [r1(sw.x), r1(sw.y)] : null, name: sw.named ? [r1(sw.nameX), r1(sw.nameY)] : null, next: sw.next } : null,
          cues: drawnLast.cues.slice(0, drawnLast.cueCount).map((c) => ({ ...c, x: r1(c.x), y: r1(c.y) })),
          designated: tid == null ? null : { id: tid, rect: boxes.find((b) => b.id === tid)?.rect ?? null },
          boxes,
          wpn: (() => {
            const v = wpnView;
            const plan = wpnState.plan;
            const fo = plan?.focus ?? null;
            const r: HudRect | null = v.owns && v.vh > 0 ? [v.vx, v.vy, v.vw, v.vh] : v.sw > 0 ? [v.sx, v.sy, v.sw, v.sh] : null;
            return {
              look: v.owns && v.vh > 0 ? 'video' : v.open ? v.look : 'closed',
              focusId: fo?.id ?? null,
              outcome: fo?.outcome ?? null,
              rect: r,
              owns: v.owns,
              chips: (plan?.chips ?? []).map((c) => (c.label === '' ? `+${c.count}` : `${c.label}${c.count > 1 ? ' x' + c.count : ''} ${c.outcome === 'flight' ? Math.round(c.tti * 10) / 10 : c.outcome}`)),
              flying: plan?.flying ?? 0,
            };
          })(),
        };
      },
      stepClock(ctx) {
        st.step(ctx.dt, false, holdsMessage(ctx.player));
        const p = ctx.player;
        if (p && p.id !== st.playerId) {
          st.resetPlayer();
          st.playerId = p.id;
        }
        playerTeam = p?.team ?? null;
        curWorld = ctx.world;
        curPlayer = p;
        routeInbox(ctx);
        if (p) st.threats.update(p.incoming, missileAlive, ctx.dt, missileDist);
      },
    };
    Object.assign(hud, hooks);
  }
  return hud;
};

/** The DAS window's frame: a thin ring round the hole in the panel and its 'DAS' tag on top (#116). */
/** A life-critical warning (PULL UP, MISSILE, STALL) holds the centre message back (priority 4+ shows through). */
function holdsMessage(p: FrameContext['player']): boolean {
  return !!p && (p.warnings.has('pull_up') || p.incoming.length > 0 || p.warnings.has('stall') || p.flight.stalled);
}

function drawDasFrame(f: HudFrame): void {
  const { pen, pal, L } = f;
  const d = dasWindow;
  pen.setDash('solid');
  pen.begin();
  pen.circle(d.x, d.y, d.r);
  pen.strokeGlow(pal.dim, 1.4);
  pen.box(d.x - 16 * L.u, d.y - d.r - 8 * L.u, 32 * L.u, 15 * L.u, pal.dim, 1.2, pal.back);
  pen.text('DAS', d.x, d.y - d.r - 0.5 * L.u, pal.main, 11, 'center');
}
