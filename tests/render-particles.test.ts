import { describe, expect, it } from 'vitest';
import { Vector3, type Mesh, type ShaderMaterial } from 'three';
import { GpuParticles, STRIDE, glowGain, particlePosition, resetSpawn, spawnParams } from '../src/render/effects/GpuParticles';
import { Ribbons, type RibbonStyle } from '../src/render/effects/Ribbons';
import { SpriteBatch } from '../src/render/effects/SpriteBatch';
import { Pulses } from '../src/render/effects/Props';

describe('render particle pool', () => {
  it('ring buffer overwrites the oldest slot and tracks dirty ranges', () => {
    const ps = new GpuParticles(8, 'normal', null, 0);
    const p = spawnParams();
    for (let i = 0; i < 5; i++) ps.spawn(p, i);
    expect(ps.size).toBe(5);
    expect(ps.dirtyRanges()).toEqual([[0, 5]]);
    ps.update(5, new Vector3(), 0.002, 1);
    expect(ps.dirtyRanges()).toEqual([]);
    // wrap around: 6 more → slots 5,6,7,0,1,2
    for (let i = 0; i < 6; i++) ps.spawn(p, 10 + i);
    expect(ps.size).toBe(8);
    expect(ps.dirtyRanges()).toEqual([
      [5, 3],
      [0, 3],
    ]);
    expect(ps.cursor).toBe(3);
    // the oldest slots were overwritten with new birth times
    expect(ps.birthAt(0)).toBe(13);
    expect(ps.birthAt(3)).toBe(3);
    ps.dispose();
  });

  it('dirty count saturates at capacity when spawning more than the pool per frame', () => {
    const ps = new GpuParticles(4, 'additive', null, 0);
    const p = spawnParams();
    for (let i = 0; i < 11; i++) ps.spawn(p, i);
    const total = ps.dirtyRanges().reduce((a, [, c]) => a + c, 0);
    expect(total).toBe(4);
    expect(ps.spawned).toBe(11);
    expect(STRIDE).toBe(28);
  });

  it('analytic motion: drag relaxes to wind + buoyancy terminal velocity', () => {
    const p = resetSpawn(spawnParams());
    p.vx = 100;
    p.drag = 2;
    p.grav = 4; // terminal rise = 2 m/s
    const wind = { x: 5, y: 0, z: 0 };
    const a = particlePosition(p, 10, wind, new Vector3());
    const b = particlePosition(p, 11, wind, new Vector3());
    // after many time constants the particle moves at the terminal velocity
    expect(b.x - a.x).toBeCloseTo(5, 2);
    expect(b.y - a.y).toBeCloseTo(2, 2);
    // at t=0 it is at the spawn point
    expect(particlePosition(p, 0, wind, new Vector3()).length()).toBeCloseTo(0);
  });

  it('analytic motion: low drag + gravity ≈ ballistic', () => {
    const p = resetSpawn(spawnParams());
    p.vy = 20;
    p.drag = 0.01;
    p.grav = -9.8;
    const y = particlePosition(p, 1, { x: 0, y: 0, z: 0 }, new Vector3()).y;
    expect(y).toBeCloseTo(20 - 4.9, 0);
  });
});

describe('render ribbons', () => {
  const style: RibbonStyle = { width: 1, growth: 1, life: 5, alpha: 1, r: 1, g: 1, b: 1, formDelay: 0, spacing: 10, interval: 1 };

  it('allocates emitters up to the head-slot count and recycles released ones', () => {
    const r = new Ribbons(64, 3);
    const a = r.alloc(style);
    const b = r.alloc(style);
    const c = r.alloc(style);
    expect([a, b, c]).toEqual([0, 1, 2]);
    expect(r.alloc(style)).toBe(-1);
    r.release(b, 0);
    expect(r.isActive(b)).toBe(false);
    expect(r.alloc(style)).toBe(1);
    r.dispose();
  });

  it('commits a segment every `spacing` metres (or `interval` seconds)', () => {
    const r = new Ribbons(64, 2);
    const id = r.alloc(style);
    for (let i = 0; i <= 10; i++) r.emit(id, 0, 0, -i * 5, i * 0.01);
    // 50 m travelled at 5 m steps with 10 m spacing → 5 committed segments
    expect(r.committed).toBe(5);
    // standing still commits nothing even after the interval
    const n = r.committed;
    r.emit(id, 0, 0, -50, 5);
    expect(r.committed).toBe(n);
    r.dispose();
  });
});

describe('render sprite batch', () => {
  it('caps at capacity and resets each frame', () => {
    const s = new SpriteBatch(3, null);
    s.begin(0.002);
    for (let i = 0; i < 5; i++) s.add(i, 0, 0, 1, 1, 1, 1, 1);
    expect(s.count).toBe(3);
    s.end();
    s.begin(0.002);
    expect(s.count).toBe(0);
    s.dispose();
  });
});

describe('additive glow gain (#282 R31-10)', () => {
  it('fire particles and the effects glow sprites share one gain uniform; smoke and nav lights do not', () => {
    const fire = new GpuParticles(4, 'additive', null, 0);
    const smoke = new GpuParticles(4, 'normal', null, 0);
    const sprites = new SpriteBatch(4, null, 12, glowGain);
    const lights = new SpriteBatch(4, null);
    expect(fire.material.uniforms.uGain).toBe(glowGain);
    expect(sprites.material.uniforms.uGain).toBe(glowGain);
    // a batch made without one (EntityRenderer's nav lights) keeps its own, at full brightness
    expect(lights.material.uniforms.uGain).not.toBe(glowGain);
    expect(lights.material.uniforms.uGain.value).toBe(1);
    expect(fire.material.fragmentShader).toContain('uGain');
    expect(sprites.material.fragmentShader).toContain('uGain');
    expect(smoke.material.fragmentShader).not.toContain('uGain');
    expect(smoke.material.uniforms.uGain).toBeUndefined();
    // the main view draws the glow at full brightness
    expect(glowGain.value).toBe(1);
    fire.dispose();
    smoke.dispose();
    sprites.dispose();
    lights.dispose();
  });

  it('the additive air-shock spheres share it too; the normal-blended ground rings keep their own', () => {
    const pulses = new Pulses(2, 2, glowGain);
    const mats = pulses.group.children.map((m) => (m as Mesh).material as ShaderMaterial);
    expect(mats).toHaveLength(4);
    expect(mats[0].fragmentShader).toContain('uGain');
    // rings first, then spheres (Pulses constructor order)
    for (const m of mats.slice(0, 2)) {
      expect(m.uniforms.uSphere.value).toBe(0);
      expect(m.uniforms.uGain).not.toBe(glowGain);
      expect(m.uniforms.uGain.value).toBe(1);
    }
    for (const m of mats.slice(2)) {
      expect(m.uniforms.uSphere.value).toBe(1);
      expect(m.uniforms.uGain).toBe(glowGain);
    }
    pulses.dispose();
  });
});
