import { describe, expect, it } from 'vitest';
import { FakeWorld, v3 } from './combat-helpers';
import { BAY_OPEN_TIME } from '../src/sim/weapons/release';
import { stationMunition } from '../src/sim/weapons/loadouts';

function setup(loadout: 'a2a_stealth' | 'a2a_beast' | 'strike_stealth' | 'sead_stealth' = 'a2a_stealth') {
  const w = new FakeWorld({ difficulty: 'veteran' });
  const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 6000, 0), heading: 0, speed: 260, loadout, callsign: 'Viper 1' });
  return { w, f35 };
}

describe('combat: weapon release', () => {
  it('internal bay: doors open first (~0.35 s), release at > 90 %, close ~1.5 s later', () => {
    const { w, f35 } = setup();
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -20000), heading: Math.PI, speed: 250 });
    w.run(0.5);
    const launches = w.record('munition:launch');
    let doorsAtLaunch = -1;
    w.events.on('munition:launch', () => (doorsAtLaunch = f35.bayDoors));
    expect(w.combat.fire(f35, w)).toBeNull(); // queued behind the doors
    expect(launches.length).toBe(0);
    w.run(0.2);
    expect(launches.length).toBe(0);
    expect(f35.bayDoors).toBeGreaterThan(0.4);
    w.run(0.3);
    expect(launches.length).toBe(1);
    expect(doorsAtLaunch).toBeGreaterThan(0.9);
    expect(launches[0].targetId).toBe(mig.id);
    expect(launches[0].missile.def.id).toBe('aim120');
    expect(f35.shotsFired).toBe(1);
    expect(w.combat.remaining(f35, 'aim120')).toBe(3);
    w.run(1.2);
    expect(f35.bayDoors).toBe(1); // held open
    w.run(1.2);
    expect(f35.bayDoors).toBe(0); // closed again
    expect(BAY_OPEN_TIME).toBeCloseTo(0.35);
  });

  it('beast mode: external pylons first and they release immediately', () => {
    const { w, f35 } = setup('a2a_beast');
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -20000), heading: Math.PI, speed: 250 });
    w.run(0.5);
    const m = w.combat.fire(f35, w, 'aim120', mig.id);
    expect(m).not.toBeNull();
    const ext = f35.stores.find((s) => !s.internal && s.weapon === 'aim120')!;
    expect(ext.count).toBe(1);
    expect(f35.bayDoors).toBe(0);
    expect(f35.rcsMultiplier).toBe(40);
  });

  it('pickle rising edge fires once; holding does not ripple', () => {
    const { w, f35 } = setup('a2a_beast');
    w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -20000), heading: Math.PI, speed: 250 });
    w.run(0.5);
    const launches = w.record('munition:launch');
    f35.input.fireWeapon = true;
    w.run(2);
    expect(launches.length).toBe(1);
    f35.input.fireWeapon = false;
    w.run(0.1);
    f35.input.fireWeapon = true;
    w.run(0.1);
    expect(launches.length).toBe(2);
  });

  it('denies with NO TARGET, OUT OF RANGE, MIN RANGE, NO SEEKER, WINCHESTER', () => {
    const { w, f35 } = setup('a2a_beast');
    const denied = w.record('weapon:denied');
    const last = () => denied[denied.length - 1]?.reason;
    w.run(0.2);
    expect(w.combat.fire(f35, w, 'aim120')).toBeNull();
    expect(last()).toBe('NO TARGET');

    // far + low + going away: well beyond 1.3 × rMax
    const far = w.spawnAircraft({ type: 'su27', team: 'red', position: v3(0, 6000, -55000), heading: 0, speed: 300 });
    w.run(0.5);
    expect(f35.radar.contacts.some((c) => c.id === far.id)).toBe(true);
    expect(w.combat.fire(f35, w, 'aim120', far.id)).toBeNull();
    expect(last()).toBe('OUT OF RANGE');

    const close = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -700), heading: Math.PI, speed: 250 });
    w.run(0.2);
    expect(w.combat.fire(f35, w, 'aim120', close.id)).toBeNull();
    expect(last()).toBe('MIN RANGE');

    // AIM-9X against a head-on target far beyond its IR seeker's reach
    w.combat.selectWeapon(f35, 'aim9x', w);
    w.combat.designate(f35, far.id, w);
    close.alive = false;
    w.run(0.2);
    expect(w.combat.fire(f35, w, 'aim9x')).toBeNull();
    expect(last()).toBe('NO SEEKER');

    for (const s of f35.stores) if (s.weapon === 'aim9x') s.count = 0;
    expect(w.combat.fire(f35, w, 'aim9x')).toBeNull();
    expect(last()).toBe('WINCHESTER');
    expect(denied.every((d) => d.ownerId === f35.id)).toBe(true);
  });

  it('weapon cycling skips empty types, gun last; auto-reselect and Winchester call', () => {
    const { w, f35 } = setup('sead_stealth');
    const sel = w.record('weapon:select');
    const radio = w.record('radio');
    expect(f35.selectedWeapon).toBe('aargm');
    expect(f35.radar.mode).toBe('ground');
    w.combat.cycleWeapon(f35, w);
    expect(f35.selectedWeapon).toBe('gun');
    expect(f35.radar.mode).toBe('acm');
    w.combat.cycleWeapon(f35, w);
    expect(f35.selectedWeapon).toBe('aim120');
    expect(f35.radar.mode).toBe('search');
    w.combat.cycleWeapon(f35, w);
    expect(f35.selectedWeapon).toBe('gbu39');
    expect(sel.map((s) => s.weapon)).toEqual(['gun', 'aim120', 'gbu39']);
    w.combat.selectWeapon(f35, 'aim9x', w); // none carried → no-op
    expect(f35.selectedWeapon).toBe('gbu39');

    // drop the SDBs unguided (CCIP) until empty → auto-reselects another A/G weapon
    for (let i = 0; i < 4; i++) {
      w.combat.fire(f35, w, 'gbu39');
      w.run(0.6);
    }
    expect(w.combat.remaining(f35, 'gbu39')).toBe(0);
    expect(f35.selectedWeapon).toBe('aargm');
    expect(radio.filter((r) => r.voice === 'p_rifle').length).toBe(4);
    // empty everything → Winchester
    for (const s of f35.stores) if (s.weapon !== 'aim120') s.count = 0;
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -15000), heading: Math.PI, speed: 250 });
    w.combat.selectWeapon(f35, 'aim120', w);
    w.run(0.5);
    w.combat.designate(f35, mig.id, w);
    w.combat.fire(f35, w, 'aim120', mig.id);
    w.run(0.6);
    w.combat.fire(f35, w, 'aim120', mig.id);
    w.run(0.6);
    expect(radio.some((r) => r.voice === 'p_winchester')).toBe(true);
    expect(f35.selectedWeapon).toBe('gun');
  });

  it('applies loadouts and typical enemy loadouts', () => {
    const w = new FakeWorld();
    const strike = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 5000, 0), heading: 0, speed: 250, loadout: 'strike_stealth' });
    expect(strike.selectedWeapon).toBe('gbu31');
    expect(strike.gunAmmo).toBe(180);
    expect(strike.flares).toBe(24);
    expect(strike.rcsMultiplier).toBe(1);
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 5000, 0), heading: 0, speed: 250 });
    const su27 = w.spawnAircraft({ type: 'su27', team: 'red', position: v3(0, 5000, 0), heading: 0, speed: 250 });
    const su57 = w.spawnAircraft({ type: 'su57', team: 'red', position: v3(0, 5000, 0), heading: 0, speed: 250 });
    const tu = w.spawnAircraft({ type: 'tu22m', team: 'red', position: v3(0, 5000, 0), heading: 0, speed: 250 });
    const wing = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 5000, 0), heading: 0, speed: 250 });
    const muns = (ac: typeof mig) => ac.stores.flatMap((s, i) => Array(s.count).fill(stationMunition(ac, i))).sort();
    expect(muns(mig)).toEqual(['r27', 'r27', 'r73', 'r73', 'r73', 'r73']);
    expect(muns(su27)).toEqual(['r27', 'r27', 'r27', 'r27', 'r73', 'r73', 'r73', 'r73']); // i2: baseline Su-27 has no R-77
    expect(su57.stores.every((s) => s.internal)).toBe(true);
    expect(muns(su57)).toEqual(['r73', 'r73', 'r77', 'r77', 'r77', 'r77']);
    expect(tu.stores.length).toBe(0);
    expect(wing.loadout).toBe('a2a_stealth');
    expect(mig.gunAmmo).toBeGreaterThan(0);
    // stealth jets keep a low base RCS
    expect(su57.rcsBase).toBeLessThan(0.5);
    expect(mig.rcsBase).toBeGreaterThan(1);
  });
});
