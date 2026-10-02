/**
 * F35-A — protected landmarks in the mission runtime: the Auckland Sky Tower.
 *
 * Every Auckland sortie stands the tower up as a sim landmark (unless the save says it is already
 * down: then the scenery shows the stump and rubble and there is nothing to hit). The player
 * bringing it down is an immediate mission failure in every mode: AWACS
 * calls check fire, the HUD flags it, and the runner fails with REASONS.skytower while the
 * collapse plays on.
 */
import { createSkyTower, type LandmarkEntity } from '../../sim/landmarks';
import { AKL } from '../../core/auckland';
import { URGENT_PRIORITY } from './radio';
import { REASONS } from './reasons';
import type { MissionState } from './state';

export class LandmarkWatch {
  private unsubs: (() => void)[] = [];
  /** The tower this sortie stood up (null outside Auckland / already down). */
  tower: LandmarkEntity | null = null;

  constructor(
    private readonly s: MissionState,
    /** Fails the mission with the given reason. */
    private readonly fail: (reason: string) => void,
  ) {}

  setup(): void {
    const s = this.s;
    if (s.def.theater !== 'auckland' || s.deps.skyTowerDown) return;
    const { x, z } = AKL.skytower;
    this.tower = createSkyTower(s.world.terrain.surfaceHeightAt(x, z));
    s.world.landmarks.push(this.tower);
    this.unsubs.push(
      s.events.on('landmark:destroyed', ({ landmark }) => {
        if (landmark === this.tower && !s.disposed) this.onDestroyed();
      }),
    );
  }

  /** Fall heading (rad) if the tower came down this sortie, else null. */
  get downHeading(): number | null {
    return this.tower && !this.tower.alive ? this.tower.fallHeading : null;
  }

  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  private onDestroyed(): void {
    const s = this.s;
    s.radio.push({ from: s.awacsCallsign, text: `Check fire, check fire! ${s.callsign}, the Sky Tower is coming down!`, priority: URGENT_PRIORITY });
    s.hud('SKY TOWER DESTROYED', 'bad', 4);
    if (s.state !== 'running') return;
    this.fail(REASONS.skytower);
  }
}
