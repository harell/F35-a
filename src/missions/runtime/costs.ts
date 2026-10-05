/**
 * F35-A — the debrief's cost summary (#201): what the sortie cost against the cost of the job done
 * another way. A mission asks for it with MissionScript.costSummary (g03: one volunteer's trap).
 *
 * Unit costs, US dollars (rounded; look them up again before changing them):
 *  - F-35A cost per flight hour: about US$35,000. GAO: DoD's estimate of US$6.6 million a year to
 *    operate and sustain each F-35A (constant 2012 dollars) over 187 flight hours a year; the F-35 JPO
 *    reported about US$33,600 for FY2020.
 *  - AGM-88G AARGM-ER: US$6.149 million, the programme unit cost in the AARGM-ER Major Selected
 *    Acquisition Report, December 2023 (it includes development: a round off the line costs less).
 *  - GBU-53/B StormBreaker: US$195,000, the US Air Force's unit cost.
 * Converted to New Zealand dollars at NZD_PER_USD (about the 2025–26 rate).
 */
import type { WeaponId } from '../../core/types';

/** US$ per F-35A flight hour, and per weapon fired. */
export const UNIT_COST_USD = {
  flightHour: 35_000,
  aargm: 6_149_000,
  gbu53: 195_000,
} as const;
/** New Zealand dollars per US dollar. */
export const NZD_PER_USD = 1.7;

/** Debrief rows: what was spent and what it was compared with (NZ$). */
export interface CostSummary {
  /** Flight time (h) and its cost. */
  hours: number;
  flightNzd: number;
  /** Weapons fired that have a unit cost: count and cost. */
  weapons: { weapon: WeaponId; count: number; nzd: number }[];
  totalNzd: number;
  /** "Volunteer's trap, for comparison", NZ$. */
  comparison: { label: string; nzd: number };
  /** "Stoats removed", how many. */
  removed: { label: string; count: number };
}

/**
 * The cost summary of a sortie: `seconds` in the air, `fired` weapons by id, and the mission's
 * comparison and removed-count lines.
 */
export function costSummary(seconds: number, fired: Partial<Record<WeaponId, number>>, comparison: { label: string; nzd: number }, removed: { label: string; count: number }): CostSummary {
  const hours = Math.max(0, seconds) / 3600;
  const flightNzd = hours * UNIT_COST_USD.flightHour * NZD_PER_USD;
  const weapons: CostSummary['weapons'] = [];
  for (const weapon of ['aargm', 'gbu53'] as const) {
    const count = fired[weapon] ?? 0;
    if (count > 0) weapons.push({ weapon, count, nzd: count * UNIT_COST_USD[weapon] * NZD_PER_USD });
  }
  const totalNzd = flightNzd + weapons.reduce((n, w) => n + w.nzd, 0);
  return { hours, flightNzd, weapons, totalNzd, comparison, removed };
}

/** "NZ$1,234" / "NZ$10.5 million": whole dollars under a million, a million and up in millions. */
export function formatNzd(nzd: number): string {
  if (nzd >= 1e6) return `NZ$${(nzd / 1e6).toFixed(nzd >= 1e7 ? 1 : 2)} million`;
  return `NZ$${Math.round(nzd).toLocaleString('en-NZ')}`;
}
