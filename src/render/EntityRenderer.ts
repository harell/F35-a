/**
 * STUB EntityRenderer — to be replaced by the MODELS agent. Keeps export `createEntityRenderer`.
 */
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';
import type { CreateEntityRenderer, EntityRendererApi } from '../core/contracts';

export const createEntityRenderer: CreateEntityRenderer = (scene, world) => {
  const objs = new Map<number, Object3D>();
  let playerVisible = true;
  const api: EntityRendererApi = {
    update() {
      for (const ac of world.aircraft) {
        let o = objs.get(ac.id);
        if (!o) {
          o = new Mesh(new BoxGeometry(10, 2, 16), new MeshStandardMaterial({ color: ac.team === 'blue' ? 0x778899 : 0x995544 }));
          scene.add(o);
          objs.set(ac.id, o);
        }
        o.position.copy(ac.position);
        o.quaternion.copy(ac.quaternion);
        o.visible = ac.isPlayer ? playerVisible : true;
      }
    },
    getEyeOffset: () => new Vector3(0, 1.1, -4.5),
    getObject: (id) => objs.get(id) ?? null,
    setPlayerVisible(v) { playerVisible = v; },
    dispose() { objs.forEach((o) => scene.remove(o)); objs.clear(); },
  };
  return api;
};
