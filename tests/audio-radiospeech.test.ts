import { beforeAll, describe, expect, it } from 'vitest';
import type { VoiceId } from '../src/core/types';
import {
  clipMatchesText,
  composeAwacs,
  PAUSE,
  resolveRadioSpeech,
  SEGMENT_IDS,
  speechWords,
  spokenText,
  VOICE_TEXT,
  type SegmentId,
  type SpeechToken,
} from '../src/audio/voice/radioSpeech';
import { VOICE_IDS } from '../src/audio/voice/voiceIds';

// node:fs / node:path-free file access (the project ships no node typings)
interface Fs {
  existsSync(p: URL): boolean;
  readFileSync(p: URL, enc: 'utf8'): string;
  readdirSync(p: URL): string[];
  statSync(p: URL): { size: number; isDirectory(): boolean };
}
let fs: Fs;
let GEN = '';
const SEG_TEXT: Record<string, string> = {};
beforeAll(async () => {
  fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as Fs;
  GEN = fs.readFileSync(file('tools/gen-voices.sh'), 'utf8');
  for (const m of GEN.matchAll(/"((?:s|h)_[a-z0-9_]+)\|([^"]*)"/g)) SEG_TEXT[m[1]] = m[2];
});
const file = (rel: string) => new URL(`../${rel}`, import.meta.url);

const say = (t: SpeechToken[] | null) => (t ? spokenText(t, (id) => SEG_TEXT[id] ?? `<${id}?>`) : '');

/** Are `spoken` words a subsequence (in order) of the subtitle words? */
function saysOnlySubtitle(spoken: string, subtitle: string): boolean {
  const sub = speechWords(subtitle).map((w) => NUMBER_WORDS[w] ?? [w]).flat();
  const sp = speechWords(spoken).map((w) => (w === 'niner' ? 'nine' : w === 'bra' ? 'braa' : w));
  let j = 0;
  for (const w of sp) {
    while (j < sub.length && sub[j] !== w) j++;
    if (j >= sub.length) return false;
    j++;
  }
  return true;
}
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
/** Digits in a subtitle → the words they may be spoken as (both digit-wise and as a number). */
const NUMBER_WORDS: Record<string, string[]> = new Proxy(
  {},
  {
    get(_t, k: string) {
      if (!/^\d+$/.test(k)) return undefined;
      const n = Number(k);
      const digitWise = [...k].map((c) => ONES[Number(c)]);
      if (k.length === 3 || n > 99) return digitWise;
      if (n < 10) return [ONES[n]];
      if (n < 20) return [TEENS[n - 10]];
      return n % 10 ? [TENS[Math.floor(n / 10)], ONES[n % 10]] : [TENS[n / 10]];
    },
  },
);

describe('radio speech matches the subtitle (i2 reviewer: BRAA calls voiced as "Bandits, bandits")', () => {
  const cases: [string, VoiceId, string][] = [
    ['DARKSTAR', 'a_bandits', 'Viper 1, Darkstar, single group, two bandits, BRAA 045, 40 miles, angels 25, hot.'],
    ['DARKSTAR', 'a_bandits', 'Viper 1, Darkstar, pop-up group, single bandit, BRAA 310, 18 miles, angels 3, flanking.'],
    ['DARKSTAR', 'a_bandits', 'Viper 1, threat, two bandits, BRAA 040, 25 miles, angels 12, hot!'],
    ['DARKSTAR', 'a_bandits', 'Viper 1, Darkstar, last bandit: single bandit, BRAA 270, 12 miles, angels 8, cold.'],
    ['DARKSTAR', 'a_bandits', 'Viper 1, Darkstar, single group, four bandits, bullseye 090, 22 miles, angels 25, track southwest.'],
    ['DARKSTAR', 'a_new_picture', 'Viper 1, Darkstar, new picture, two groups.'],
    ['DARKSTAR', 'a_good_kill', 'Viper 1, Darkstar. The raid is turning back! Good work.'],
  ];
  for (const [, voice, text] of cases) {
    it(`"${text}"`, () => {
      expect(clipMatchesText(voice, text)).toBe(false); // the generic clip would disagree
      const t = resolveRadioSpeech(text, voice);
      expect(t).not.toBeNull();
      expect(t).not.toContain(voice);
      const spoken = say(t);
      expect(spoken).not.toContain('?');
      expect(saysOnlySubtitle(spoken, text)).toBe(true);
      // and it says most of it
      const c = composeAwacs(text);
      expect(c.covered / c.total).toBeGreaterThanOrEqual(0.85);
    });
  }

  it('speaks BRAA bearings digit by digit and ranges / angels as numbers', () => {
    const t = resolveRadioSpeech('Viper 1, threat, two bandits, BRAA 045, 40 miles, angels 25, hot!', 'a_bandits')!;
    const ids = t.filter((x) => x !== PAUSE);
    expect(ids).toEqual(['s_viper', 's_1', 's_threat', 's_2', 's_bandits', 's_braa', 's_0', 's_4', 's_5', 's_40', 's_miles', 's_angels', 's_20', 's_5', 's_hot']);
    expect(t.filter((x) => x === PAUSE).length).toBe(6); // one pause per comma
  });

  it('fixed clips are kept when they say what the subtitle says', () => {
    expect(resolveRadioSpeech('SAM launch, SAM launch!', 'a_sam_launch')).toEqual(['a_sam_launch']);
    expect(resolveRadioSpeech('Viper 1, Darkstar. Mission complete, RTB.', 'a_mission_complete')).toEqual(['a_mission_complete']);
    expect(resolveRadioSpeech('Fox Three', 'p_fox3')).toEqual(['p_fox3']);
    expect(resolveRadioSpeech('Friendly down! Viper 2 is down.', 'a_friendly_down')).toEqual(['a_friendly_down']);
    expect(resolveRadioSpeech(undefined, 'p_copy')).toEqual(['p_copy']);
  });

  it('a call nothing can voice correctly becomes a text-only call (click + static), never a wrong clip', () => {
    expect(resolveRadioSpeech('Tanker is on station at angels 20.', 'p_rifle')).toBeNull();
    expect(resolveRadioSpeech('Gate is open, proceed to the target area.', 'a_bandits')).toBeNull();
  });

  it('every radio push in the game source says only what its subtitle says', () => {
    // literal `text: …, voice: '…'` pairs in missions / sim, with sample values for the ${…} parts
    const SAMPLE: [RegExp, string][] = [
      [/\$\{s\.callsign\}/g, 'Viper 1'],
      [/\$\{s\.awacsSpoken\}/g, 'Darkstar'],
      [/\$\{who\}/g, 'Viper 1, Darkstar'],
      [/\$\{this\.describe\(pic\)\}/g, 'two bandits, BRAA 045, 40 miles, angels 25, hot'],
      [/\$\{braaText\([^}]*\)\}/g, 'single bandit, BRAA 270, 12 miles, angels 8, cold'],
      [/\$\{countWord\([^}]*\)\}/g, 'three'],
      [/\$\{this\.wave\}/g, '2'],
      [/\$\{[^}]*\}/g, 'Alpha'],
    ];
    const files: string[] = [];
    const walk = (rel: string) => {
      for (const f of fs.readdirSync(file(rel))) {
        const p = `${rel}/${f}`;
        if (fs.statSync(file(p)).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk('src/missions');
    walk('src/sim');
    let pairs = 0;
    const bad: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(file(f), 'utf8');
      for (const m of src.matchAll(/(?:from:\s*([`'])([^`']*)\1,\s*)?text:\s*([`'])((?:(?!\3).)*)\3,\s*voice:\s*'([a-z0-9_]+)'/g)) {
        let text = m[4];
        for (const [re, v] of SAMPLE) text = text.replace(re, v);
        const voice = m[5] as VoiceId;
        const t = resolveRadioSpeech(text, voice);
        pairs++;
        if (t && !saysOnlySubtitle(say(t), text)) bad.push(`${f}: "${text}" → ${say(t)}`);
      }
    }
    expect(pairs).toBeGreaterThanOrEqual(12);
    expect(bad).toEqual([]);
  });
});

describe('voice texts and segment clips', () => {
  it('VOICE_TEXT matches the clip texts in tools/gen-voices.sh', () => {
    for (const id of VOICE_IDS) {
      const m = GEN.match(new RegExp(`"${id}\\|([^"]*)"`));
      expect(m, id).toBeTruthy();
      expect(m![1]).toBe(VOICE_TEXT[id]);
    }
  });

  it('every segment id is generated by the script and shipped as a small mp3', () => {
    let total = 0;
    for (const id of SEGMENT_IDS) {
      expect(SEG_TEXT[id as SegmentId] !== undefined, `${id} in gen-voices.sh`).toBe(true);
      const f = file(`public/audio/voice/${id}.mp3`);
      expect(fs.existsSync(f), `${id}.mp3`).toBe(true);
      const size = fs.statSync(f).size;
      expect(size).toBeGreaterThan(800);
      total += size;
    }
    expect(total).toBeLessThan(400 * 1024);
  });
});
