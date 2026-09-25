/**
 * STUB Environment — to be replaced by the WORLD agent. Keeps export `createEnvironment`.
 */
import { Color, Fog, HemisphereLight, DirectionalLight, Mesh, MeshLambertMaterial, PlaneGeometry, Vector3 } from 'three';
import type { CreateEnvironment, EnvironmentApi } from '../core/contracts';
import type { TerrainQuery } from '../sim/api';

export const createEnvironment: CreateEnvironment = async (scene, _renderer, opts) => {
  const terrain: TerrainQuery = {
    size: 80_000,
    heightAt: () => 50,
    surfaceHeightAt: () => 50,
    isWater: () => false,
    lineOfSight: () => true,
    raycast: (o, d, max) => (d.y < 0 ? Math.min(max, (o.y - 50) / -d.y) : -1),
  };
  scene.background = new Color(0x87a9d0);
  scene.fog = new Fog(0x87a9d0, 1000, opts.quality.drawDistance);
  const ground = new Mesh(new PlaneGeometry(80_000, 80_000).rotateX(-Math.PI / 2), new MeshLambertMaterial({ color: 0xb8a078 }));
  ground.position.y = 50;
  scene.add(ground, new HemisphereLight(0xffffff, 0x886644, 1.2));
  const sun = new DirectionalLight(0xffffff, 2);
  sun.position.set(1, 2, 1);
  scene.add(sun);
  opts.onProgress?.(1, 'Terrain');
  const env: EnvironmentApi = {
    terrain,
    sunDirection: new Vector3(1, 2, 1).normalize(),
    isNight: false,
    fogColor: 0x87a9d0,
    update() {},
    dispose() { scene.remove(ground); },
  };
  return env;
};
