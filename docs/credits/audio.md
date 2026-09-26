# F35-A — audio credits & licences

## Summary

* **No third-party audio recordings are used.** Every sound effect (engines, afterburner, gun, missiles,
  explosions, sonic booms, RWR / MAWS / AIM-9X tones, wind, G-suit, breathing, clicks) is synthesised at
  runtime with the Web Audio API from procedurally generated noise buffers and oscillators
  (`src/audio/**`).
* **Voice clips** in `public/audio/voice/*.mp3` (37 files) are generated offline by
  `tools/gen-voices.sh` (`npm run voices`) with neural text-to-speech (Piper) and then processed with
  ffmpeg filters (cockpit / radio chains).
* **Music** is procedural too (`src/audio/music/Music.ts`): a D-minor pad, bell arpeggio and bass for the
  menus, an adaptive in-mission layer (cruise pad → engaged pulse → defensive percussion) and kill /
  mission-complete / mission-failed stingers, all oscillators and filtered noise. No music files.

## Voice clips: text-to-speech engines

Since iteration 1 the clips are rendered with **Piper**, an offline neural (VITS) TTS, which replaced the
robotic CMU Flite voices. The Flite and eSpeak NG paths remain in `tools/gen-voices.sh` as fallbacks.

| Role | Clips | Voice model | Dataset licence |
|---|---|---|---|
| "Betty", the female ICAWS voice | `b_*` | Piper `en-us-kathleen-low` | **CC0** (public domain, github.com/rhasspy/dataset-voice-kathleen) |
| Pilot and wingmen | `p_*` | Piper `en-us-libritts-high`, speaker id 19 (male) | **CC BY 4.0** (LibriTTS, openslr.org/60, derived from LibriVox public-domain readings) |
| AWACS "Darkstar" | `a_*` | Piper `en-us-libritts-high`, speaker id 5 (a different male) | **CC BY 4.0** (as above) |
| AWACS word segments (iteration 2) | `s_*` | same AWACS speaker (id 5); 67 short words / numbers + a squelch-tail clip | **CC BY 4.0** (as above) |
| "Hammer 1" flight lead (iteration 2) | `h_*` | Piper `en-us-libritts-high`, speaker id 3 (male, median F0 ≈ 109 Hz, lower than the pilot and AWACS) | **CC BY 4.0** (as above) |
| Fallbacks | all | CMU Flite slt / awb / rms, then eSpeak NG | BSD-style / GPL (output unrestricted) |

Setup: `bash tools/voice-piper-setup.sh` (piper-tts 1.8.0 wheel + onnxruntime from PyPI into
`~/.cache/f35-voices`, voice models from the rhasspy/piper GitHub release v0.0.2), then `npm run voices`.

**Voice selection.** Candidates were screened objectively: male/female by median F0 (autocorrelation) over
60 LibriTTS speakers, then word accuracy of the raw voices with the pocketsphinx recogniser on 16 key
phrases. Raw scores: Flite rms 0.76, Festival HTS slt 0.71, Piper amy 0.61, LibriTTS spk 5 0.63 / spk 7 0.61 /
spk 19 0.59, Flite slt 0.59, Piper kathleen 0.56, MBROLA us2 0.54 / us1 0.49 / us3 0.46 / en1 0.32, Flite awb 0.46.
pocketsphinx is a weak proxy for human intelligibility (it is a 2010-era HMM recogniser with a general
language model, and short brevity words like "Magnum" or "Bandits" are out of its comfort zone), so the neural
voices were preferred for their natural prosody at comparable scores. MBROLA voices were rejected both on score
and licence (MBROLA voice databases are non-commercial only). Piper `ryan` (CC BY-NC-SA) and the Mimic 3
derived voices (amy, danny, alan; licence unclear) were rejected on licence grounds.
Run `bash tools/gen-voices.sh --verify` (or `--check` for the existing clips) to print a transcript of every
processed clip and the overall word accuracy. After the cockpit / radio chains, the same check scores the
shipped Piper set 29/86 = 0.34 and the previous Flite set 28/86 = 0.33 (input attenuated 10 dB, since
pocketsphinx degrades on hot, limited input). The Piper pilot is clearly better on the check (rifle, magnum,
defending, copy, engaged, target destroyed recognised), Betty is on par; neither engine reaches the 0.85 a
modern neural recogniser would give — the band-limited radio chains and pocketsphinx's language model cap it.
Piper output is attenuated 8 dB before the chains (it is peak-normalised, Flite peaks at about −7 dBFS), and the
radio chains were lightened (less overdrive and bit-crush, quieter carrier bed) for intelligibility.

**Licences.**

* **Piper** (piper-tts, © Michael Hansen / rhasspy, GPL-3.0 for the 1.x Python package, MIT for the original
  C++ piper) and **onnxruntime** (MIT) are used only as offline build tools; nothing of them ships with the game.
  The **kathleen** voice dataset is CC0; the **LibriTTS** corpus (Zen et al., 2019) is CC BY 4.0 —
  attribution: "Voices for the pilot and AWACS generated with a Piper model trained on LibriTTS (CC BY 4.0)".
  The generated speech clips are original works of this project.

* **CMU Flite** and its CMU ARCTIC voices (slt, rms, awb) are © Carnegie Mellon University (with parts from the
  University of Edinburgh CSTR). They are released under a permissive BSD-style licence: "Permission is hereby
  granted, free of charge, to use and distribute this software … without restriction", provided the notices
  and the authors' names are kept (see `/usr/share/doc/libflite1/copyright`). Flite is linked into the system
  ffmpeg build as `libflite`. Only the generated audio ships with the game, and the licence places no
  restrictions on synthesised speech.
* **eSpeak NG** is GPL-3.0-or-later. The GPL covers the program, not its output. Speech synthesised with eSpeak NG
  is not a derivative work of the program, so audio generated by it (if the fallback is used) can be shipped
  under any licence. No eSpeak NG code or data is distributed with the game.
* **ffmpeg** (LGPL/GPL build) is used only as an offline tool. None of its code ships with the game.
* The **pocketsphinx** en-us model (BSD-style) is used only for the optional offline `--verify` check.

The generated clips are original works of this project.

## Processing (tools/gen-voices.sh)

* **Betty:** silence trim, band-pass 300–3400 Hz, a +4 dB presence peak at 2.5 kHz, a short two-tap comb
  (2.7 ms and 6.1 ms) for the metallic cockpit-speaker tint, 4:1 compression. RMS-normalised to −17 dBFS and
  peak-limited to −1 dBFS.
* **Pilot:** band-pass 330–3400 Hz, +4 dB at 1.8 kHz, tanh soft-clip overdrive, 5:1 compression.
* **AWACS:** atan overdrive and a mild 10-bit crush (20 % mix), then band-pass 420–3000 Hz, +3 dB at 1.6 kHz,
  6:1 compression.
* **Radio clips (pilot and AWACS):** RMS-normalised to −18 dBFS, with band-passed carrier hiss under the voice and a
  160–200 ms squelch burst when the mic is released. At runtime a key-up click is added in front of each clip.
* **Output:** mono MP3, 24 kHz, 48 kbit/s.

## Procedural synthesis references (techniques only, no assets)

* Paul Kellet's "refined" pink-noise filter (public domain, music-dsp archive).
* Physics used in `src/audio/acoustics.ts`:
  * Doppler shift
  * retarded-time propagation of a moving source (flyby lag, and the Mach cone that produces sonic booms)
  * inverse-distance attenuation
  * a speed of sound of 343 m/s

## Iteration 2: spoken radio matches the subtitles

Dynamic AWACS calls (BRAA / bullseye pictures, pop-up groups, threat calls, "last bandit", "wave N destroyed",
"the raid is turning back") used to be voiced with a generic clip ("Bandits, bandits."). `src/audio/voice/radioSpeech.ts`
now voices a radio event from its subtitle: the fixed clip if its words appear verbatim in the subtitle, else a
whole-call clip by another speaker (Hammer 1), else — for AWACS — the subtitle spoken word by word from the `s_*`
segments (bearings digit by digit, ranges and angels as numbers, a pause at each comma, one squelch tail at the end).
Words without a segment are left out, never replaced, so what is heard is always the subtitle or an in-order subset of
it; calls that cannot be voiced that way become text-only (key-up click + static). `tools/gen-voices.sh --segments`
renders just the segments (≈ 245 KB in total, 48 kbit/s mono MP3; fetched after the fixed clips). Regression test: `tests/audio-radiospeech.test.ts`
(scans every `text:`/`voice:` radio push in src/missions and src/sim).
