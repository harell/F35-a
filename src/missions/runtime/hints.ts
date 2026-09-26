/**
 * F35-A — contextual HUD hints: scripted HintDefs plus built-in "auto hints" that react to
 * what the player is doing (training + early campaign): designate, shoot, defend against a
 * missile, go low under the SA-10, strike designation, guns, energy.
 */
import type { AircraftEntity } from '../../sim/entities';
import { evalCondition } from './conditions';
import { aircraftHudName } from './names';
import type { MissionState } from './state';

interface AutoHint {
  id: string;
  /** Returns the hint text when it applies, else null. */
  test(p: AircraftEntity, s: MissionState): string | null;
}

const SHOW_TIME = 6;
const COOLDOWN = 25;
const MAX_SHOWS = 3;

function nearestLiveSam(s: MissionState, p: AircraftEntity, type: string, within: number): boolean {
  for (const site of s.world.sams) {
    if (!site.alive || site.team === p.team || site.type !== type) continue;
    if (Math.hypot(site.position.x - p.position.x, site.position.z - p.position.z) < within) return true;
  }
  return false;
}

function hasAg(p: AircraftEntity): boolean {
  for (const st of p.stores) if (st.count > 0 && (st.weapon === 'gbu31' || st.weapon === 'gbu39')) return true;
  return false;
}

function designatedEntityKind(p: AircraftEntity, s: MissionState) {
  const e = s.world.getEntity(p.radar.designatedId);
  return e && e.alive && e.team !== p.team ? e : null;
}

/** Built-in hints, in priority order. */
const AUTO: AutoHint[] = [
  {
    id: 'defend',
    test(p) {
      if (p.incoming.length === 0) return null;
      const ir = p.incoming[0].guidance === 'ir';
      return ir ? 'MISSILE! Pop FLARES and break hard into it' : 'MISSILE! Drop CHAFF and turn 90° to the missile to notch it';
    },
  },
  {
    id: 'sa10_low',
    test(p, s) {
      if (p.flight.agl < 150 || !nearestLiveSam(s, p, 'sa10', 40_000)) return null;
      return 'Fly below 300 ft to hide from the SA-10 — use the terrain to mask you';
    },
  },
  {
    id: 'speed',
    test(p) {
      return p.warnings.has('speed_low') || p.warnings.has('stall') ? 'Too slow — push the THROTTLE forward and ease off the stick' : null;
    },
  },
  {
    id: 'designate_air',
    test(p, s) {
      if (p.radar.designatedId !== null) return null;
      const w = p.selectedWeapon;
      if (w !== 'aim120' && w !== 'aim9x' && w !== 'gun') return null;
      for (const c of p.radar.contacts) {
        if (c.team === p.team) continue;
        const e = s.world.getEntity(c.id);
        if (e && e.alive && e.kind === 'aircraft') return `Tap TGT to designate the ${aircraftHudName(e.type)}`;
      }
      return null;
    },
  },
  {
    id: 'shoot',
    test(p, s) {
      const e = designatedEntityKind(p, s);
      if (!e || e.kind !== 'aircraft') return null;
      const r = e.position.distanceTo(p.position);
      if (p.selectedWeapon === 'aim120' && r < 35_000) return 'Fire AMRAAM when SHOOT flashes — then keep the target in front';
      if (p.selectedWeapon === 'aim9x' && r < 8_000) return 'Look at the bandit: fire the AIM-9X on the lock tone';
      if (p.selectedWeapon === 'gun' && r < 1_500) return 'GUNS: put the pipper on the bandit and hold FIRE';
      return null;
    },
  },
  {
    id: 'strike',
    test(p, s) {
      if (!hasAg(p)) return null;
      const w = p.selectedWeapon;
      const ag = w === 'gbu31' || w === 'gbu39';
      if (!ag) {
        // only nag when a ground objective is reasonably close
        for (const g of s.world.ground) if (g.alive && g.team !== p.team && g.position.distanceTo(p.position) < 30_000) return 'Open the bays: JDAM needs ground designation — tap WPN to select JDAM, then TGT';
        return null;
      }
      if (!p.radar.groundPoint) return 'Tap TGT to designate a ground target for the GPS bombs';
      return 'Release inside the range cue — the bomb flies itself to the target';
    },
  },
  {
    id: 'aargm',
    test(p, s) {
      if (p.selectedWeapon !== 'aargm') return null;
      const e = designatedEntityKind(p, s);
      if (e && e.kind === 'sam') return null;
      return 'AARGM homes on radar: designate an emitting SAM with TGT, then fire';
    },
  },
];

export class HintSystem {
  /** Current text (MissionRunnerApi.hint). */
  current: string | null = null;
  private currentId = '';
  private shownAt = -999;
  private currentDuration = SHOW_TIME;
  private readonly lastShown = new Map<string, number>();
  private readonly shows = new Map<string, number>();
  private readonly scriptedDone = new Set<string>();
  /** A trigger-pushed hint (overrides everything until it expires). */
  private forced: { text: string; until: number } | null = null;

  constructor(private readonly s: MissionState) {}

  /** Trigger action: show a hint now. */
  force(text: string, duration = 8): void {
    this.forced = { text, until: this.s.time + duration };
  }

  clear(): void {
    this.current = null;
    this.forced = null;
  }

  update(): void {
    const s = this.s;
    const t = s.time;
    const p = s.player;
    if (s.state !== 'running' || !p || !p.alive) {
      this.current = null;
      return;
    }
    if (this.forced) {
      if (t < this.forced.until) {
        this.current = this.forced.text;
        return;
      }
      this.forced = null;
    }

    // keep the current hint on screen for its duration while it still applies
    if (this.current && t - this.shownAt < this.currentDuration) {
      if (this.currentId.startsWith('script:')) return;
      const rule = AUTO.find((r) => r.id === this.currentId);
      const text = rule?.test(p, s);
      if (text) {
        this.current = text;
        return;
      }
    }
    this.current = null;
    this.currentId = '';

    // scripted hints (each shown once)
    for (const h of s.script.hints ?? []) {
      if (this.scriptedDone.has(h.id)) continue;
      if (h.until && evalCondition(h.until, s)) {
        this.scriptedDone.add(h.id);
        continue;
      }
      if (evalCondition(h.when, s)) {
        this.scriptedDone.add(h.id);
        this.show(`script:${h.id}`, h.text, h.duration ?? 8);
        return;
      }
    }

    if (!s.script.autoHints) return;
    for (const rule of AUTO) {
      const n = this.shows.get(rule.id) ?? 0;
      if (n >= MAX_SHOWS) continue;
      if (t - (this.lastShown.get(rule.id) ?? -999) < COOLDOWN) continue;
      const text = rule.test(p, s);
      if (!text) continue;
      this.shows.set(rule.id, n + 1);
      this.show(rule.id, text, SHOW_TIME);
      return;
    }
  }

  private show(id: string, text: string, duration: number): void {
    this.current = text;
    this.currentId = id;
    this.shownAt = this.s.time;
    this.currentDuration = duration;
    this.lastShown.set(id, this.s.time);
  }
}
