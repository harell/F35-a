import { describe, expect, it } from 'vitest';
import { FakeWorld, FlatTerrain, v3 } from './combat-helpers';
import type { SamState } from '../src/sim/entities';
import type { CombatMissile } from '../src/sim/weapons/missile';
import { SAM_LAUNCH_PRIORITY, launchRangeFraction } from '../src/sim/sam/SamSystem';

/** Simulation-heavy tests get an explicit timeout (a loaded CI runner can take > 5 s). */
const SIM = { timeout: 30_000 };

describe('combat: SAM sites', () => {
  it('SA-6 runs search → track → launch → guiding and fires a salvo at an approaching fighter', SIM, () => {
    const w = new FakeWorld({ difficulty: 'veteran' });
    const site = w.spawnSam({ type: 'sa6', team: 'red', position: v3(0, 0, 0) });
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 5000, -45000), heading: Math.PI, speed: 250, loadout: 'a2a_beast', callsign: 'Viper 1' });
    const launches = w.record('munition:launch');
    const radio = w.record('radio');
    const states: SamState[] = [];
    w.run(200, () => {
      if (states[states.length - 1] !== site.state) states.push(site.state);
      return launches.length >= 2;
    });
    expect(states.slice(0, 3)).toEqual(['search', 'track', 'launch']);
    expect(launches.length).toBe(2);
    expect(launches[0].shooter).toBe(site);
    expect(launches[0].missile.def.id).toBe('m_3m9');
    expect(site.missilesReady).toBe(site.missilesMax - 2);
    expect(site.guidedMissiles.length).toBe(2);
    expect(radio.filter((r) => r.voice === 'a_sam_launch').length).toBe(1); // rate-limited per salvo
    expect(radio[0].from).toBe('DARKSTAR');
    // not an urgent call: VoicePlayer only holds Betty behind radio calls of priority ≥ 3, so the
    // on-board MISSILE warning is never delayed by the AWACS call (i2 critique)
    expect(radio[0].priority).toBe(SAM_LAUNCH_PRIORITY);
    expect(radio[0].priority).toBeLessThan(3);
    w.run(1);
    expect(site.state).toBe('guiding');
    expect(site.known).toBe(true);
    // the player's RWR shows the launch
    expect(f35.rwr.find((r) => r.sourceId === site.id)?.state).toBe('launch');
    // launcher slewed toward the target
    expect(Math.abs(site.launcherAzimuth)).toBeLessThan(0.2);
    expect(site.launcherElevation).toBeGreaterThan(0.25);
  });

  it('a clean F-35 is detected at ~25 % of the range of a fighter; beast mode much earlier', SIM, () => {
    const trackRange = (type: 'mig29' | 'f35a', loadout?: 'a2a_stealth' | 'a2a_beast') => {
      const w = new FakeWorld({ difficulty: 'veteran' });
      const site = w.spawnSam({ type: 'sa10', team: 'red', position: v3(0, 0, 0) });
      const ac = w.spawnAircraft({ type, team: 'blue', position: v3(0, 9000, -90000), heading: Math.PI, speed: 300, loadout });
      let r = -1;
      w.run(400, () => {
        if (site.state === 'track') r = ac.position.distanceTo(site.position);
        return r > 0;
      });
      return r;
    };
    const mig = trackRange('mig29');
    const clean = trackRange('f35a', 'a2a_stealth');
    const beast = trackRange('f35a', 'a2a_beast');
    expect(mig).toBeGreaterThan(60_000);
    expect(clean / mig).toBeGreaterThan(0.15);
    expect(clean / mig).toBeLessThan(0.4);
    expect(beast).toBeGreaterThan(1.5 * clean);
  });

  it('terrain masking and the SA-6 minimum altitude: low flight under the radar is not engaged', SIM, () => {
    const w = new FakeWorld();
    const site = w.spawnSam({ type: 'sa6', team: 'red', position: v3(0, 0, 0) });
    const ac = w.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(3000, 50, -25000), heading: Math.PI, speed: 250 });
    const launches = w.record('munition:launch');
    w.run(90, () => ac.position.z > 0);
    expect(launches.length).toBe(0);

    const wall = { x0: -2000, x1: 2000, z0: -6000, z1: -5000, h: 3000 };
    const w2 = new FakeWorld({ terrain: new FlatTerrain(0, [wall]) });
    const s2 = w2.spawnSam({ type: 'sa8', team: 'red', position: v3(0, 0, 0) });
    w2.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(0, 800, -20000), heading: 0, speed: 0.001 });
    w2.run(10);
    expect(s2.state).toBe('search');
    expect(s2.trackedTargetId).toBeNull();
  });

  it('pop-up ambush: an EMCON site stays silent until the target is inside ~60 % of its range', SIM, () => {
    const w = new FakeWorld();
    const site = w.spawnSam({ type: 'sa15', team: 'red', position: v3(0, 0, 0), emcon: true });
    const ac = w.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(0, 3000, -20000), heading: Math.PI, speed: 250 });
    let wokeAt = -1;
    w.run(80, () => {
      if (site.radarOn && wokeAt < 0) wokeAt = ac.position.distanceTo(site.position);
      return wokeAt > 0;
    });
    expect(wokeAt).toBeGreaterThan(0);
    expect(wokeAt).toBeLessThan(0.6 * site.engageRange! + 300);
    expect(wokeAt).toBeGreaterThan(0.5 * site.engageRange!);
  });

  it('defensive EMCON: radar shuts down against an inbound AARGM, then comes back on', SIM, () => {
    let shutdowns = 0;
    let recovered = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const w = new FakeWorld({ seed, difficulty: 'ace' });
      const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 9000, 0), heading: 0, speed: 280, loadout: 'sead_stealth' });
      const site = w.spawnSam({ type: 'sa10', team: 'red', position: v3(0, 0, -40000) });
      f35.selectedWeapon = 'aargm';
      f35.radar.mode = 'ground';
      w.run(0.5);
      const m = w.combat.fire(f35, w, 'aargm') as CombatMissile;
      expect(m?.targetId).toBe(site.id);
      let off = false;
      w.run(120, () => {
        if (!site.radarOn && site.alive) off = true;
        return !m.alive;
      });
      if (off) shutdowns++;
      w.run(25);
      if (site.alive && site.radarOn) recovered++;
    }
    expect(shutdowns).toBeGreaterThan(0);
    expect(recovered).toBeGreaterThan(0);
  });

  it('ZSU-23-4 fires radar-directed bursts at a low jet inside 2.5 km', SIM, () => {
    const w = new FakeWorld();
    const zsu = w.spawnSam({ type: 'zsu23', team: 'red', position: v3(0, 0, 0) });
    const ac = w.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(800, 400, -6000), heading: Math.PI, speed: 220 });
    const guns = w.record('gun:state');
    let maxActive = 0;
    w.run(40, () => {
      maxActive = Math.max(maxActive, w.projectiles.filter((p) => p.active).length);
      return ac.position.z > 4000;
    });
    const starts = guns.filter((g) => g.firing && g.weapon === 'zsu23').length;
    const stops = guns.filter((g) => !g.firing && g.weapon === 'zsu23').length;
    expect(starts).toBeGreaterThanOrEqual(2); // bursts, not a continuous stream
    expect(stops).toBeGreaterThanOrEqual(1);
    expect(maxActive).toBeGreaterThan(30);
    expect(ac.health).toBeLessThan(100);
    expect(zsu.launcherElevation).toBeGreaterThan(0);
    // AAA does not fire at high altitude
    const w2 = new FakeWorld();
    w2.spawnSam({ type: 'zsu23', team: 'red', position: v3(0, 0, 0) });
    w2.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(500, 5000, -3000), heading: Math.PI, speed: 220 });
    const g2 = w2.record('gun:state');
    w2.run(25);
    expect(g2.length).toBe(0);
  });

  it('MANPADS: silent on the RWR but the F-35 DAS warns and the site is revealed; DARKSTAR does not call it', SIM, () => {
    const w = new FakeWorld();
    const team = w.spawnSam({ type: 'sa18', team: 'red', position: v3(0, 0, 0) });
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(300, 700, -7000), heading: Math.PI, speed: 230, loadout: 'a2a_stealth' });
    f35.flight.afterburner = 1;
    const launches = w.record('munition:launch');
    const radio = w.record('radio');
    let warned = false;
    w.run(40, () => {
      if (f35.incoming.length) warned = true;
      return launches.length > 0 && warned;
    });
    expect(launches.length).toBeGreaterThan(0);
    expect(launches[0].missile.def.id).toBe('m_igla');
    expect(warned).toBe(true);
    expect(f35.rwr.some((r) => r.sourceId === team.id)).toBe(false);
    expect(team.known).toBe(true);
    // an AWACS can't see a shoulder-fired, passive IR launch: no 'SAM launch' call (i2 critique)
    w.run(3);
    expect(radio.filter((r) => r.voice === 'a_sam_launch').length).toBe(0);
  });

  it('crews launch inside a skill-dependent fraction of the kinematic range (monotonic with difficulty)', () => {
    const f = [0.25, 0.5, 0.75, 0.95].map(launchRangeFraction);
    for (let i = 1; i < f.length; i++) expect(f[i]).toBeLessThan(f[i - 1]);
    expect(f[0]).toBeLessThanOrEqual(0.95);
    expect(f[3]).toBeGreaterThan(0.6);
  });
});
