#!/usr/bin/env bash
# Self-contained end-to-end check without real footage: synthesizes a test
# clip with macOS `say` over an ffmpeg test pattern (with deliberate long
# pauses), runs the full workflow, and renders draft outputs in both formats.
# Verify afterwards by extracting frames at the overlay times printed at the
# end (see CLAUDE.md "Verification").
set -euo pipefail

EDITOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$EDITOR_DIR"
PROJ=e2e-test
PDIR="$EDITOR_DIR/projects/$PROJ"

rm -rf "$PDIR"
mkdir -p "$PDIR/input" "$PDIR/assets"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== synthesizing test clip =="
say -o "$TMP/voice.aiff" \
  "Saturation divers, [[slnc 1800]] second spaces, [[slnc 1500]] and sitting in the car after a long day at work."
# 1.5s leading + 2s trailing silence to exercise head/tail trimming.
ffmpeg -y -v error -i "$TMP/voice.aiff" \
  -af "adelay=1500:all=1,apad=pad_dur=2" -ar 44100 -ac 1 "$TMP/voice.wav"
DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TMP/voice.wav")"
ffmpeg -y -v error \
  -f lavfi -i "testsrc2=size=1920x1080:rate=30" -i "$TMP/voice.wav" \
  -t "$DUR" -map 0:v -map 1:a -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac \
  "$PDIR/input/test.mp4"

for c in red green blue; do
  ffmpeg -y -v error -f lavfi -i "color=c=$c:size=800x600" -frames:v 1 "$PDIR/assets/$c.png"
done

echo "== transcribe =="
bash scripts/transcribe.sh "$PROJ"

echo "== plan + tighten + assets =="
npx tsx scripts/e2e-plan.ts "$PROJ"
npx tsx scripts/tighten.ts "$PROJ"
npx tsx scripts/fetch-assets.ts "$PROJ"

echo "== render drafts =="
npx tsx scripts/render.ts "$PROJ" both --draft

echo "== summary =="
node -e '
  const p = require(process.argv[1] + "/.render-props.json");
  const src = p.clipMeta["test.mp4"].durationS;
  const out = p.plan.segments.reduce((n, s) => n + s.outS - s.inS, 0);
  console.log(`source ${src.toFixed(2)}s → output ${out.toFixed(2)}s (${(src - out).toFixed(2)}s removed)`);
  if (src - out < 2) { console.error("FAIL: expected ≥2s of pauses removed"); process.exit(1); }
  for (const o of p.outputOverlays) {
    console.log(`overlay ${o.id} (${o.style}): output ${o.outStartS.toFixed(2)}s – ${o.outEndS.toFixed(2)}s`);
  }
  if (p.outputOverlays.length !== 3) { console.error("FAIL: expected 3 overlays"); process.exit(1); }
  if (p.outputWords.length < 10) { console.error("FAIL: too few caption words"); process.exit(1); }
' "$PDIR"
echo "e2e complete: check $PDIR/out/"
