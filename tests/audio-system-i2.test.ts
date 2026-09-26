import { describe, expect, it } from 'vitest';
import { AudioSystem } from '../src/audio/AudioSystem';
import { requestPlaybackSession } from '../src/audio/core/AudioEngine';

const fakeBus = { on: () => () => undefined, emit: () => undefined } as any;

describe('iOS silent switch (i2 reviewer: ambient session muted by the ring/silent switch)', () => {
  it('asks navigator.audioSession for the playback session where supported', () => {
    const nav = { audioSession: { type: 'auto' } };
    expect(requestPlaybackSession(nav)).toBe(true);
    expect(nav.audioSession.type).toBe('playback');
  });

  it('reports no support on browsers without navigator.audioSession (legacy iOS uses the silent <audio> trick)', () => {
    expect(requestPlaybackSession({})).toBe(false);
    expect(requestPlaybackSession(undefined)).toBe(false);
  });
});

describe('music volume setting (i2 reviewer: no way to turn the music off)', () => {
  it('implements AudioApi.setMusicVolume; 0 turns the soundtrack off (no notes scheduled)', () => {
    const a = new AudioSystem(fakeBus);
    const mode = () => (a as any).musicMode() as string;
    expect(typeof a.setMusicVolume).toBe('function');
    a.setMusicVolume(0.6);
    expect(mode()).not.toBe('off');
    a.setMusicVolume(0);
    expect(mode()).toBe('off');
    a.setMusicVolume(0.3);
    expect(mode()).not.toBe('off');
    a.setMusicVolume(Number.NaN); // bad input falls back to the default instead of silencing
    expect(mode()).not.toBe('off');
  });

  it('acknowledgeWarnings is safe before the audio context exists', () => {
    const a = new AudioSystem(fakeBus);
    expect(a.acknowledgeWarnings()).toBe(0);
  });
});
