/**
 * F35-A — protected landmarks in the mission runtime: the Auckland Sky Tower.
 *
 * Every Auckland sortie stands up a new, intact tower as a sim landmark: it is never destroyed for
 * good (issue #75), so a start or restart always finds it standing, whatever happened before.
 *  - An enemy hit (sim/landmarks.ts hitSkyTower) leaves it damaged and burning: AWACS calls it, the
 *    HUD flags it, and the sortie goes on. A one-way drone (Shahed-136) that flies into it is such a
 *    hit: the sim reports the impact ('drone:impact' with the landmark) and this watch registers it.
 *  - The second enemy hit brings it down: the mission fails with REASONS.skytowerLost.
 *  - The player bringing it down (one bomb or missile, whatever its damage) is an immediate failure
 *    in every mode: AWACS calls check fire, the HUD flags it, and the runner
 *    fails with REASONS.skytower while the collapse plays on.
 *  - The player's jet flying into it brings it down at once (sim/damage/Collisions.ts): the crash ends
 *    the sortie ("Crashed into the Sky Tower") and the collapse plays on.
 *  - Free flight (script.freeFlight) never fails over it: the tower comes down and the sortie goes on.
 *
 * It also calls out every other building the player's jet brings down ('building:collapsed'): Spark Arena, the
 * Auckland Museum, a span of the Harbour Bridge or a CBD tower, AWACS and the HUD name it (sim/buildings.ts names).
 */
import type { MunitionId } from '../../core/types';
import { createSkyTower, hitLandmark, type LandmarkCollapseCause, type LandmarkEntity } from '../../sim/landmarks';
import { AKL } from '../../core/auckland';
import { URGENT_PRIORITY } from './radio';
import { REASONS, sentenceName } from './reasons';
import type { MissionState } from './state';

export class LandmarkWatch {
  private unsubs: (() => void)[] = [];
  /** The tower this sortie stood up (null outside Auckland). */
  tower: LandmarkEntity | null = null;

  constructor(
    private readonly s: MissionState,
    /** Fails the mission with the given reason. */
    private readonly fail: (reason: string) => void,
  ) {}

  setup(): void {
    const s = this.s;
    if (s.def.theater !== 'auckland') return;
    const { x, z } = AKL.skytower;
    this.tower = createSkyTower(s.world.terrain.surfaceHeightAt(x, z));
    s.world.landmarks.push(this.tower);
    this.unsubs.push(
      s.events.on('landmark:damaged', ({ landmark }) => {
        if (landmark === this.tower && !s.disposed) this.onDamaged();
      }),
      s.events.on('landmark:destroyed', ({ landmark, cause, weapon, attackerId }) => {
        if (landmark === this.tower && !s.disposed) this.onDestroyed(cause, weapon, attackerId);
      }),
      // a building the player's jet flew into (sim/buildings.ts): named on the radio and the HUD, a landmark or a
      // CBD tower alike
      s.events.on('building:collapsed', ({ name, label, isPlayer }) => {
        if (!isPlayer || s.disposed) return;
        s.radio.push({ from: s.awacsCallsign, text: `${name ? sentenceName(name) : 'A building'} has been destroyed! ${s.callsign} went straight into it.`, priority: URGENT_PRIORITY });
        s.hud(`${label ?? 'BUILDING'} DESTROYED`, 'bad', 5);
      }),
      // a Shahed's warhead goes off against the tower: an enemy hit (the second one brings it down)
      s.events.on('drone:impact', ({ drone, position, landmark }) => {
        if (landmark === this.tower && this.tower && !s.disposed) hitLandmark(this.tower, s.events, s.world.time, { attackerId: drone.id, point: position });
      }),
    );
  }

  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  private onDamaged(): void {
    const s = this.s;
    if (s.state !== 'running') return;
    s.radio.push({ from: s.awacsCallsign, text: `Sky Tower is hit! ${s.callsign}, it's burning. It won't take another one!`, priority: URGENT_PRIORITY });
    s.hud('SKY TOWER HIT', 'warn', 4);
  }

  private onDestroyed(cause: LandmarkCollapseCause, weapon: MunitionId | null, attackerId: number | null): void {
    const s = this.s;
    const byPlayer = cause === 'player';
    // the player's jet itself (no munition): the crash has already ended the sortie
    const rammed = byPlayer && weapon === null && attackerId !== null && attackerId === s.player?.id;
    s.radio.push({
      from: s.awacsCallsign,
      text: rammed
        ? `The Sky Tower has been destroyed! ${s.callsign} went straight into it.`
        : byPlayer
          ? `Check fire, check fire! ${s.callsign}, the Sky Tower is coming down!`
          : `The Sky Tower is coming down! ${s.callsign}, we've lost the Sky Tower.`,
      priority: URGENT_PRIORITY,
    });
    s.hud('SKY TOWER DESTROYED', 'bad', rammed ? 5 : 4);
    if (s.state !== 'running' || s.script.freeFlight) return;
    const reason = byPlayer ? REASONS.skytower : REASONS.skytowerLost;
    this.fail(reason);
  }
}
