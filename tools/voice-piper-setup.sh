#!/usr/bin/env bash
# F35-A — one-time setup of the Piper neural TTS used by tools/gen-voices.sh (build-time only;
# nothing here ships with the game — only the rendered MP3s in public/audio/voice do).
#   * piper-tts wheel + onnxruntime from PyPI (GPL-3.0 / MIT) into $PIPER_HOME/venv
#   * voice models from the rhasspy/piper GitHub release v0.0.2:
#       en-us-kathleen-low   (Betty)          dataset licence CC0
#       en-us-libritts-high  (pilot, AWACS)   dataset licence CC BY 4.0 (LibriTTS, openslr.org/60)
set -euo pipefail
PIPER_HOME=${PIPER_HOME:-$HOME/.cache/f35-voices}
mkdir -p "$PIPER_HOME"
cd "$PIPER_HOME"
if [ ! -x venv/bin/piper ]; then
  python3 -m venv venv
  venv/bin/pip install -q 'piper-tts==1.8.0' onnxruntime
fi
for v in en-us-kathleen-low en-us-libritts-high; do
  if [ ! -f "$v/$v.onnx" ]; then
    curl -fsSL -o "$v.tar.gz" "https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-$v.tar.gz"
    mkdir -p "$v" && tar xzf "$v.tar.gz" -C "$v" && rm -f "$v.tar.gz"
  fi
done
echo "piper ready in $PIPER_HOME"
