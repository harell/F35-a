/**
 * Issue #116, playtest 1.2-g: the PCD texture has mipmaps on low quality too (the text broke up at
 * 844×390 without them), and its uploads (each one a GPU mip generation) stay at the throttled redraw
 * rate, 5 Hz on low, whatever the frame rate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LinearMipmapLinearFilter } from 'three';
import type { FrameContext } from '../src/core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import { PcdDisplay } from '../src/hud/cockpit/pcd';
import { buildMock } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';

installPath2D();
const g = globalThis as unknown as { document?: unknown };
const prevDoc = g.document;
beforeAll(() => {
  g.document = { createElement: () => makeFakeCanvas(1024, 512).canvas };
});
afterAll(() => {
  g.document = prevDoc;
});

describe('PCD texture mipmaps (#116 1.2-g)', () => {
  for (const level of ['low', 'medium', 'high'] as const) {
    it(`${level}: mipmapped, uploaded at the redraw rate (not per frame)`, () => {
      const pcd = new PcdDisplay({ ...QUALITY_PRESETS[level] });
      expect(pcd.texture.generateMipmaps).toBe(true);
      expect(pcd.texture.minFilter).toBe(LinearMipmapLinearFilter);
      const mock = buildMock('aa');
      const ctx = { world: mock.world, player: mock.player, settings: { ...DEFAULT_SETTINGS }, mission: mock.mission } as unknown as FrameContext;
      const v0 = pcd.texture.version;
      // one second at 60 fps
      for (let i = 0; i < 60; i++) pcd.update(ctx, 1 / 60);
      const uploads = pcd.texture.version - v0;
      expect(uploads).toBeGreaterThan(0);
      expect(uploads).toBeLessThanOrEqual(level === 'low' ? 6 : 11);
    });
  }
});

describe('PCD: ICAWS paged on battle damage (#116 suggestion 4)', () => {
  for (const w of ['damage', 'engine_fire', 'hydraulics'] as const) {
    it(`the RWR portal jumps to ICAWS once when '${w}' comes on`, () => {
      for (const leftHanded of [false, true]) {
        const pcd = new PcdDisplay({ ...QUALITY_PRESETS.medium });
        const mock = buildMock('aa');
        const p = mock.player;
        p.warnings.clear();
        const ctx = { world: mock.world, player: p, settings: { ...DEFAULT_SETTINGS, leftHanded }, mission: mock.mission } as unknown as FrameContext;
        pcd.update(ctx, 0.1);
        const rwr = pcd.pages().indexOf('RWR');
        expect(rwr).toBeGreaterThanOrEqual(0);
        p.warnings.add(w);
        pcd.update(ctx, 0.1);
        expect(pcd.pages()[rwr]).toBe('ICAWS');
        // the pilot pages back: it stays there while the damage stays, whatever else comes on
        pcd.setPage(rwr, 0);
        const back = pcd.pages()[rwr];
        p.warnings.add('spike');
        pcd.update(ctx, 0.1);
        expect(pcd.pages()[rwr]).toBe(back);
      }
    });
  }
});
