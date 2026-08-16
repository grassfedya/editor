#!/usr/bin/env bash
# Synthesize a police-siren wail as a WAV. No sample libraries, no licensing.
# Usage: scripts/make-siren.sh <out.wav> [durationS] [wailHz]
#
# The wail is proper sinusoidal FM, not a sin(2*pi*f(t)*t) sweep: the latter
# has instantaneous frequency f(t) + t*f'(t), which runs away over time and
# sounds like a rising whine instead of a steady oscillating wail. Carrier
# phase here is the analytic integral of the modulated frequency, so the pitch
# swings between fc±dev forever and every cycle sounds the same.
set -euo pipefail

OUT="${1:?usage: make-siren.sh <out.wav> [durationS] [wailHz]}"
DUR="${2:-6}"
WAIL="${3:-1.6}"

FC=760      # carrier centre, Hz
DEV=420     # peak deviation, Hz
# Phase modulation index for sinusoidal FM: beta = deviation / modulation rate.
BETA="$(python3 -c "print($DEV/$WAIL)")"

mkdir -p "$(dirname "$OUT")"

# Fundamental + two harmonics gives the brassy edge of a real siren horn; a
# pure sine reads as a test tone. Levels drop off so it stays a siren, not a
# buzzer.
EXPR="0.34*sin(2*PI*${FC}*t + ${BETA}*sin(2*PI*${WAIL}*t))"
EXPR="${EXPR} + 0.16*sin(2*PI*$((FC*2))*t + $(python3 -c "print(${BETA}*2)")*sin(2*PI*${WAIL}*t))"
EXPR="${EXPR} + 0.07*sin(2*PI*$((FC*3))*t + $(python3 -c "print(${BETA}*3)")*sin(2*PI*${WAIL}*t))"

ffmpeg -v error -y \
  -f lavfi -i "aevalsrc=${EXPR}:s=48000:d=${DUR}" \
  -af "highpass=f=300,acompressor=threshold=0.35:ratio=4,afade=t=in:st=0:d=0.06,afade=t=out:st=$(python3 -c "print(max(0,${DUR}-0.35))"):d=0.35,volume=1.6,alimiter=limit=0.95" \
  -ac 2 -ar 48000 -c:a pcm_s16le "$OUT"

echo "wrote $OUT (${DUR}s wail, ${WAIL}Hz, ${FC}±${DEV}Hz)"
