# AI Video Editing Toolkit

Local toolkit: the user directs the edit in chat, Claude translates it into
`edit-plan.json`, deterministic scripts + Remotion do the rest. Everything runs
locally except Gemini calls (`GEMINI_API_KEY` in the shell env; `PEXELS_API_KEY`
optional).

## Capabilities (v1)

- Word-synced B-roll overlays: an image appears the moment a phrase is spoken.
  Two styles per cue: `popup` (spring pop-in over footage) or `fullscreen`
  (cutaway; audio continues).
- Animated word-by-word captions synced to speech.
- Mechanical tightening: pause shaping + silence removal, configurable, every
  auto-cut vetoable. **No filler-word ("um") removal** — deliberately dropped:
  Whisper rarely transcribes disfluencies, so text-matching can't find them.
- Banners (`plan.banners`): a flashing top/bottom title card slammed over a
  stretch of footage, with optional SFX. Anchored to a source time *range*, not
  a spoken phrase — the beats it marks are usually silent (a reaction shot, a
  "FLEX BREAK"). `scripts/make-siren.sh` synthesizes a police-siren wail with
  ffmpeg, so no sample licensing is involved.
- Both formats from one plan: Wide 1920×1080 and Vertical 1080×1920.

## Workflow per video

1. User drops clips into `projects/<name>/input/` and describes the cut.
2. `bash scripts/transcribe.sh <name>` → `transcript/<clip>.json` per clip
   (word-level, whisper.cpp large-v3-turbo). Never transcribe a source twice —
   the script skips up-to-date transcripts.
3. Optional: `npx tsx scripts/describe.ts <name>` → `shotlog/<clip>.json`
   (Gemini clip descriptions + subjectXPct for the vertical crop). Helper, not
   a decision-maker.
3b. **Sanity-check the word timings before planning cuts.** `-ml 1` collapses
   or smears timestamps wherever delivery is slow, mumbled, or followed by a
   long silence — a dozen words land on one timestamp, or drift across the
   silence after them. Find the suspects (`endS - startS >= 0.995` is the
   1.0s clamp firing, and runs of identical `startS` are a collapse), confirm
   against `ffmpeg -af silencedetect`, then repair with
   `npx tsx scripts/retime-window.ts <name> <clip> <winStart> <winEnd>
   [--replace <from> <to>] [--speech <start> <end>] [--dry]`, which
   re-transcribes just that window. Whisper also invents words over leading
   silence — verify the first word is really spoken before cutting to it.
4. Claude writes `edit-plan.json` (schema: `src/types.ts`, `EditPlan`):
   - `baseSegments`: the user's cut, in source time.
   - `overlays`: proposed cue list — **present it to the user**, who sets
     popup/fullscreen and image source per cue, edits, adds, removes, before
     anything renders. Use `npx tsx scripts/find-phrase.ts <name> <clip>
     "<phrase>"` to resolve `wordStartS`/`wordEndS` anchors.
5. `npx tsx scripts/tighten.ts <name>` — fills `segments` and `autoCuts`.
   To veto an auto-cut: set `veto: true` on it in the plan and re-run tighten.
6. `npx tsx scripts/fetch-assets.ts <name>` — resolves each cue's image by
   `source.kind`: `asset` (user file in `assets/`), `pexels` (needs
   `PEXELS_API_KEY`), `web` (Openverse → Wikimedia Commons, **no key**), or
   `generate` (Gemini). Every kind falls through to Gemini generation on a
   miss. `web` records attribution in `assets-resolved/CREDITS.md` — keep it
   with anything published, the results are CC-BY/BY-SA/public-domain.
   Openverse matches on ALL terms: use 2–3 word queries ("vegetable box"), not
   sentences. Its relevance for abstract/tech subjects is poor — always look
   at the resolved images before rendering.
7. `npx tsx scripts/render.ts <name> both --draft` — fast 25%-scale pass.
   Verify sync: extract frames at each overlay's printed output time
   (`ffmpeg -ss <t> -i out/Wide-draft.mp4 -frames:v 1 f.png`) and look at
   them. User reviews the drafts.
8. `npx tsx scripts/render.ts <name> both` — full-res finals, unattended.

Editing `edit-plan.json` only requires re-running render (and tighten if
baseSegments/tighten config changed) — never re-transcribe/re-describe.

## Architecture notes

- `edit-plan.json` is the single source of truth the render consumes.
  Deterministic and hand-editable. All plan times are SOURCE-clip seconds.
- Source→output time remapping lives in `src/timeline.ts`
  (`buildTimelineMapper`) — captions and overlays are remapped through the
  final segment list by `scripts/render.ts`. Never hand-compute output times.
- Pause shaping ported from john-content `shapePauseIntervals`: qualifying
  gaps (≥ `minGapS` 0.8) are shortened to a residual (`targetGapS` 0.25,
  `padS` 0.08 floor) so a natural beat survives — no flush jump cuts.
- Caption grouping policy in `src/captions.ts` (`CAPTION_POLICY`): ≤8
  words/cue, ≤2 lines, ≤32 chars/line, 0.7–4.0s, 17 chars/s reading budget,
  break on 0.4s pauses and sentence punctuation. Highlighting is per-word.
- Fixed edit-op order: cuts → pause removal → silence removal → overlays,
  regardless of plan field order (tighten.ts implements this).
- A deliberately silent insert must be flagged `keepSilence: true` on its
  segment or tighten deletes it whole — it is 100% "dead air" to both passes.
  tighten.ts punches those regions out of every candidate cut
  (`subtractIntervals`) rather than filtering whole cuts, so a cut that only
  overlaps the edge still trims the part outside. Pair it with
  `noCaptions: true`: whisper smears words across silence, and those strays
  would otherwise caption a shot with no speech in it.
- whisper.cpp `-ml 1` end timestamps absorb trailing silence; transcribe.sh
  clamps each word to the next word's start and a 1.0s max duration. Don't
  remove that clamp — pause shaping and remapping depend on it.
- Remotion's public dir is `projects/` (see remotion.config.ts); compositions
  reference media via `staticFile("<project>/…")`.

## Known limits

- `render.ts` reads raw `ffprobe` stream dims, which are pre-rotation. A
  phone-shot portrait clip reports landscape (e.g. 3840x2160 + `rotation:-90`)
  and the crop math in `Edit.tsx` then works off the wrong aspect. Normalize
  such sources first — transcode to a rotation-baked proxy
  (`-vf scale=1080:1920`) and edit against that. Word timings are unaffected,
  so an existing transcript stays valid (`touch` it to keep it newer than the
  new file, or transcribe.sh will redo it).
- Vertical reframe is a static crop (shotlog-guided `subjectXPct`, else
  `cropXPct`, default center; per-segment override on the segment). render.ts
  warns when a source below 1920px height will be upscaled.
- Silence/pause removal produces jump cuts (standard for the genre);
  aggressiveness configurable in `plan.tighten`, any cut vetoable.
- Overlay images only (no video B-roll) in v1. If video B-roll is ever added
  via ffmpeg `enable=between(t,…)`, the overlay's PTS must be shifted or it
  plays the wrong frames — Remotion sidesteps this today.
- Popup geometry is unchecked: `yPct` is the image's *centre*, so a tall image
  high in the frame silently runs off the top. Gemini returns 1024×1024, and a
  square popup at the old default (`yPct` 30, `widthPct` 40) overflows by 60px.
  Rule of thumb for a 1:1 image on Wide: `yPct ≥ widthPct * 0.94` keeps the top
  edge on screen. Check the resolved image's aspect against `xPct/yPct/widthPct`
  before rendering — a still (`npx remotion still … --frame=N`) is far cheaper
  than a draft pass for this.
- Whisper invents words over leading silence — a clip whose first word sits in
  provable silence (verify with `silencedetect`, even at -45dB) did not start
  there. Cutting to that phantom timestamp opens the video on dead air.

## Verification

`bash scripts/e2e.sh` — self-contained end-to-end without real footage
(macOS `say` over an ffmpeg test pattern, planted long pauses, three overlay
cues from colored test assets). It asserts ≥2s removed, 3 overlays mapped,
captions present; then extract frames at the printed overlay times and look
at them (popup/fullscreen, both formats, highlighted word).
