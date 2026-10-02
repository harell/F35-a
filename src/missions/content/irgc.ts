/**
 * F35-A — the IRGC campaign over Auckland and the Hauraki Gulf (epic #72): Shahed one-way attack
 * drones over the city and fast attack boats in the Gulf, launched from an IRGC mother ship.
 *
 * Empty until its first missions land: g01 "Shahed swarm on the Sky Tower" (#78) and g02
 * "Straight Outta Hauraki" (#82). Mission ids are g01, g02, … ("Gulf"), next to Southern Cross's
 * c01–c12; every id must stay unique across campaigns (progress is keyed by mission id).
 */
import type { CampaignDef } from '../../core/contracts';

/**
 * Working title, shown in the menus. The campaign's real name ("Operation …") is not decided yet
 * (epic #72, "Not decided yet"): change it here and everything that names the campaign follows.
 */
export const IRGC_CAMPAIGN_NAME = 'IRGC Campaign';

export const IRGC_CAMPAIGN: CampaignDef = {
  id: 'irgc',
  name: IRGC_CAMPAIGN_NAME,
  description: 'Shahed drone swarms over the city, fast attack boats in the Hauraki Gulf',
  missions: [],
};
