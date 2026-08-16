#!/usr/bin/env bash
# Transcribe every clip in projects/<name>/input/ to word-level JSON.
# Usage: scripts/transcribe.sh <project-name> [clip-filename]
# Output: projects/<name>/transcript/<clip>.json  (schema: src/types.ts Transcript)
# Transcribe-once discipline: existing transcripts are skipped unless the
# source clip is newer.
set -euo pipefail

EDITOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${1:?usage: transcribe.sh <project-name> [clip-filename]}"
ONLY_CLIP="${2:-}"
PROJ_DIR="$EDITOR_DIR/projects/$PROJECT"
MODEL="$EDITOR_DIR/models/ggml-large-v3-turbo.bin"

command -v whisper-cli >/dev/null || {
  echo "whisper-cli not found. Install with: brew install whisper-cpp" >&2
  exit 1
}
[ -f "$MODEL" ] || {
  echo "Model missing. Download with:" >&2
  echo "  curl -L -o '$MODEL' https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" >&2
  exit 1
}
[ -d "$PROJ_DIR/input" ] || {
  echo "No input dir: $PROJ_DIR/input" >&2
  exit 1
}

mkdir -p "$PROJ_DIR/transcript"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

shopt -s nullglob
for clip in "$PROJ_DIR/input"/*; do
  base="$(basename "$clip")"
  case "$base" in *.mp4|*.mov|*.MP4|*.MOV|*.mkv|*.webm|*.m4a|*.wav|*.mp3|*.aiff) ;; *) continue ;; esac
  [ -n "$ONLY_CLIP" ] && [ "$base" != "$ONLY_CLIP" ] && continue
  out_json="$PROJ_DIR/transcript/$base.json"
  if [ -f "$out_json" ] && [ "$out_json" -nt "$clip" ]; then
    echo "skip (up to date): $base"
    continue
  fi

  echo "transcribing: $base"
  wav="$TMP_DIR/$base.wav"
  # Probe for an audio stream before building an audio graph.
  if ! ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "$clip" | grep -q audio; then
    echo "  no audio stream — writing empty transcript"
    dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$clip")"
    printf '{"clip":"%s","durationS":%s,"words":[]}\n' "$base" "${dur:-0}" > "$out_json"
    continue
  fi
  ffmpeg -y -v error -i "$clip" -ar 16000 -ac 1 -c:a pcm_s16le "$wav"

  # -ml 1 -sow: one word per segment → word-level timestamps.
  # DTW token-level alignment improves timing when the build supports it.
  raw="$TMP_DIR/$base"
  if ! whisper-cli -m "$MODEL" -f "$wav" -ml 1 -sow -oj -of "$raw" \
       --dtw large.v3.turbo -t 8 >/dev/null 2>"$TMP_DIR/err.log"; then
    echo "  dtw unsupported by this build, retrying without it"
    whisper-cli -m "$MODEL" -f "$wav" -ml 1 -sow -oj -of "$raw" -t 8 >/dev/null
  fi

  dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$clip")"
  CLIP_BASE="$base" DUR_S="$dur" node -e '
    const fs = require("fs");
    const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const words = [];
    for (const seg of raw.transcription ?? []) {
      const text = (seg.text ?? "").trim();
      if (!text) continue;
      const toS = (t) => {
        const [h, m, rest] = t.split(":");
        return Number(h) * 3600 + Number(m) * 60 + Number(rest.replace(",", "."));
      };
      words.push({ word: text, startS: toS(seg.timestamps.from), endS: toS(seg.timestamps.to) });
    }
    // whisper.cpp -ml 1 end timestamps absorb trailing silence: a word before
    // a pause reports the pause as part of its span, which breaks pause
    // shaping and output-time remapping. Clamp every word to the next word
    // start and to a sane max spoken duration (1.0s).
    words.sort((a, b) => a.startS - b.startS);
    const MAX_WORD_S = 1.0;
    for (let i = 0; i < words.length; i++) {
      let end = words[i].endS;
      if (i + 1 < words.length) end = Math.min(end, words[i + 1].startS);
      end = Math.min(end, words[i].startS + MAX_WORD_S);
      words[i].endS = Math.max(end, words[i].startS + 0.02);
    }
    const out = {
      clip: process.env.CLIP_BASE,
      durationS: Number(process.env.DUR_S) || (words.at(-1)?.endS ?? 0),
      words,
    };
    fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
    console.log(`  ${words.length} words → ${process.argv[2]}`);
  ' "$raw.json" "$out_json"
done
echo "done."
