/** STUB Cockpit — to be replaced by the HUD agent. Keeps export `createCockpit`. */
import type { CockpitApi, CreateCockpit } from '../core/contracts';
export const createCockpit: CreateCockpit = () => {
  const c: CockpitApi = { visible: false, update() {}, render() {}, resize() {}, handleTap() { return false; }, dispose() {} };
  return c;
};
