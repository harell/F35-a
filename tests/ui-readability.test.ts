/**
 * Menu and briefing readability at 844×390 (issue #62, polish 4/5 of epic #84):
 *  - the briefing intel map never prints a label over another (T01's rings round the harbour);
 *  - mission card subtitles fit the two lines a card has on a 390 px tall screen (T02 lost 'drones');
 *  - the countermeasure lessons name the one CMS control (it drops chaff and flares together on
 *    every input), never chaff or flares as separate actions.
 */
import { describe, expect, it } from 'vitest';
import { installPath2D, makeFakeCanvas, overlaps, textBox } from '../src/hud/dev/fakeCanvas';
import { drawIntelMap } from '../src/ui/screens/intelMap';
import { CAMPAIGNS, TRAINING, missionById } from '../src/missions';

installPath2D();

/** Word-wrap `text` at `chars` characters per line. */
function wrapWords(text: string, chars: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(' ')) {
    if (line && line.length + 1 + w.length > chars) {
      out.push(line);
      line = w;
    } else line = line ? line + ' ' + w : w;
  }
  if (line) out.push(line);
  return out;
}

describe('briefing intel map labels', () => {
  // the map is square, as tall as the briefing body (about 240 px at 844×390), or wide when enlarged
  const sizes: [number, number][] = [[240, 240], [260, 260], [300, 300], [360, 220], [800, 300]];
  for (const id of ['t01', 't02', 't04', 't06', 'g01', 'g02', 'ia_dogfight_auckland', 'ia_sam_gauntlet_auckland', 'ia_strike_auckland', 'ia_defend_auckland']) {
    it(`${id}: no label prints over another`, () => {
      const m = missionById(id)!;
      for (const [w, h] of sizes) {
        const { canvas, ctx } = makeFakeCanvas(w, h, 1);
        drawIntelMap(canvas, m, w, h, 1);
        // (the route's numbered markers are symbols, not labels: two waypoints on one spot share a place)
        const t = ctx.texts.filter((x) => x.text.length > 2);
        const all = ctx.texts;
        for (let i = 0; i < t.length; i++) {
          for (const o of all) {
            if (o === t[i]) continue;
            expect(overlaps(textBox(t[i]), textBox(o), 0.5), `${id} ${w}×${h}: "${t[i].text}" over "${o.text}"`).toBe(false);
          }
        }
      }
    });
  }
});

describe('mission card subtitles', () => {
  it('fit two lines of a card on a 390 px tall screen', () => {
    // two lines are clamped there; about 27 characters fit a line of the card at 844×390
    for (const m of [...TRAINING, ...CAMPAIGNS.flatMap((c) => c.missions)]) {
      const lines = wrapWords(m.subtitle, 27);
      expect(lines.length, `${m.id}: "${m.subtitle}" → ${JSON.stringify(lines)}`).toBeLessThanOrEqual(2);
    }
  });
});

describe('countermeasures in the lessons', () => {
  it('T06 teaches the CMS control, not chaff and flares as separate actions', () => {
    const t06 = missionById('t06')!;
    const texts = [...t06.briefing, ...(t06.script.hints ?? []).map((h) => h.text)];
    for (const tr of t06.script.triggers ?? []) for (const a of tr.actions) if (a.kind === 'hint') texts.push(a.text);
    const cm = texts.filter((t) => /chaff|flare|\bCMS\b/i.test(t));
    expect(cm.length).toBeGreaterThanOrEqual(3);
    for (const t of cm) {
      expect(t, t).toMatch(/\bCMS\b/);
      // never "save the CHAFF", "FLARES late", "chaff in the last seconds": only "chaff and flares together"
      expect(t.replace(/chaff and flares together/i, ''), t).not.toMatch(/chaff|flare/i);
    }
  });
});
