/**
 * The touch FIRE button's label (playtest 2026-10-10, R31-8): with the gun selected it read 'GUN 400'
 * beside the GUN button's identical 'GUN 400', and a casual player couldn't tell which to press.
 */
import { describe, expect, it } from 'vitest';
import { fireButtonLabel } from '../src/input/Input';

describe('the FIRE button label', () => {
  it('reads FIRE over the gun rounds with the gun selected, never a second "GUN n"', () => {
    expect(fireButtonLabel('gun', 400)).toEqual({ label: 'FIRE', sub: 'GUN 400' });
    expect(fireButtonLabel('gun', 400).label).not.toBe('GUN');
  });

  it('names a missile or bomb by its short name and count', () => {
    expect(fireButtonLabel('aim120', 6)).toEqual({ label: 'AMRAAM', sub: '×6' });
    expect(fireButtonLabel('gbu53', 2).label).toBe('GBU-53');
  });
});
