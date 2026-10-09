/**
 * F35-A UI — the briefing hangar's loadout cards (unit-tested in tests/missions-loadout-maritime.test.ts).
 */
import type { MissionDef } from '../core/contracts';
import { LOADOUTS } from '../core/data';
import type { LoadoutId } from '../core/types';

/**
 * The briefing hangar's loadout cards: the mission's allowedLoadouts (known ones only; just the
 * recommended one if the list is empty), and the card picked when the briefing opens (the
 * recommended loadout if it is offered, else the first card).
 */
export function hangarLoadouts(m: Pick<MissionDef, 'allowedLoadouts' | 'recommendedLoadout'>): { cards: LoadoutId[]; initial: LoadoutId } {
  const cards = (m.allowedLoadouts?.length ? m.allowedLoadouts : [m.recommendedLoadout]).filter((id) => LOADOUTS[id]);
  const initial = cards.includes(m.recommendedLoadout) ? m.recommendedLoadout : (cards[0] ?? 'a2a_stealth');
  return { cards, initial };
}
