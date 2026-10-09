/**
 * A lesson's own scripted hints come before the built-in weapon hints (playtest r2 2.1-f): T06 showed
 * 'Close in: fire the AARGM inside 10 km' at 1.3 s, before its own first step 'Go LOW' (t = 3 s), and
 * again at 25.6 s with the jet still at 2,950 ft, before its AARGM step (h2, 13 km from the SA-6).
 */
import { describe, expect, it } from 'vitest';
import { T06, T06_SAM } from '../src/missions/content/training';
import { harness } from './missions-helpers';
import { FlatTerrain } from './combat-helpers';

describe('scripted hints before the auto weapon hints', () => {
  it('T06 with the AARGM selected and the SA-6 designated: Go LOW first, no AARGM auto hint before its own step', () => {
    const h = harness(T06, 'pilot', undefined, new FlatTerrain(0));
    const w = h.world;
    const p = w.player!;
    w.combat.selectWeapon(p, 'aargm', w);
    const sa6 = w.sams.find((s) => s.type === 'sa6')!;
    w.combat.designate(p, sa6.id, w);
    const shown: { t: number; text: string; km: number }[] = [];
    h.run(40, () => {
      p.health = p.maxHealth;
      const text = h.runner.hint;
      if (text && shown[shown.length - 1]?.text !== text) shown.push({ t: w.time, text, km: Math.hypot(sa6.position.x - p.position.x, sa6.position.z - p.position.z) / 1000 });
      return false;
    });
    expect(shown.length).toBeGreaterThan(0);
    expect(shown[0].text).toMatch(/Go LOW/);
    // (T06's own AARGM step, h2: 'AARGM on FIRE, the SA-6 boxed: …')
    const lessonArm = shown.findIndex((s) => s.text === T06.script.hints!.find((x) => x.id === 'h2')!.text);
    for (const [i, s] of shown.entries()) {
      if (/^Close in: fire the AARGM/.test(s.text)) expect(lessonArm >= 0 && i > lessonArm, `${s.t.toFixed(1)} s ${s.km.toFixed(1)} km: ${s.text}`).toBe(true);
    }
    // the jet starts beyond h2's 13 km
    expect(Math.hypot(T06_SAM.start.x - sa6.position.x, T06_SAM.start.z - sa6.position.z)).toBeGreaterThan(13_000);
  });
});
