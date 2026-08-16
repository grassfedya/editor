# editor

AI video editing toolkit for talking-head content. You direct the edit in chat
with Claude, Claude writes `edit-plan.json`, and deterministic scripts plus
Remotion do the rendering. Everything runs on your machine except Gemini calls
(clip descriptions, generated B-roll images).

What it does:

- Word-synced B-roll overlays: an image appears the moment a phrase is spoken.
  Two styles per cue, `popup` (spring pop-in over the footage) or `fullscreen`
  (cutaway while the audio continues).
- Animated word-by-word captions with per-word highlighting.
- Pause shaping and silence removal. Gaps of 0.8s and up are shortened to a
  0.25s residual instead of cut flush, so the delivery keeps a beat. Every
  auto-cut is listed in the plan and can be vetoed.
- Banners: a flashing title card slammed over a time range, with optional SFX.
  `scripts/make-siren.sh` synthesizes a police siren with ffmpeg, so no sample
  licensing is involved.
- Wide 1920x1080 and Vertical 1080x1920 from the same plan. The vertical
  reframe is a static crop, optionally guided by Gemini's subject position.

There is no filler-word ("um") removal. Whisper rarely transcribes
disfluencies, so text matching cannot find them reliably.

## Setup

You need Node 22+, ffmpeg, and whisper.cpp:

```
brew install ffmpeg whisper-cpp
npm install
```

The whisper model is not in the repo (1.5G):

```
curl -L -o models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

Environment: `GEMINI_API_KEY` for clip descriptions and image generation,
`PEXELS_API_KEY` optional for stock photo search. The `web` image source
(Openverse, then Wikimedia Commons) needs no key and records attribution in
`assets-resolved/CREDITS.md`.

## Workflow

Each video lives in `projects/<name>/` with clips in `input/`.

```
bash scripts/transcribe.sh <name>          # word-level transcripts (whisper.cpp)
npx tsx scripts/describe.ts <name>         # optional: Gemini shot log
# write edit-plan.json (schema: src/types.ts, EditPlan)
npx tsx scripts/tighten.ts <name>          # pause/silence cuts, all vetoable
npx tsx scripts/fetch-assets.ts <name>     # resolve overlay images
npx tsx scripts/render.ts <name> both --draft
npx tsx scripts/render.ts <name> both      # full-res finals
```

`edit-plan.json` is the single source of truth: deterministic, hand-editable,
all times in source-clip seconds. Editing it only requires re-running render
(plus tighten if the cut changed), never re-transcription.

`CLAUDE.md` holds the full operating notes: the timestamp repair workflow for
whisper's `-ml 1` quirks, popup geometry rules, known limits. It is written
for the model, but it is also where the sharp edges are documented.

## Verification

`bash scripts/e2e.sh` runs a self-contained end-to-end without real footage:
macOS `say` over an ffmpeg test pattern, planted long pauses, three overlay
cues. It asserts at least 2s removed, 3 overlays mapped, and captions present.

## License

MIT
