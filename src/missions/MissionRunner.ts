/** STUB — to be replaced by the MISSIONS agent. */
import { Vector3 } from 'three';
import type { CreateMissionRunner, MissionResult, MissionRunnerApi, ObjectiveStatus, Waypoint } from '../core/contracts';
import type { LoadoutId } from '../core/types';
import type { SimWorld } from '../sim/api';

export const createMissionRunner: CreateMissionRunner = (def, deps) => {
  const objectives: ObjectiveStatus[] = [{ id: 'fly', label: 'Fly', state: 'active', primary: true }];
  const waypoints: Waypoint[] = [];
  const runner: MissionRunnerApi = {
    def,
    state: 'running',
    objectives,
    waypoints,
    currentWaypoint: null,
    hint: null,
    setup(world: SimWorld, loadout: LoadoutId) {
      const p = def.player;
      world.spawnAircraft({
        type: 'f35a',
        team: 'blue',
        isPlayer: true,
        position: new Vector3(p.x, p.altitude, p.z),
        heading: (p.heading * Math.PI) / 180,
        speed: p.speed,
        loadout,
        callsign: 'Viper 1',
      });
    },
    update(_world: SimWorld, _dt: number) {},
    result(world: SimWorld): MissionResult {
      return {
        missionId: def.id,
        title: def.title,
        success: true,
        reason: 'stub',
        difficulty: deps.difficulty.id,
        time: world.time,
        score: 0,
        grade: 'C',
        kills: { air: 0, sam: 0, ground: 0 },
        friendlyLosses: 0,
        shotsFired: 0,
        hits: 0,
        accuracy: 0,
        damageTaken: 0,
        objectives,
      };
    },
  };
  return runner;
};
