/**
 * MISSIONS — schema features on a synthetic mission: time on station, RTB after completion,
 * reach (low level), destroy_sams, reveal, set_waypoint, end action, pending spawns, commit
 * (GCI), missionById.
 */
import { describe, expect, it } from 'vitest';
import type { MissionDef } from '../src/core/contracts';
import { missionById, validateMission } from '../src/missions';
import { emptyScript, type MissionScript } from '../src/missions/schema';
import { harness, killGroup, shieldPlayer } from './missions-helpers';

function def(script: Partial<MissionScript>, over: Partial<MissionDef> = {}): MissionDef {
  return {
    id: 'x01',
    kind: 'training',
    index: 1,
    title: 'Synthetic',
    subtitle: 'test',
    theater: 'desert',
    timeOfDay: 'day',
    weather: 'clear',
    seed: 1,
    briefing: ['test'],
    objectiveText: ['test'],
    recommendedLoadout: 'a2a_stealth',
    allowedLoadouts: ['a2a_stealth'],
    player: { x: 0, z: 0, altitude: 3000, heading: 0, speed: 230 },
    features: [],
    intel: [],
    script: { ...emptyScript(), ...script },
    ...over,
  };
}

describe('mission schema features', () => {
  it('time on station inside an area, then RTB', () => {
    const d = def({
      objectives: [
        { id: 'o_cap', kind: 'survive', seconds: 3, area: { x: 0, z: 0, radius: 5000 }, label: 'Hold CAP', primary: true },
        { id: 'o_rtb', kind: 'rtb', x: 20000, z: 0, radius: 2000, label: 'RTB', primary: true },
      ],
      waypoints: [{ id: 'home', label: 'Home', kind: 'rtb', x: 20000, z: 0 }],
    });
    expect(validateMission(d)).toEqual([]);
    const h = harness(d);
    h.run(2);
    expect(h.runner.objectives[0].state).toBe('active');
    expect(h.runner.objectives[1].state).toBe('pending');
    h.run(2);
    expect(h.runner.objectives[0].state).toBe('complete');
    expect(h.runner.objectives[1].state).toBe('active');
    expect(h.runner.state).toBe('running');
    h.world.player!.position.set(20500, 3000, 0);
    h.run(0.3);
    expect(h.runner.state).toBe('success');
  });

  it('reach with an altitude band (low level), destroy_sams, reveal and set_waypoint', () => {
    const d = def({
      sams: [
        { id: 's1', group: 'sams', type: 'sa8', x: 30000, z: -20000, known: false },
        { id: 's2', group: 'sams', type: 'zsu23', x: 30500, z: -20000, known: false },
      ],
      objectives: [
        { id: 'o_low', kind: 'reach', x: 5000, z: 0, radius: 1000, below: 100, label: 'Low pass', primary: false },
        { id: 'o_sams', kind: 'destroy_sams', x: 30000, z: -20000, radius: 2000, label: 'Kill SAMs', primary: true },
      ],
      waypoints: [
        { id: 'a', label: 'A', kind: 'nav', x: -20000, z: 20000 },
        { id: 'b', label: 'B', kind: 'target', x: 30000, z: -20000, objective: 'o_sams' },
      ],
      triggers: [{ id: 't', when: { kind: 'time', t: 1 }, actions: [{ kind: 'reveal', group: 'sams' }, { kind: 'set_waypoint', id: 'b' }] }],
    });
    expect(validateMission(d)).toEqual([]);
    const h = harness(d);
    expect(h.world.sams.every((s) => !s.known)).toBe(true);
    expect(h.runner.currentWaypoint?.id).toBe('a');
    h.run(1.3);
    expect(h.world.sams.every((s) => s.known)).toBe(true);
    expect(h.runner.currentWaypoint?.id).toBe('b');
    const p = h.world.player!;
    p.position.set(5000, 800, 0); // too high
    h.run(0.2);
    expect(h.runner.objectives[0].state).toBe('active');
    p.position.set(5000, 60, 0);
    h.run(0.2);
    expect(h.runner.objectives[0].state).toBe('complete');
    killGroup(h, 'sams');
    h.run(0.3);
    expect(h.runner.state).toBe('success');
    expect(h.runner.result(h.world).kills.sam).toBe(2);
  });

  it('end action and delayed / conditional spawns', () => {
    const d = def({
      groups: [
        { id: 'late', type: 'mig29', team: 'red', count: 2, x: 20000, z: -20000, altitude: 5000, heading: 225, speed: 240, role: 'fighter', spawn: { kind: 'time', t: 2 } },
        { id: 'area', type: 'su27', team: 'red', count: 1, x: 20000, z: 20000, altitude: 5000, heading: 315, speed: 240, role: 'fighter', spawn: { kind: 'area', x: 0, z: -10000, radius: 2000 } },
      ],
      objectives: [{ id: 'o', kind: 'destroy', groups: ['late', 'area'], label: 'x', primary: true }],
      triggers: [{ id: 'bail', when: { kind: 'group_destroyed', group: 'late' }, delay: 1, actions: [{ kind: 'end', success: false, reason: 'Scripted end' }] }],
    });
    expect(validateMission(d)).toEqual([]);
    const h = harness(d);
    expect(h.world.aircraft).toHaveLength(1);
    h.run(2.5);
    expect(h.world.aircraft.filter((a) => a.groupId === 'late')).toHaveLength(2);
    expect(h.runner.objectives[0].progress).toEqual({ done: 0, total: 3 });
    h.world.player!.position.set(0, 3000, -10000);
    h.run(0.3);
    expect(h.world.aircraft.filter((a) => a.groupId === 'area')).toHaveLength(1);
    killGroup(h, 'late');
    h.run(1.5);
    expect(h.runner.state).toBe('failed');
    expect(h.runner.result(h.world).reason).toBe('Scripted end');
  });

  it('GCI vectors a patrolling fighter group onto the player after commitAfter', () => {
    const d = def({
      groups: [{ id: 'cap', type: 'mig29', team: 'red', count: 1, x: 20000, z: -20000, altitude: 5000, heading: 225, speed: 240, role: 'cap', commitAfter: 3, task: { kind: 'patrol', x: 20000, z: -20000, radius: 5000, altitude: 5000 } }],
      objectives: [{ id: 'o', kind: 'destroy', groups: ['cap'], label: 'x', primary: true }],
    });
    const h = harness(d);
    h.run(2, () => shieldPlayer(h));
    expect(h.ai.retasked).toHaveLength(0);
    h.run(2, () => shieldPlayer(h));
    expect(h.ai.retasked).toEqual([{ kind: 'attack', targetId: h.world.player!.id }]);
  });

  it('missionById resolves campaign, training and instant ids', () => {
    expect(missionById('c05')?.title).toBe('Backfire');
    expect(missionById('t02')?.kind).toBe('training');
    const ia = missionById('ia_sam_gauntlet_desert');
    expect(ia?.kind).toBe('instant');
    expect(ia?.theater).toBe('desert');
    expect(missionById('ia_nope_auckland')).toBeNull();
    expect(missionById('zzz')).toBeNull();
  });
});
