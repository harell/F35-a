/**
 * STUB AI — to be replaced by the AI agent. Keeps the exported factory name `createAiBrain`.
 */
import type { AiBrain, CreateAiBrain } from '../sim/api';

export const createAiBrain: CreateAiBrain = (role) => {
  const brain: AiBrain = {
    role,
    update(ac) {
      ac.input.pitch = 0; ac.input.roll = 0; ac.input.throttle = 0.8;
    },
  };
  return brain;
};
