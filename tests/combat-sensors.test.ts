import { createOneWay } from '../src/sim/drone/oneWay';
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FakeWorld, FlatTerrain, v3 } from './combat-helpers';
import { aircraftRcs, FIGHTER_RADAR, rcsRangeFactor } from '../src/sim/sensors/signatures';
import type { AircraftEntity } from '../src/sim/entities';
import type { TrackContact } from '../src/sim/weapons/context';

/** Range at which `observer` (flying at the target) first holds a radar track on it. */
function firstRadarTrackRange(targetType: 'f35a' | 'mig29', loadout?: 'a2a_stealth' | 'a2a_beast'): number {
  const w = new FakeWorld();
  const su = w.spawnAircraft({ type: 'su35', team: 'red', position: v3(0, 7000, 0), heading: 0, speed: 300 });
  const t = w.spawnAircraft({ type: targetType, team: 'blue', position: v3(0, 7000, -80000), heading: Math.PI, speed: 250, loadout });
  let found = -1;
  w.run(200, () => {
    const c = su.radar.contacts.find((k) => k.id === t.id) as TrackContact | undefined;
    if (c && c.source === 'radar') found = su.position.distanceTo(t.position);
    return found > 0 || su.position.z < t.position.z;
  });
  return found;
}

describe('combat: radar & stealth', () => {
  it('radar equation: a clean F-35 is detected far later than a MiG-29; beast mode increases it', () => {
    const obs = new Vector3(0, 7000, -50000);
    const w = new FakeWorld();
    const clean = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 7000, 0), heading: Math.PI, speed: 250, loadout: 'a2a_stealth' });
    const beast = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 7000, 0), heading: Math.PI, speed: 250, loadout: 'a2a_beast' });
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 7000, 0), heading: Math.PI, speed: 250 });
    // heading π = flying south (+Z), i.e. away from obs? obs is north (−Z): face it
    for (const ac of [clean, beast, mig]) ac.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0);
    const R = (ac: AircraftEntity) => FIGHTER_RADAR.su35.range * rcsRangeFactor(aircraftRcs(ac, obs));
    expect(R(clean)).toBeLessThan(0.35 * R(mig));
    expect(R(clean)).toBeGreaterThan(0.15 * R(mig));
    expect(R(beast)).toBeGreaterThan(1.5 * R(clean));
    // beam aspect is much worse for the stealth jet than the nose
    const side = new Vector3(50000, 7000, 0);
    expect(aircraftRcs(clean, side)).toBeGreaterThan(8 * aircraftRcs(clean, obs));
    // open bay doors spike the RCS
    const closed = aircraftRcs(clean, obs);
    clean.bayDoors = 1;
    expect(aircraftRcs(clean, obs)).toBeGreaterThan(8 * closed);
  });

  it('in the sim, a Su-35 finds a MiG-29 near 55 km but a clean F-35 only inside ~20 km', () => {
    const rMig = firstRadarTrackRange('mig29');
    const rF35 = firstRadarTrackRange('f35a', 'a2a_stealth');
    const rBeast = firstRadarTrackRange('f35a', 'a2a_beast');
    expect(rMig).toBeGreaterThan(45_000);
    expect(rF35).toBeGreaterThan(5_000);
    expect(rF35).toBeLessThan(20_000);
    expect(rBeast).toBeGreaterThan(rF35 * 1.4);
  });

  it('auto-designation gives a TWS track only; a commanded lock builds over playerLockTime', () => {
    const w = new FakeWorld({ difficulty: 'veteran' });
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 6000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(2000, 6000, -40000), heading: Math.PI, speed: 250 });
    const locks = w.record('lock');
    const des = w.record('designate');
    w.run(0.3);
    expect(f35.radar.designatedId).toBe(mig.id);
    expect(des[0]).toMatchObject({ ownerId: f35.id, targetId: mig.id });
    // no automatic STT: nothing builds and the MiG's RWR stays silent
    w.run(3);
    expect(f35.radar.lockedId).toBeNull();
    expect(f35.radar.lockProgress).toBe(0);
    expect(mig.rwr.some((r) => r.sourceId === f35.id)).toBe(false);
    // tap on the TD box → the lock builds over playerLockTime (1.5 s on veteran)
    w.combat.designate(f35, mig.id, w);
    w.run(1.0);
    expect(f35.radar.lockedId).toBeNull();
    expect(f35.radar.lockProgress).toBeGreaterThan(0.5);
    expect(f35.radar.lockProgress).toBeLessThan(0.8);
    w.run(0.6);
    expect(f35.radar.lockedId).toBe(mig.id);
    expect(locks.some((l) => l.locked && l.targetId === mig.id && l.ownerId === f35.id)).toBe(true);
    // STT spikes the target's RWR
    w.run(0.3);
    expect(mig.rwr.find((r) => r.sourceId === f35.id)?.state).toBe('track');
  });

  it('lock cone ±30°: no progress outside it (decays), an established lock holds to ±60° and is lost beyond', () => {
    const w = new FakeWorld({ difficulty: 'pilot' });
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 6000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    // 45° off the nose: inside the gimbal, outside the lock cone
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(14000, 6000, -14000), heading: 0, speed: 250 });
    w.controllers.set(mig.id, (ac) => ac.velocity.copy(f35.velocity)); // keep the geometry
    w.run(0.3);
    w.combat.designate(f35, mig.id, w);
    w.run(2);
    expect(f35.radar.designatedId).toBe(mig.id);
    expect(f35.radar.lockedId).toBeNull();
    expect(f35.radar.lockProgress).toBe(0);
    // bring it to 20° off the nose → locks
    mig.position.set(Math.sin(0.35) * 20000, 6000, -Math.cos(0.35) * 20000);
    w.run(1.2);
    expect(f35.radar.lockedId).toBe(mig.id);
    // 50° off the nose: the established lock holds inside the ±60° gimbal
    mig.position.set(Math.sin(0.87) * 20000, 6000, -Math.cos(0.87) * 20000);
    w.run(3);
    expect(f35.radar.lockedId).toBe(mig.id);
    // 75°: outside the gimbal → lost after ~2 s
    mig.position.set(Math.sin(1.3) * 20000, 6000, -Math.cos(1.3) * 20000);
    w.run(1.5);
    expect(f35.radar.lockedId).toBe(mig.id);
    w.run(1);
    expect(f35.radar.lockedId).toBeNull();
    // leaving the cone before the lock completes: progress decays
    mig.position.set(0, 6000, -20000);
    w.run(0.3);
    w.combat.designate(f35, mig.id, w);
    w.run(0.5);
    const p = f35.radar.lockProgress;
    expect(p).toBeGreaterThan(0.3);
    mig.position.set(Math.sin(0.87) * 20000, 6000, -Math.cos(0.87) * 20000);
    w.run(0.5);
    expect(f35.radar.lockProgress).toBeLessThan(p);
    expect(f35.radar.lockedId).toBeNull();
  });

  it('TGT cycles designation and drops the lock; with one bandit it toggles lock / break-lock', () => {
    const w = new FakeWorld({ difficulty: 'recruit' });
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 6000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    const a = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -15000), heading: 0, speed: 250 });
    w.run(0.3);
    expect(f35.radar.designatedId).toBe(a.id);
    w.combat.cycleTarget(f35, w); // single candidate → command lock
    w.run(0.8);
    expect(f35.radar.lockedId).toBe(a.id);
    w.combat.cycleTarget(f35, w); // → break lock (silent TWS track)
    expect(f35.radar.lockedId).toBeNull();
    w.run(1.5);
    expect(f35.radar.lockedId).toBeNull();
    const b = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(3000, 6000, -25000), heading: 0, speed: 250 });
    w.run(0.3);
    w.combat.designate(f35, a.id, w);
    w.run(0.8);
    expect(f35.radar.lockedId).toBe(a.id);
    w.combat.cycleTarget(f35, w); // next bandit: lock on A dropped, lock commanded on B
    expect(f35.radar.designatedId).toBe(b.id);
    expect(f35.radar.lockedId).toBeNull();
    w.run(0.8);
    expect(f35.radar.lockedId).toBe(b.id);
  });

  it('EMCON: radar silent keeps DAS/datalink tracks, drops radar tracks, and the target gets no RWR warning', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 6000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    const near = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -12000), heading: 0, speed: 250 });
    const far = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -30000), heading: 0, speed: 250 });
    w.run(0.5);
    w.combat.designate(f35, near.id, w);
    w.run(2);
    // radar on: tracked + locked → the MiG hears a track
    expect(f35.radar.lockedId).toBe(near.id);
    expect(near.rwr.some((r) => r.sourceId === f35.id && r.state === 'track')).toBe(true);
    // far MiG: in radar range but outside the LPI search intercept range → silent RWR
    expect(far.rwr.some((r) => r.sourceId === f35.id)).toBe(false);
    expect(f35.radar.contacts.find((c) => c.id === far.id)?.source).toBe('radar');

    w.combat.setRadarEmitting(f35, false, w);
    w.run(1);
    expect(f35.radar.lockedId).toBeNull();
    const cNear = f35.radar.contacts.find((c) => c.id === near.id);
    expect(cNear?.source).toBe('das'); // DAS keeps the close one
    expect(near.rwr.some((r) => r.sourceId === f35.id)).toBe(false);
    w.run(5);
    expect(f35.radar.contacts.some((c) => c.id === far.id)).toBe(false); // radar-only track lost
  });

  it('datalink shares a wingman’s radar track with a silent player', () => {
    const w = new FakeWorld();
    const lead = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 6000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    const wing = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(3000, 6000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    const bandit = w.spawnAircraft({ type: 'su27', team: 'red', position: v3(0, 6000, -40000), heading: Math.PI, speed: 250 });
    w.combat.setRadarEmitting(lead, false, w);
    w.run(1);
    const c = lead.radar.contacts.find((k) => k.id === bandit.id);
    expect(c?.source).toBe('datalink');
    expect(lead.radar.contacts.some((k) => k.id === wing.id && k.team === 'blue')).toBe(true);
  });

  it('DAS cues a silent F-35 onto any missile launch within 30 km', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 6000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    w.combat.setRadarEmitting(f35, false, w);
    const shooter = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(15000, 6000, -20000), heading: Math.PI / 2, speed: 250 });
    const victim = w.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(27000, 6000, -20000), heading: -Math.PI / 2, speed: 250 });
    w.run(0.5);
    shooter.radar.designatedId = victim.id;
    w.run(4);
    expect(f35.radar.contacts.some((c) => c.id === shooter.id && c.source !== 'datalink')).toBe(false);
    expect(w.combat.fire(shooter, w, 'aim120', victim.id)).not.toBeNull();
    const c = f35.radar.contacts.find((k) => k.id === shooter.id);
    expect(c?.source).toBe('das');
  });

  it('terrain masks the radar', () => {
    const wall = { x0: -500, x1: 500, z0: -12000, z1: -11000, h: 5000 };
    const w = new FakeWorld({ terrain: new FlatTerrain(0, [wall]) });
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 1000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 1000, -30000), heading: 0, speed: 250 });
    w.run(1);
    expect(f35.radar.contacts.some((c) => c.id === mig.id)).toBe(false);
    mig.position.y = 8000;
    f35.position.y = 8000;
    w.run(1);
    expect(f35.radar.contacts.some((c) => c.id === mig.id)).toBe(true);
  });

  it('cycleTarget orders threats first, then in-front, then range', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 6000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    const nearFront = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -15000), heading: 0, speed: 250 });
    const farFront = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -35000), heading: 0, speed: 250 });
    const threat = w.spawnAircraft({ type: 'su35', team: 'red', position: v3(8000, 6000, -45000), heading: Math.PI, speed: 250 });
    w.run(0.5);
    threat.radar.lockedId = f35.id; // it has us locked
    w.combat.designate(f35, null, w);
    const order: number[] = [];
    for (let i = 0; i < 3; i++) {
      w.combat.cycleTarget(f35, w);
      order.push(f35.radar.designatedId!);
    }
    expect(order).toEqual([threat.id, nearFront.id, farFront.id]);
    w.combat.cycleTarget(f35, w);
    expect(f35.radar.designatedId).toBe(threat.id);
    // look-designate
    w.combat.designateNearestTo(f35, new Vector3(0, 0, -1), w);
    expect([nearFront.id, farFront.id]).toContain(f35.radar.designatedId);
  });
});

describe('combat: shoot list', () => {
  /**
   * Player F-35 heading north at three bandits coming head-on (A nearest): one-way drones flying a
   * route past the jet (the swarm the shoot list is for), or fighters.
   */
  function threeBandits(drones = true) {
    const w = new FakeWorld({ difficulty: 'veteran' });
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 6000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    const a = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -15000), heading: Math.PI, speed: 250 });
    const b = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(1500, 6000, -20000), heading: Math.PI, speed: 250 });
    const c = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(-1500, 6000, -25000), heading: Math.PI, speed: 250 });
    if (drones) for (const x of [a, b, c]) x.oneWay = createOneWay({ target: v3(x.position.x, 0, 40_000), altitude: 6000, speed: 250 });
    w.run(0.5);
    return { w, f35, a, b, c };
  }
  const shotAt = (w: FakeWorld, f35: AircraftEntity) => w.missiles.filter((m) => m.alive && m.shooterId === f35.id).map((m) => m.targetId);

  it('after an AMRAAM launch the TD box steps to the next unengaged bandit; FIRE goes at it at once, TGT steps on', () => {
    const { w, f35, a, b, c } = threeBandits();
    expect(f35.radar.designatedId).toBe(a.id);
    w.combat.fire(f35, w, 'aim120'); // bay doors open, then the release
    w.run(0.5);
    expect(shotAt(w, f35)).toEqual([a.id]);
    expect(f35.radar.designatedId).toBe(b.id);
    w.combat.fire(f35, w, 'aim120'); // off the TWS track, no lock needed
    w.run(0.5);
    expect(shotAt(w, f35)).toEqual([a.id, b.id]);
    expect(f35.radar.designatedId).toBe(c.id);
    // the box was commanded: TGT steps on (every other bandit is engaged → the full list)
    w.combat.cycleTarget(f35, w);
    expect(f35.radar.designatedId).toBe(a.id);
  });

  it('against fighters the box stays on the bandit just fired at (playtest r2: the step dropped that lock)', () => {
    const { w, f35, a } = threeBandits(false);
    expect(f35.radar.designatedId).toBe(a.id);
    w.combat.fire(f35, w, 'aim120');
    w.run(0.5);
    expect(shotAt(w, f35)).toEqual([a.id]);
    expect(f35.radar.designatedId).toBe(a.id);
  });

  it('an AI launch leaves its own designation alone', () => {
    const w = new FakeWorld();
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, 0), heading: 0, speed: 250 });
    const f1 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 6000, -12000), heading: 0, speed: 250, loadout: 'a2a_beast' });
    w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(800, 6000, -14000), heading: 0, speed: 250, loadout: 'a2a_beast' });
    w.run(0.5);
    w.combat.designate(mig, f1.id, w);
    w.combat.fire(mig, w, 'aim9x', f1.id);
    w.run(0.2);
    expect(mig.radar.designatedId).toBe(f1.id);
  });

  it('TGT NEXT skips a bandit our missile is already flying at', () => {
    const { w, f35, a, b, c } = threeBandits();
    w.combat.designate(f35, a.id, w);
    w.combat.fire(f35, w, 'aim120', b.id); // a shot at B; the box stays on A (unengaged)
    w.run(0.5);
    expect(shotAt(w, f35)).toEqual([b.id]);
    expect(f35.radar.designatedId).toBe(a.id);
    w.combat.cycleTarget(f35, w);
    expect(f35.radar.designatedId).toBe(c.id);
    w.combat.cycleTarget(f35, w);
    expect(f35.radar.designatedId).toBe(a.id);
  });
});

describe('combat: RWR & MAWS', () => {
  it('RWR shows a locking fighter as track and a SAM search radar', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 3000, 0), heading: 0, speed: 250, loadout: 'a2a_beast' });
    const su = w.spawnAircraft({ type: 'su35', team: 'red', position: v3(0, 3000, -18000), heading: Math.PI, speed: 250 });
    const sa6 = w.spawnSam({ type: 'sa6', team: 'red', position: v3(20000, 0, 0) });
    const newRwr = w.record('rwr:new');
    w.run(0.5);
    su.radar.designatedId = f35.id;
    w.run(4);
    const fighter = f35.rwr.find((r) => r.sourceId === su.id);
    expect(fighter).toMatchObject({ kind: 'fighter', symbol: '35' });
    expect(su.radar.lockedId).toBe(f35.id);
    expect(fighter!.state).toBe('track');
    expect(Math.abs(fighter!.bearing)).toBeLessThan(0.2);
    const sam = f35.rwr.find((r) => r.sourceId === sa6.id);
    expect(sam?.kind).toBe('sam');
    expect(sam?.symbol).toBe('6');
    expect(sam!.bearing).toBeGreaterThan(1.2); // off the right wing
    expect(newRwr.some((e) => e.contact.sourceId === su.id)).toBe(true);
    expect(sa6.known).toBe(true);
  });

  it('MAWS (DAS) reports an incoming missile with bearing and time to impact', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 3000, 0), heading: 0, speed: 250, loadout: 'a2a_beast' });
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 3000, -2500), heading: Math.PI, speed: 250 });
    mig.selectedWeapon = 'aim9x';
    w.run(0.3);
    mig.radar.designatedId = f35.id;
    // beast-mode F-35 in afterburner is a juicy IR target
    f35.flight.afterburner = 1;
    w.run(0.2);
    const m = w.combat.fire(mig, w, 'aim9x', f35.id);
    expect(m).not.toBeNull();
    w.run(0.3);
    expect(f35.incoming.length).toBe(1);
    const inc = f35.incoming[0];
    expect(inc.guidance).toBe('ir');
    expect(Math.abs(inc.bearing)).toBeLessThan(0.3);
    expect(inc.distance).toBeLessThan(2600);
    expect(inc.timeToImpact).toBeGreaterThan(0.5);
    expect(inc.timeToImpact).toBeLessThan(6);
  });

  it('IR seeker: search growl with nothing in the cone, lock tone on a hot target', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 3000, 0), heading: 0, speed: 250, loadout: 'a2a_beast' });
    w.combat.selectWeapon(f35, 'aim9x', w);
    w.run(0.1);
    expect(w.combat.irSeekerState(f35).state).toBe('search');
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(300, 3000, -3000), heading: 0, speed: 250 });
    w.run(0.3);
    const s = w.combat.irSeekerState(f35);
    expect(s.state).toBe('locked');
    expect(s.targetId).toBe(mig.id);
    expect(s.direction!.z).toBeLessThan(-0.9);
    w.combat.selectWeapon(f35, 'aim120', w);
    w.run(0.1);
    expect(w.combat.irSeekerState(f35).state).toBe('off');
  });
});
