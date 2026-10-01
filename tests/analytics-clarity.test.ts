import { describe, expect, it } from 'vitest';
import { analyticsActive, initAnalytics, tag, track, upgrade } from '../src/analytics/clarity';

describe('Clarity analytics', () => {
  it('stays inactive outside a production browser build and never throws', () => {
    initAnalytics({ build: 'test' });
    expect(analyticsActive()).toBe(false);
    expect(() => {
      track('mission_start');
      tag('mission', 'm1');
      upgrade('campaign_complete');
    }).not.toThrow();
  });
});
