/**
 * DATA — one naming pattern for real hardware (#211, "Naming rule for hardware"):
 * - Western weapons: the designation, then the nickname ("AIM-120D AMRAAM", "AIM-9X Sidewinder").
 * - Russian missiles: the designation, then the NATO designation and reporting name in brackets
 *   ("R-73 (AA-11 Archer)", "3M9 (SA-6 Gainful)", "9M39 Igla (SA-18 Grouse)").
 * - Aircraft and SAM systems: the designation in `name`, the NATO reporting name in `nato`
 *   ("MiG-29" + "Fulcrum", "2K12 Kub" + "SA-6 Gainful").
 * The player's weapon reads the same in the stores list (WEAPON_INFO), the codex and the missile itself.
 */
import { describe, expect, it } from 'vitest';
import { AIRCRAFT_INFO, SAM_INFO, WEAPON_INFO } from '../src/core/data';
import { MUNITIONS } from '../src/sim/weapons/defs';
import { CODEX_WEAPONS } from '../src/ui/codex/data';
import { AIRCRAFT_PERF } from '../src/sim/flight/aircraftData';
import { WEAPON_HUD } from '../src/hud/hmd/format';
import { WEAPON_NAME } from '../src/hud/cockpit/pages';

describe('hardware names (#211)', () => {
  it('Russian missiles show the NATO designation and reporting name in brackets', () => {
    const pattern = /^\S+( Igla)? \((AA|SA)-\d+ [A-Z][a-z]+\)$/;
    for (const id of ['r73', 'r27', 'r77', 'm_3m9', 'm_9m330', 'm_igla'] as const) expect(MUNITIONS[id].name, id).toMatch(pattern);
    expect(MUNITIONS.m_igla.name).toBe('9M39 Igla (SA-18 Grouse)');
  });

  it('SAM missiles carry the same reporting name as their system', () => {
    expect(MUNITIONS.m_3m9.name).toContain(SAM_INFO.sa6.nato);
    expect(MUNITIONS.m_9m330.name).toContain(SAM_INFO.sa15.nato);
  });

  it("the player's weapons read the same on the missile, in the stores list and in the codex", () => {
    for (const id of ['aim120', 'aim9x', 'gbu31', 'gbu53', 'aargm'] as const) {
      expect(MUNITIONS[id].name, id).toBe(WEAPON_INFO[id].name);
      expect(CODEX_WEAPONS.find((w) => w.id === id)?.name, id).toBe(WEAPON_INFO[id].name);
    }
    expect(CODEX_WEAPONS.find((w) => w.id === 'gun')?.name).toBe(WEAPON_INFO.gun.name);
  });

  it('one weapon, one short name: the GBU-53/B reads GBU-53 and the AARGM-ER AARGM on the FIRE button, the HMD, the SMS page and its missile label (r1 1.2-h, r2 F11)', () => {
    const short = WEAPON_INFO.gbu53.short;
    expect(short).toBe('GBU-53');
    expect(WEAPON_INFO.gbu53.name.startsWith(short)).toBe(true);
    expect(WEAPON_HUD.gbu53).toBe(short);
    expect(WEAPON_NAME.gbu53).toBe(short);
    expect(MUNITIONS.gbu53.short).toBe(short);
    // the AARGM likewise (r2 F11: AARGM on the FIRE button, AGM-88G on the SMS page): its name, as the
    // lessons and briefings say it, in its full name 'AGM-88G AARGM-ER'
    const arm = WEAPON_INFO.aargm.short;
    expect(arm).toBe('AARGM');
    expect(WEAPON_INFO.aargm.name).toContain(arm);
    expect(WEAPON_HUD.aargm).toBe(arm);
    expect(WEAPON_NAME.aargm).toBe(arm);
    expect(MUNITIONS.aargm.short).toBe(arm);
    // and every player weapon's missile label is its stores-list short name
    for (const id of ['aim120', 'gbu31', 'gbu53', 'aargm'] as const) expect(MUNITIONS[id].short, id).toBe(WEAPON_INFO[id].short);
  });

  it('fighters: designation plus reporting name, the same in both tables', () => {
    for (const t of ['mig29', 'su27', 'su35', 'su57'] as const) {
      expect(AIRCRAFT_PERF[t].name, t).toBe(`${AIRCRAFT_INFO[t].name} ${AIRCRAFT_INFO[t].nato}`);
    }
  });

  it('radar SAM systems: designation plus NATO designation and reporting name', () => {
    for (const t of ['sa6', 'sa15'] as const) expect(SAM_INFO[t].nato, t).toMatch(/^SA-\d+ [A-Z][a-z]+$/);
  });
});
