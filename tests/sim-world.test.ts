import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { DEG, flatTerrain, makeWorld, run } from './sim-fakes';
import type { AiBrain } from '../src/sim/api';
import { MissileEntity, DecoyEntity, type MunitionDef } from '../src/sim/entities';
import { PROJECTILE_POOL_SIZE } from '../src/sim/World';

describe('SimWorld spawning', () => {
  it('spawns a trimmed player jet with loadout, fuel and O(1) lookup', () => {
    const tw = makeWorld('pilot');
    const ac = tw.world.spawnAircraft({
      type: 'f35a',
      team: 'blue',
      isPlayer: true,
      position: new Vector3(100, 3000, -200),
      heading: 90 * DEG,
      speed: 230,
      loadout: 'a2a_beast',
      fuel: 0.5,
      callsign: 'Viper 1',
    });
    expect(tw.world.player).toBe(ac);
    expect(tw.world.getEntity(ac.id)).toBe(ac);
    expect(tw.world.getEntity(null)).toBeNull();
    expect(ac.callsign).toBe('Viper 1');
    expect(ac.loadout).toBe('a2a_beast');
    expect(ac.stores.length).toBeGreaterThan(0);
    // heading east → velocity +X
    expect(ac.velocity.x).toBeCloseTo(230, 0);
    expect(Math.abs(ac.velocity.z)).toBeLessThan(1);
    expect(ac.flight.heading / DEG).toBeCloseTo(90, 0);
    expect(ac.flight.alpha).toBeGreaterThan(0);
    expect(ac.flight.pitch).toBeCloseTo(ac.flight.alpha, 3);
    expect(ac.flight.fuel).toBeCloseTo(0.5 * 8278, 0);
    expect(ac.flight.tas).toBeCloseTo(230, 0);
    expect(ac.flight.ias).toBeLessThan(230);
    expect(ac.rcsBase).toBeLessThanOrEqual(0.001);
    // beast mode is heavier / draggier than stealth
    run(tw.world, 0.1);
    expect(ac.flight.mass).toBeGreaterThan(13_290 + 4139 + 1000);
  });

  it('keeps spawns above the terrain', () => {
    const tw = makeWorld('pilot', flatTerrain(800));
    const ac = tw.world.spawnAircraft({ type: 'mig29', team: 'red', position: new Vector3(0, 100, 0), heading: 0, speed: 200 });
    expect(ac.position.y).toBeGreaterThan(800 + 50);
    expect(ac.name).toContain('MiG-29');
  });

  it('places SAMs on the terrain and ships at sea level, movers follow their path', () => {
    const tw = makeWorld('pilot', flatTerrain(120));
    const sam = tw.world.spawnSam({ type: 'sa6', team: 'red', position: new Vector3(5000, 0, 5000), emcon: true, known: true });
    expect(sam.position.y).toBe(120);
    expect(sam.radarOn).toBe(false);
    expect(sam.known).toBe(true);
    expect(sam.radius).toBeGreaterThan(20);
    const ship = tw.world.spawnGround({ type: 'ship', team: 'red', position: new Vector3(0, 50, 0) });
    expect(ship.position.y).toBe(0);
    // a taxiing jet: any ground target with a path is a mover
    const jet = tw.world.spawnGround({
      type: 'parked_jet',
      team: 'red',
      position: new Vector3(0, 0, 0),
      path: [new Vector3(0, 0, -100), new Vector3(100, 0, -100)],
      speed: 10,
      loopPath: true,
    });
    expect(jet.position.y).toBe(120);
    run(tw.world, 5);
    expect(jet.position.z).toBeCloseTo(-50, 0);
    expect(jet.velocity.z).toBeCloseTo(-10, 1);
    expect(jet.position.y).toBe(120);
    // heading north (towards −Z): forward = −Z
    const fwd = new Vector3(0, 0, -1).applyQuaternion(jet.quaternion);
    expect(fwd.z).toBeLessThan(-0.99);
    run(tw.world, 15); // reaches the corner and turns east
    expect(jet.position.x).toBeGreaterThan(40);
    expect(jet.position.z).toBeCloseTo(-100, 0);
    run(tw.world, 20); // loops back to the first waypoint
    expect(jet.alive).toBe(true);
    expect(tw.world.hostilesOf('blue')).toContain(jet);
    expect(tw.world.hostilesOf('red')).not.toContain(jet);
  });
});

describe('SimWorld pools & cleanup', () => {
  it('pools projectiles', () => {
    const tw = makeWorld();
    expect(tw.world.projectiles).toHaveLength(PROJECTILE_POOL_SIZE);
    const a = tw.world.allocProjectile()!;
    const b = tw.world.allocProjectile()!;
    expect(a).not.toBe(b);
    expect(a.active && b.active).toBe(true);
    for (let i = 2; i < PROJECTILE_POOL_SIZE; i++) expect(tw.world.allocProjectile()).not.toBeNull();
    expect(tw.world.allocProjectile()).toBeNull();
    a.active = false;
    expect(tw.world.allocProjectile()).toBe(a);
  });

  it('removes dead missiles and decoys one step after they die', () => {
    const tw = makeWorld();
    const def = { name: 'AIM-120D', length: 3.7 } as unknown as MunitionDef;
    const m = new MissileEntity(tw.world.nextId(), def, 'blue', 1, null);
    const d = new DecoyEntity(tw.world.nextId(), 'flare', 'blue', 1, 3, 1);
    tw.world.addMissile(m);
    tw.world.addDecoy(d);
    expect(tw.world.getEntity(m.id)).toBe(m);
    run(tw.world, 1 / 60);
    expect(tw.world.missiles).toContain(m);
    m.alive = false;
    d.alive = false;
    run(tw.world, 1 / 60);
    expect(tw.world.missiles).toContain(m); // still observable for one step
    run(tw.world, 1 / 60);
    expect(tw.world.missiles).not.toContain(m);
    expect(tw.world.decoys).not.toContain(d);
    expect(tw.world.getEntity(m.id)).toBeNull();
  });

  it('runs AI brains at 20 Hz with the accumulated dt, and combat every step', () => {
    const tw = makeWorld();
    const calls: number[] = [];
    const brain: AiBrain = {
      role: 'fighter',
      update(ac, _w, dt) {
        calls.push(dt);
        ac.input.throttle = 0.8;
      },
    };
    tw.world.spawnAircraft({ type: 'su27', team: 'red', position: new Vector3(0, 5000, 0), heading: 0, speed: 220, ai: brain });
    run(tw.world, 1);
    expect(calls.length).toBeGreaterThanOrEqual(19);
    expect(calls.length).toBeLessThanOrEqual(21);
    for (const dt of calls.slice(1)) expect(dt).toBeCloseTo(0.05, 3);
    expect(tw.combat.updates).toBe(60);
  });

  it('survives a throwing AI brain', () => {
    const tw = makeWorld();
    const err = console.error;
    console.error = () => {};
    try {
      tw.world.spawnAircraft({
        type: 'su27',
        team: 'red',
        position: new Vector3(0, 5000, 0),
        heading: 0,
        speed: 220,
        ai: { role: 'fighter', update: () => { throw new Error('boom'); } },
      });
      expect(() => run(tw.world, 1)).not.toThrow();
    } finally {
      console.error = err;
    }
  });
});

describe('SimWorld collisions & wrecks', () => {
  it('detects a crash into the ground: explosion, destroyed, player:down', () => {
    const tw = makeWorld('ace', flatTerrain(200));
    const ac = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 700, 0), heading: 0, speed: 250 });
    run(tw.world, 30, () => {
      ac.input.pitch = -0.8;
      return !ac.alive;
    });
    expect(ac.alive).toBe(false);
    expect(ac.crashed).toBe(true);
    expect(ac.position.y).toBeGreaterThanOrEqual(200);
    expect(tw.of('explosion').some((e) => e.surface === 'ground' && (e.size === 'large' || e.size === 'huge'))).toBe(true);
    const d = tw.of('destroyed')[0];
    expect(d.entity).toBe(ac);
    expect(d.weapon).toBe('collision');
    expect(tw.of('player:down')).toEqual([{ reason: 'crash' }]);
    // the player wreck stays in the world
    run(tw.world, 30);
    expect(tw.world.aircraft).toContain(ac);
  });

  it('reports fuel exhaustion as the reason when a dead-stick jet hits the ground', () => {
    const tw = makeWorld('ace');
    const ac = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 400, 0), heading: 0, speed: 200, fuel: 0 });
    run(tw.world, 120, () => {
      ac.input.pitch = -0.3;
      return !ac.alive;
    });
    expect(tw.of('player:down')).toEqual([{ reason: 'fuel' }]);
  });

  it('splashes into the sea', () => {
    const tw = makeWorld('ace', flatTerrain(-50));
    const ac = tw.world.spawnAircraft({ type: 'mig29', team: 'red', position: new Vector3(0, 300, 0), heading: 0, speed: 250 });
    run(tw.world, 30, () => {
      ac.input.pitch = -1;
      return ac.crashed;
    });
    expect(ac.crashed).toBe(true);
    expect(tw.of('explosion').some((e) => e.surface === 'water')).toBe(true);
  });

  it('mid-air collision destroys both aircraft', () => {
    const tw = makeWorld('pilot');
    const a = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 5000, 0), heading: 0, speed: 250 });
    const b = tw.world.spawnAircraft({ type: 'mig29', team: 'red', position: new Vector3(0, 5000, -3000), heading: Math.PI, speed: 250 });
    run(tw.world, 10, () => !a.alive);
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(false);
    expect(tw.of('player:down')).toEqual([{ reason: 'collision' }]);
  });

  it('shot-down aircraft fall as tumbling wrecks, explode on impact and are removed later', () => {
    const tw = makeWorld('pilot', flatTerrain(100));
    const shooter = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 9000, 0), heading: 0, speed: 250 });
    const ac = tw.world.spawnAircraft({ type: 'su27', team: 'red', position: new Vector3(3000, 1500, 0), heading: 0, speed: 250 });
    tw.world.applyDamage(ac, 500, shooter.id, 'aim120');
    expect(ac.alive).toBe(false);
    expect(ac.damage.fire).toBe(true);
    expect(shooter.kills).toBe(1);
    expect(tw.of('explosion').at(-1)?.surface).toBe('air');
    const y0 = ac.position.y;
    run(tw.world, 1);
    expect(ac.position.y).toBeLessThan(y0);
    expect(Math.abs(ac.rates.x) + Math.abs(ac.rates.y)).toBeGreaterThan(0.3); // tumbling
    run(tw.world, 60, () => ac.crashed);
    expect(ac.crashed).toBe(true);
    expect(tw.of('explosion').at(-1)?.surface).toBe('ground');
    expect(tw.of('destroyed')).toHaveLength(1); // impact does not count twice
    expect(tw.world.aircraft).toContain(ac);
    run(tw.world, 21);
    expect(tw.world.aircraft).not.toContain(ac);
    expect(tw.world.getEntity(ac.id)).toBeNull();
  });
});
