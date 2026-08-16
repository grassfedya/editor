import { z } from "zod";

// ---------------------------------------------------------------------------
// Transcript — one file per source clip: projects/<name>/transcript/<clip>.json
// All times are seconds in the SOURCE clip's timeline.
// ---------------------------------------------------------------------------

export const TranscriptWord = z.object({
  word: z.string(),
  startS: z.number(),
  endS: z.number(),
});
export type TranscriptWord = z.infer<typeof TranscriptWord>;

export const Transcript = z.object({
  clip: z.string(), // filename relative to projects/<name>/input/
  durationS: z.number(),
  words: z.array(TranscriptWord),
});
export type Transcript = z.infer<typeof Transcript>;

// ---------------------------------------------------------------------------
// Shot log — optional Gemini clip descriptions: projects/<name>/shotlog.json
// ---------------------------------------------------------------------------

export const ShotLogEntry = z.object({
  startS: z.number(),
  endS: z.number(),
  description: z.string(),
  // Horizontal center of the main subject as % of frame width (0–100).
  // Drives the 9:16 crop; null/absent means "unknown, use center".
  subjectXPct: z.number().min(0).max(100).nullish(),
});

export const ShotLog = z.object({
  clip: z.string(),
  entries: z.array(ShotLogEntry),
});
export type ShotLog = z.infer<typeof ShotLog>;

// ---------------------------------------------------------------------------
// Edit plan — the single source of truth the render consumes.
// projects/<name>/edit-plan.json — hand-editable, deterministic.
// ---------------------------------------------------------------------------

export const Segment = z.object({
  clip: z.string(),
  inS: z.number(),
  outS: z.number(),
  label: z.string().optional(),
  // Per-segment override of the vertical crop center (% of source width).
  cropXPct: z.number().min(0).max(100).optional(),
  // Protect this segment from tighten.ts. Deliberately silent inserts (a
  // reaction shot, a flex break) are entirely "dead air" and would otherwise
  // be cut away completely by the pause/silence passes.
  keepSilence: z.boolean().optional(),
  // Drop captions over this segment. Speech-free inserts still pick up
  // whatever words whisper smeared across the silence; those are noise.
  noCaptions: z.boolean().optional(),
});
export type Segment = z.infer<typeof Segment>;

// An automatic cut produced by tighten.ts. Kept in the plan so the user can
// veto any of them (set veto:true) and re-run tighten to rebuild `segments`.
export const AutoCut = z.object({
  id: z.string(), // stable: "<clip>@<startMs>-<endMs>"
  clip: z.string(),
  startS: z.number(),
  endS: z.number(),
  reason: z.enum(["pause", "silence"]),
  veto: z.boolean().default(false),
});
export type AutoCut = z.infer<typeof AutoCut>;

export const TightenConfig = z.object({
  enabled: z.boolean().default(true),
  // Pause shaping (ported from john-content shapePauseIntervals):
  // gaps < minGapS are never cut; qualifying gaps are shortened to targetGapS
  // total residual, never closer than padS to a word edge.
  minGapS: z.number().default(0.8),
  targetGapS: z.number().default(0.25),
  padS: z.number().default(0.08),
  // ffmpeg silencedetect pass — catches non-speech dead air whisper missed.
  silence: z
    .object({
      enabled: z.boolean().default(true),
      noiseDb: z.number().default(-35),
      minDurS: z.number().default(1.0),
    })
    .default({}),
});
export type TightenConfig = z.infer<typeof TightenConfig>;

export const OverlaySource = z.discriminatedUnion("kind", [
  // User-provided file in projects/<name>/assets/
  z.object({ kind: z.literal("asset"), file: z.string() }),
  // Pexels search (requires PEXELS_API_KEY; falls through to generate if unset)
  z.object({ kind: z.literal("pexels"), query: z.string() }),
  // Openly-licensed web image search — no API key. Openverse first, then
  // Wikimedia Commons. Attribution is recorded in assets-resolved/CREDITS.md.
  z.object({ kind: z.literal("web"), query: z.string() }),
  // Gemini image generation
  z.object({ kind: z.literal("generate"), prompt: z.string() }),
]);
export type OverlaySource = z.infer<typeof OverlaySource>;

export const OverlayCue = z.object({
  id: z.string(),
  // The spoken phrase this cue syncs to. tighten/plan tooling locates it in
  // the transcript; wordStartS/wordEndS are the resolved source-time anchors.
  phrase: z.string(),
  clip: z.string(),
  wordStartS: z.number(),
  wordEndS: z.number(),
  style: z.enum(["popup", "fullscreen"]),
  source: OverlaySource,
  // Filled by fetch-assets.ts: path relative to projects/<name>/
  resolvedFile: z.string().optional(),
  holdS: z.number().default(1.5), // how long the overlay stays up
  leadS: z.number().default(0.15), // enters this early before the first word
  // Percent-anchored geometry (popup style only) — same numbers render
  // correctly in both compositions. Defaults: centered, upper third, 42% wide.
  xPct: z.number().default(50),
  yPct: z.number().default(30),
  widthPct: z.number().default(42),
});
export type OverlayCue = z.infer<typeof OverlayCue>;

// ---------------------------------------------------------------------------
// Banner — a full-width title card slammed over the footage for a beat, with
// optional SFX. Unlike an overlay cue it carries no image and is anchored to a
// source time range rather than a spoken phrase (the moments it marks are
// typically silent).
// ---------------------------------------------------------------------------

export const BannerCue = z.object({
  id: z.string(),
  clip: z.string(),
  // SOURCE-clip seconds, like every other time in the plan. render.ts remaps
  // these through the final segment list.
  sourceStartS: z.number(),
  sourceEndS: z.number(),
  topText: z.string(),
  bottomText: z.string(),
  bgColor: z.string().default("#e10600"),
  textColor: z.string().default("#ffffff"),
  // Alternating-colour flash rate, in flashes per second. 0 disables it.
  flashHz: z.number().default(5),
  // Red wash pulsed over the whole frame, 0–1. Sells the siren.
  strobeOpacity: z.number().default(0.22),
  // Audio file relative to the project dir, e.g. "sfx/siren.wav".
  sfx: z.string().optional(),
  sfxVolume: z.number().default(0.5),
});
export type BannerCue = z.infer<typeof BannerCue>;

export const CaptionConfig = z.object({
  enabled: z.boolean().default(true),
  // Colors; sizing/grouping constants live in captions.ts (ported policy).
  textColor: z.string().default("#ffffff"),
  highlightColor: z.string().default("#ffd60a"),
  fontFamily: z.string().default("Helvetica Neue, Helvetica, Arial, sans-serif"),
});
export type CaptionConfig = z.infer<typeof CaptionConfig>;

export const EditPlan = z.object({
  // The user's cut, in order, in source time. tighten.ts refines this into
  // `segments` by subtracting non-vetoed autoCuts. If tighten is disabled,
  // segments === baseSegments.
  baseSegments: z.array(Segment),
  segments: z.array(Segment),
  autoCuts: z.array(AutoCut).default([]),
  tighten: TightenConfig.default({}),
  overlays: z.array(OverlayCue).default([]),
  banners: z.array(BannerCue).default([]),
  captions: CaptionConfig.default({}),
  // Default vertical crop center when neither segment nor shotlog says better.
  cropXPct: z.number().min(0).max(100).default(50),
  fps: z.number().default(30),
});
export type EditPlan = z.infer<typeof EditPlan>;

// ---------------------------------------------------------------------------
// Render props — what the render script hands to Remotion compositions.
// Assembled by scripts/render.sh from the plan + transcripts; paths are
// relative to the Remotion public dir (the projects/ folder).
// ---------------------------------------------------------------------------

export const RenderProps = z.object({
  project: z.string(),
  plan: EditPlan,
  // Words already mapped to OUTPUT time (seconds) by src/timeline.ts.
  outputWords: z.array(TranscriptWord),
  // Overlay cues with resolved output-time entry points.
  outputOverlays: z.array(
    OverlayCue.extend({ outStartS: z.number(), outEndS: z.number() })
  ),
  outputBanners: z.array(
    BannerCue.extend({ outStartS: z.number(), outEndS: z.number() })
  ).default([]),
  // Per-clip metadata probed at render-prep time.
  clipMeta: z.record(
    z.string(),
    z.object({ width: z.number(), height: z.number(), durationS: z.number() })
  ),
});
export type RenderProps = z.infer<typeof RenderProps>;
