#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# F35-A — voice clip generator (AUDIO module).        npm run voices
#
# Renders every VoiceId declared in src/core/types.ts into
#   public/audio/voice/<id>.mp3     (mono, 24 kHz, 48 kbit/s MP3)
#
#   b_*  "Betty"  — calm female ICAWS voice, cockpit processing (band-pass
#                   300–3400 Hz, presence lift, short metallic comb, compression)
#   p_*  pilot    — male voice #1, radio chain (band-pass 400–3000 Hz, overdrive,
#                   mild bit-crush, compression, carrier hiss + squelch tail)
#   a_*  AWACS    — male voice #2 (different speaker), narrower/noisier radio chain
#
# TTS engine: ffmpeg's built-in libflite (CMU Flite clustergen voices slt/rms/awb)
# is used when available — in an ASR intelligibility test (pocketsphinx word
# accuracy over all 37 phrases) Flite scored 0.58–0.64 vs ≤ 0.20 for the best
# espeak-ng variants. espeak-ng is the fallback (VOICE_ENGINE=espeak forces it).
#
# Loudness: every clip is RMS-normalised on its speech part (Betty −17 dBFS,
# radio −18 dBFS mean) and peak-limited to −1 dBFS, so the runtime mixer can use
# a single gain per channel.
#
# Options:  --verify   also transcribe every clip with pocketsphinx (ffmpeg asr)
#           --only=ID  regenerate a single clip
# Env:      VOICE_ENGINE=auto|flite|espeak
# Re-runnable; output files are overwritten. Requires: ffmpeg (libmp3lame),
# optionally libflite in ffmpeg, espeak-ng.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=public/audio/voice
RATE=24000
BITRATE=48k
ENGINE=${VOICE_ENGINE:-auto}
VERIFY=0
ONLY=""
for a in "$@"; do
  case "$a" in
    --verify) VERIFY=1 ;;
    --only=*) ONLY="${a#--only=}" ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
FF=(ffmpeg -nostdin -hide_banner -loglevel error -y)

if [ "$ENGINE" = auto ]; then
  FILTERS=$(ffmpeg -hide_banner -filters 2>/dev/null || true)
  if grep -q " flite " <<< "$FILTERS"; then ENGINE=flite
  elif command -v espeak-ng >/dev/null; then ENGINE=espeak
  else echo "need ffmpeg with libflite or espeak-ng" >&2; exit 1; fi
fi

# Speakers per role: flite voice | espeak voice:speed:pitch
# Chosen by ASR word accuracy after processing (see docs/CREDITS-audio.md):
#   Betty slt 0.41 (≈ raw), AWACS rms 0.75, pilot awb 0.43 — awb/rms are clearly different speakers.
BETTY_FLITE=slt;  BETTY_ESPEAK="en-us+f5:150:55"
PILOT_FLITE=awb;  PILOT_ESPEAK="en-us+m1:165:40"
AWACS_FLITE=rms;  AWACS_ESPEAK="en-us+m3:155:30"
# Flite tempo per role (1 = native): all slightly slowed for clarity over the radio.
BETTY_TEMPO=0.97; PILOT_TEMPO=0.97; AWACS_TEMPO=0.97

# id|text  (role is taken from the id prefix). Spoken text may differ from the subtitle.
CLIPS=(
  "b_missile|Missile. Missile."
  "b_pull_up|Pull up. Pull up."
  "b_altitude|Altitude. Altitude."
  "b_bingo|Bingo. Bingo."
  "b_fuel_low|Fuel low."
  "b_engine_fire|Engine fire. Engine fire."
  "b_warning|Warning. Warning."
  "b_over_g|Over G. Over G."
  "b_aoa|Angle of attack."
  "b_flares_low|Flares low."
  "b_chaff_low|Chaff low."
  "b_hydraulics|Hydraulics."
  "b_speed|Speed. Speed."
  "p_fox3|Fox three!"
  "p_fox2|Fox two!"
  "p_rifle|Rifle!"
  "p_magnum|Magnum!"
  "p_guns|Guns, guns!"
  "p_splash|Splash one!"
  "p_spike|Spike!"
  "p_mud_spike|Mud spike!"
  "p_defending|Defending!"
  "p_winchester|Winchester."
  "p_bingo|Bingo fuel, R. T. B."
  "p_copy|Copy."
  "p_engaged|Engaged."
  "p_target_destroyed|Target destroyed."
  "a_bandits|Bandits, bandits."
  "a_new_picture|New picture. Multiple groups."
  "a_sam_launch|Sam launch! Sam launch!"
  "a_good_kill|Good kill. Good kill."
  "a_mission_complete|Mission complete. Return to base."
  "a_mission_failed|Mission failed."
  "a_objective_complete|Objective complete."
  "a_rtb|Return to base."
  "a_eject|Eject! Eject!"
  "a_friendly_down|Friendly down."
)

# ── Every VoiceId in the contract must have a clip ────────────────────────────
DECLARED=$(awk "/export type VoiceId/{f=1} f{print} f&&/';/{exit}" src/core/types.ts | grep -o "'[a-z0-9_]*'" | tr -d "'")
for id in $DECLARED; do
  found=0
  for c in "${CLIPS[@]}"; do [ "${c%%|*}" = "$id" ] && found=1 && break; done
  [ $found = 1 ] || { echo "VoiceId '$id' has no clip text in tools/gen-voices.sh" >&2; exit 1; }
done

mkdir -p "$OUT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# mean_volume / max_volume (dB) of a file
levels() { ffmpeg -nostdin -hide_banner -i "$1" -af volumedetect -f null - 2>&1 | awk '/mean_volume/{m=$5} /max_volume/{x=$5} END{print m, x}'; }
duration() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }

# tts <role> <text> <out.wav>
tts() {
  local role=$1 text=$2 out=$3
  if [ "$ENGINE" = flite ]; then
    local v tempo
    case $role in betty) v=$BETTY_FLITE; tempo=$BETTY_TEMPO ;; pilot) v=$PILOT_FLITE; tempo=$PILOT_TEMPO ;; *) v=$AWACS_FLITE; tempo=$AWACS_TEMPO ;; esac
    printf '%s' "$text" > "$TMP/text.txt"
    "${FF[@]}" -f lavfi -i "flite=voice=$v:textfile=$TMP/text.txt" -af "atempo=$tempo,aresample=$RATE" -ac 1 "$out"
  else
    local spec
    case $role in betty) spec=$BETTY_ESPEAK ;; pilot) spec=$PILOT_ESPEAK ;; *) spec=$AWACS_ESPEAK ;; esac
    IFS=: read -r v s p <<< "$spec"
    espeak-ng -v "$v" -s "$s" -p "$p" -w "$TMP/es.wav" "$text" < /dev/null
    "${FF[@]}" -i "$TMP/es.wav" -af "aresample=$RATE" -ac 1 "$out"
  fi
}

# Trim leading/trailing silence, keep a few ms of air.
TRIM="silenceremove=start_periods=1:start_threshold=-48dB:start_silence=0.01,areverse,silenceremove=start_periods=1:start_threshold=-48dB:start_silence=0.03,areverse"

# Betty: cockpit ICAWS speaker — band-limited, presence lift, short metallic comb, compressed.
BETTY_FX="$TRIM,highpass=f=300,highpass=f=300,lowpass=f=3400,lowpass=f=3400,equalizer=f=2500:t=q:w=1.1:g=4,equalizer=f=900:t=q:w=1.5:g=-2,aecho=0.9:0.55:2.7|6.1:0.18|0.1,acompressor=threshold=0.09:ratio=4:attack=3:release=70:makeup=2,adelay=25,apad=pad_dur=0.06"
# Radio chains: band-limit, overdrive, (AWACS: mild bit-crush), compress. Heavier chains were
# tested and cost too much intelligibility (ASR accuracy halved), so the grit stays moderate.
PILOT_FX="$TRIM,highpass=f=330,highpass=f=330,lowpass=f=3400,equalizer=f=1800:t=q:w=1:g=4,volume=3dB,asoftclip=type=tanh:threshold=0.85,acompressor=threshold=0.09:ratio=5:attack=2:release=60:makeup=2,adelay=20"
AWACS_FX="$TRIM,volume=5dB,asoftclip=type=atan:threshold=0.75,acrusher=bits=10:mode=log:mix=0.2:aa=0.7,highpass=f=420,highpass=f=420,lowpass=f=3000,lowpass=f=3000,equalizer=f=1600:t=q:w=1:g=3,acompressor=threshold=0.08:ratio=6:attack=2:release=60:makeup=2,adelay=20"

render() {
  local id=$1 text=$2 role fx target bed tail
  case $id in
    b_*) role=betty; fx=$BETTY_FX; target=-17 ;;
    p_*) role=pilot; fx=$PILOT_FX; target=-18; bed=0.008; tail=0.16 ;;
    a_*) role=awacs; fx=$AWACS_FX; target=-18; bed=0.016; tail=0.20 ;;
    *) echo "bad id $id" >&2; return 1 ;;
  esac
  tts "$role" "$text" "$TMP/raw.wav"
  "${FF[@]}" -i "$TMP/raw.wav" -af "$fx" -ac 1 -ar $RATE "$TMP/fx.wav"
  # RMS normalisation of the speech part
  read -r mean _max < <(levels "$TMP/fx.wav")
  local gain; gain=$(awk -v t="$target" -v m="$mean" 'BEGIN{printf "%.2f", t - m}')
  "${FF[@]}" -i "$TMP/fx.wav" -af "volume=${gain}dB,alimiter=limit=0.89:attack=1:release=40:level=false" -ac 1 -ar $RATE "$TMP/norm.wav"
  if [ "$role" = betty ]; then
    cp "$TMP/norm.wav" "$TMP/final.wav"
  else
    # carrier hiss under the voice + squelch burst when the mic is released
    local vd tot
    vd=$(duration "$TMP/norm.wav")
    tot=$(awk -v d="$vd" -v t="$tail" 'BEGIN{printf "%.3f", d + t}')
    "${FF[@]}" -i "$TMP/norm.wav" -f lavfi -i "anoisesrc=color=white:sample_rate=$RATE:amplitude=1:duration=$tot:seed=7" -filter_complex \
      "[1:a]highpass=f=650,highpass=f=650,lowpass=f=3300,volume='if(lt(t,$vd),$bed,0.22*(1-0.5*(t-$vd)/$tail))':eval=frame,afade=t=out:st=$(awk -v t="$tot" 'BEGIN{printf "%.3f", t-0.025}'):d=0.025[n];[0:a]apad=whole_dur=$tot[v];[v][n]amix=inputs=2:normalize=0,lowpass=f=3800,lowpass=f=3800,alimiter=limit=0.89:level=false[o]" \
      -map "[o]" -ac 1 -ar $RATE "$TMP/final.wav"
  fi
  "${FF[@]}" -i "$TMP/final.wav" -ac 1 -ar $RATE -c:a libmp3lame -b:a $BITRATE "$OUT/$id.mp3"
}

echo "F35-A voices → $OUT  (engine: $ENGINE)"
printf "%-22s %6s %8s %8s %7s\n" id dur mean_dB peak_dB bytes
total=0
for c in "${CLIPS[@]}"; do
  id=${c%%|*}; text=${c#*|}
  [ -n "$ONLY" ] && [ "$ONLY" != "$id" ] && continue
  render "$id" "$text"
  f="$OUT/$id.mp3"
  read -r mean mx < <(levels "$f")
  bytes=$(stat -c %s "$f"); total=$((total + bytes))
  printf "%-22s %6.2f %8s %8s %7d\n" "$id" "$(duration "$f")" "$mean" "$mx" "$bytes"
done
echo "total: $total bytes"

if [ $VERIFY = 1 ]; then
  M=/usr/share/pocketsphinx/model/en-us
  if [ ! -d "$M" ]; then echo "(pocketsphinx model not found — skipping ASR verify)"; exit 0; fi
  echo; echo "ASR check (pocketsphinx transcript of each clip):"
  for c in "${CLIPS[@]}"; do
    id=${c%%|*}
    [ -n "$ONLY" ] && [ "$ONLY" != "$id" ] && continue
    hyp=$(ffmpeg -nostdin -hide_banner -i "$OUT/$id.mp3" -af "aresample=16000,apad=pad_dur=2,asr=hmm=$M/en-us:dict=$M/cmudict-en-us.dict:lm=$M/en-us.lm.bin,ametadata=mode=print:key=lavfi.asr.text" -f null - 2>&1 | grep -o "lavfi.asr.text=.*" | sed 's/lavfi.asr.text=//' | tr '\n' ' ')
    printf "%-22s %-36s → %s\n" "$id" "\"${c#*|}\"" "$hyp"
  done
fi
