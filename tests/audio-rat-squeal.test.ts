import { describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';

const squeals: { when: number; gain: number }[] = [];
vi.mock('../src/audio/synth/recipes', async (orig) => ({
  ...(await orig<typeof import('../src/audio/synth/recipes')>()),
  ratSqueal: (_env: unknown, when: number, sp: { gain: number }) => squeals.push({ when, gain: sp.gain }),
}));

const { ImpactSounds, ratSquealDelay, ratSquealGain } = await import('../src/audio/world/ImpactSounds');
const { Listener } = await import('../src/audio/core/Listener');
const { GroundTargetEntity } = await import('../src/sim/entities');

function killed(type: 'rat' | 'stoat' | 'fuel', at: Vector3) {
  const e = new GroundTargetEntity(1, type, 'red', { radius: 0.12 });
  e.position.copy(at);
  return { entity: e, attackerId: 7, weapon: 'gbu53' as const };
}

describe('a rat squeals when it dies (t07 playtest: the owner wanted to hear the kill)', () => {
  const env = { ctx: { currentTime: 10 } } as any;
  const L = new Listener();
  L.pos.set(0, 1500, 0);

  it('plays for a rat, and for nothing else on the ground', () => {
    squeals.length = 0;
    const s = new ImpactSounds(env);
    s.onDestroyed(killed('fuel', new Vector3(0, 0, 0)), {} as any, L);
    s.onDestroyed(killed('stoat', new Vector3(0, 0, 0)), {} as any, L);
    expect(squeals).toHaveLength(0);
    s.onDestroyed(killed('rat', new Vector3(3000, 0, 0)), {} as any, L);
    expect(squeals).toHaveLength(1);
    expect(squeals[0].when).toBeCloseTo(10.25, 5);
  });

  it('is heard from a jet kilometres away, louder close in', () => {
    expect(ratSquealGain(8_000)).toBeGreaterThanOrEqual(0.5);
    expect(ratSquealGain(100)).toBeCloseTo(1, 5);
    expect(ratSquealGain(100)).toBeGreaterThan(ratSquealGain(3_000));
  });

  it('waits for the boom to pass when the listener is next to the blast', () => {
    expect(ratSquealDelay(200)).toBeGreaterThan(0.8);
    expect(ratSquealDelay(5_000)).toBeCloseTo(0.25, 5);
  });
});
