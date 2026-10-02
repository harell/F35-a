/**
 * Fixed text zones → occupancy (iteration 2 text-management fix).
 *
 * The HMD's fixed blocks (heading tape, speed / altitude columns, DLZ scale, weapon block, the top-left
 * objectives / damage / hint column, the kill feed, the external-view info block and radar inset) are
 * reserved in the occupancy registry right after the protected symbols and BEFORE any world-projected
 * label (contacts, SAMs, ground targets, waypoint, friendlies) or the pitch ladder is drawn. Labels then
 * dodge / drop instead of overprinting them, and the ladder knocks its rungs out under them.
 *
 * Blocks whose height depends on their content (column, kill feed, external block) use the extent they
 * had on the previous frame (one frame of lag, no allocation, no double layout).
 */
import { toFeet } from '../../core/math';
import { reserveBankScale } from './flight';
import { WEAPON_IS_BOMB } from './format';
import type { HudFrame } from './frame';
import { controlRects } from './layout';

/** Extents measured while drawing (previous frame). NaN = nothing drawn. */
export const zoneExt = {
  /** Top-left column bottom (objectives / damage / hint). */
  colBottom: NaN,
  /** External info block right edge / bottom. */
  extRight: NaN,
  extBottom: NaN,
  /** Kill feed left edge / bottom. */
  killLeft: NaN,
  killBottom: NaN,
  /** HMD weapon block top / bottom / right edge. */
  wpnTop: NaN,
  wpnBottom: NaN,
  wpnRight: NaN,
};

/** Forget the measured extents (mode change / teardown). */
export function resetZoneExtents(): void {
  zoneExt.colBottom = NaN;
  zoneExt.extRight = NaN;
  zoneExt.extBottom = NaN;
  zoneExt.killLeft = NaN;
  zoneExt.killBottom = NaN;
  zoneExt.wpnTop = NaN;
  zoneExt.wpnBottom = NaN;
  zoneExt.wpnRight = NaN;
}

/** Bottom of the heading tape band (ticks, numerals and the waypoint caret). */
export function tapeBottom(f: HudFrame): number {
  return f.L.tapeY + 58 * f.L.u;
}

/**
 * Bottom of the HMD speed column: the box, Mach, G, max G, AoA, the THR / AB line, and SPD BRK while
 * the speed brake is out (#62: a SAM label printed into "THR 94%", which the reservation missed).
 */
export function speedColumnBottom(f: HudFrame): number {
  const { L, p } = f;
  const brake = !!p && (p.input.airbrake || p.flight.surfaces.airbrake > 0.2);
  return L.boxY + 11 * L.u + L.line * (brake ? 6.2 : 5.2);
}

/**
 * Bottom of the HMD altitude column: the box, radar altitude (below 5000 ft AGL), VSI, and closure and
 * aspect / angels with an air target designated. As drawAltColumn decides: with both the RALT row and
 * a target, the aspect line is the 4th row (#62).
 */
export function altColumnBottom(f: HudFrame): number {
  const { L, p } = f;
  const t = f.target;
  const fourRows = !!p && !!t && t.kind === 'aircraft' && toFeet(p.flight.agl) < 5000;
  return L.boxY + 11 * L.u + L.line * (fourRows ? 4.4 : 3.4);
}

/**
 * Reserve every fixed text block of this view (level 0: text) so world-projected labels and the ladder
 * make way. Call after the protected symbols (FPM, target box, pipper, jet) and before the labels.
 */
export function reserveFixedZones(f: HudFrame): void {
  const { L, occ } = f;
  const u = L.u;
  if (f.mode === 'hmd') {
    // heading tape + caret band
    occ.add(L.cx - L.tapeHalfW - 8 * u, L.tapeY - 2, L.cx + L.tapeHalfW + 8 * u, tapeBottom(f));
    // speed column (box, Mach, G, max G, AoA) and altitude column (box, AGL / VSI lines)
    occ.add(L.spdRight - 78 * u, L.boxY - 13 * u, L.spdRight + 3 * u, speedColumnBottom(f));
    occ.add(L.altLeft - 3 * u, L.boxY - 13 * u, L.altLeft + 92 * u, altColumnBottom(f));
    // DLZ scale (only while a launch zone is shown)
    const z = f.zone;
    if (z && z.rMax > 0 && z.weapon !== 'gun' && !WEAPON_IS_BOMB[z.weapon]) {
      occ.add(L.dlzX - 10 * u, L.dlzTop - 18 * u, L.dlzX + 62 * u, L.dlzBottom + 18 * u);
    }
    reserveBankScale(f);
    if (Number.isFinite(zoneExt.wpnTop)) occ.add(L.wpnX - 4 * u, zoneExt.wpnTop - 8 * u, zoneExt.wpnRight + 4 * u, zoneExt.wpnBottom);
  } else if (f.mode === 'external') {
    if (Number.isFinite(zoneExt.extBottom)) occ.add(L.extX - 4 * u, L.extY - 2, zoneExt.extRight + 6 * u, zoneExt.extBottom);
    // radar inset
    occ.add(L.insetCx - L.insetR - 4 * u, L.insetCy - L.insetR - 4 * u, L.insetCx + L.insetR + 4 * u, L.insetCy + L.insetR + 12 * u);
  }
  // target camera window (PiP)
  if (L.pipW > 0) occ.add(L.pipX - 4 * u, L.pipY - 4 * u, L.pipX + L.pipW + 4 * u, L.pipY + L.pipH + 4 * u);
  // top-left column (objectives / damage / hint), as drawn last frame
  if (Number.isFinite(zoneExt.colBottom)) occ.add(L.colX - 6 * u, L.colY - 10 * u, L.colX + L.colW, zoneExt.colBottom);
  // kill feed (top right)
  if (Number.isFinite(zoneExt.killBottom)) occ.add(zoneExt.killLeft - 4 * u, L.killY - 10 * u, L.killX + 4 * u, zoneExt.killBottom);
  // the touch controls in the bottom band (throttle, FIRE, GUN, CMS, stick base): a contact's CIV or
  // type label moves or drops rather than print under a thumb (#62)
  for (const r of controlRects()) occ.add(r.x - 2 * u, r.y - 2 * u, r.x + r.w + 2 * u, r.y + r.h + 2 * u);
}
