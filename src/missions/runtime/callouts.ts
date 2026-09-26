/**
 * F35-A — kill / loss callouts and mission bookkeeping driven by sim events:
 *  - player air kill: "Splash one!" (p_splash) + "SPLASH MIG-29", now and then Darkstar "Good kill"
 *  - player ground / SAM kill: "Target destroyed." (p_target_destroyed) + "SA-6 SITE DESTROYED"
 *  - wingman kills, friendly losses ("Friendly down!"), SAM engagement flag, player down.
 *
 * Also the debrief bookkeeping (MissionState.stats): what hit the player last, AMRAAM shots fired
 * before the SHOOT cue, missiles that missed, gun kills.
 *
 * The EventBus outlives a mission: MissionRunner.dispose() (called by Game on teardown) detaches
 * every handler. As a second line of defence each handler also checks that its world is still
 * alive (a disposed world has no player) and detaches itself otherwise.
 */
import type { GameEventMap } from '../../core/events';
import { AircraftEntity, type AnyEntity } from '../../sim/entities';
import { aircraftHudName, killHudText } from './names';
import type { MissionState } from './state';

export type DownReason = GameEventMap['player:down']['reason'];

export class Callouts {
  private unsubs: (() => void)[] = [];
  private playerAirKills = 0;

  constructor(
    private readonly s: MissionState,
    private readonly onPlayerDown: (reason: DownReason) => void,
  ) {}

  attach(): void {
    const ev = this.s.events;
    this.unsubs.push(
      ev.on('destroyed', (e) => this.guard() && this.onDestroyed(e.entity, e.attackerId, e.weapon)),
      ev.on('munition:launch', (e) => {
        if (!this.guard()) return;
        const p = this.s.player;
        if (p && e.targetId === p.id && e.shooter.kind === 'sam') this.s.samEngaged = true;
      }),
      ev.on('gun:state', (e) => {
        if (!this.guard() || !e.firing || e.weapon !== 'zsu23') return;
        const p = this.s.player;
        if (p && p.alive && e.position.distanceTo(p.position) < 4000) this.s.samEngaged = true;
      }),
      ev.on('player:down', (e) => {
        if (!this.guard()) return;
        this.s.stats.downReason = e.reason;
        this.onPlayerDown(e.reason);
      }),
      ev.on('damage', (e) => {
        if (!this.guard()) return;
        const p = this.s.player;
        if (!p || e.target !== p || e.attackerId === null) return;
        const a = this.s.world.getEntity(e.attackerId);
        const st = this.s.stats;
        st.lastHitWeapon = e.weapon;
        st.lastHitBy = a ? (a.kind === 'aircraft' ? 'aircraft' : a.kind === 'sam' ? 'sam' : a.kind === 'ground' ? 'ground' : null) : null;
        st.lastHitType = a && (a.kind === 'aircraft' || a.kind === 'sam' || a.kind === 'ground') ? a.type : null;
      }),
      ev.on('munition:launch', (e) => {
        if (!this.guard()) return;
        const p = this.s.player;
        if (!p || e.shooter !== p || e.missile.def.category !== 'aam') return;
        const st = this.s.stats;
        st.aamShots++;
        const t = this.s.world.getEntity(e.targetId);
        if (!t || !t.alive || e.missile.def.id !== 'aim120') return;
        // fired before the calibrated SHOOT cue (CombatLaunchZone.rShoot) → a long, low-Pk shot
        const z = this.s.world.combat.launchZoneFor(p, 'aim120', t, this.s.world) as { range: number; rShoot?: number; rMax: number };
        const shootRange = z.rShoot && z.rShoot > 0 ? z.rShoot : z.rMax * 0.7;
        if (z.range > shootRange * 1.08) st.longShots++;
      }),
      ev.on('munition:end', (e) => {
        if (!this.guard()) return;
        const p = this.s.player;
        if (!p || e.missile.shooterId !== p.id || e.missile.def.category !== 'aam') return;
        if (e.reason === 'decoyed' || e.reason === 'selfdestruct' || e.reason === 'ground' || e.reason === 'water') this.s.stats.misses++;
      }),
    );
  }

  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  /** False (and detached) once our world has been disposed (mission torn down). */
  private guard(): boolean {
    const w = this.s.world;
    if (!w || !w.player || w.player !== this.s.player) {
      this.detach();
      return false;
    }
    return true;
  }

  private belongsToUs(e: AnyEntity): boolean {
    return this.s.world.getEntity(e.id) === e;
  }

  private onDestroyed(entity: AnyEntity, attackerId: number | null, weapon: GameEventMap['destroyed']['weapon']): void {
    const s = this.s;
    if (entity.kind === 'missile' || entity.kind === 'decoy') return;
    if (!this.belongsToUs(entity)) return;
    const p = s.player;
    if (!p || entity === p) return;
    const running = s.state === 'running';
    const attacker = s.world.getEntity(attackerId);
    const byPlayer = attackerId !== null && attackerId === p.id;

    if (entity.team !== p.team) {
      if (byPlayer) {
        if (entity.kind === 'aircraft' && running && weapon === 'gun') s.stats.gunKills++;
        if (running) {
          if (entity.kind === 'aircraft') s.kills.air++;
          else if (entity.kind === 'sam') s.kills.sam++;
          else s.kills.ground++;
        }
        s.hud(killHudText(entity), 'good', 2.5);
        if (entity.kind === 'aircraft') {
          this.playerAirKills++;
          s.radio.push({ from: s.callsign, text: 'Splash one!', voice: 'p_splash', priority: 3 });
          if (this.playerAirKills === 1 || this.playerAirKills % 2 === 0) {
            s.radio.push({ from: s.awacsCallsign, text: 'Good kill, good kill.', voice: 'a_good_kill', priority: 2 });
          }
        } else {
          s.radio.push({ from: s.callsign, text: 'Target destroyed.', voice: 'p_target_destroyed', priority: 3 });
        }
      } else if (s.scriptedStrike) {
        // scripted package strike: the trigger's own radio call covers it
      } else if (attacker instanceof AircraftEntity && attacker.team === p.team) {
        // wingman / friendly package kill: HUD line only — AI pilots make their own "Splash one!" call
        const who = attacker.callsign.toUpperCase();
        s.hud(`${who}: ${entity.kind === 'aircraft' ? `SPLASH ${aircraftHudName(entity.type)}` : killHudText(entity)}`, 'info', 2.5);
      } else if (entity.kind === 'aircraft' && p.alive && entity.position.distanceTo(p.position) < 40_000) {
        s.hud(`${aircraftHudName(entity.type)} DOWN`, 'info', 2);
      }
      return;
    }

    // Friendly losses
    if (entity.kind === 'aircraft') {
      if (running) s.friendlyLosses++;
      s.hud('FRIENDLY DOWN', 'bad', 3);
      s.radio.push({ from: s.awacsCallsign, text: `Friendly down! ${entity.callsign} is down.`, voice: 'a_friendly_down', priority: 4 });
    } else {
      s.hud(`FRIENDLY ${killHudText(entity)}`, 'bad', 3);
    }
  }
}
