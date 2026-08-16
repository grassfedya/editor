// Assemble render props from edit-plan.json (+ transcripts) and invoke the
// Remotion render. This is where source-time → output-time remapping happens:
// captions and overlay cues are remapped through the final segment list.
// Usage: npx tsx scripts/render.ts <project-name> <Wide|Vertical|both> [--draft]
//   --draft renders at 25% scale (fast sync-check pass).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { EditPlan, Transcript, type RenderProps, type TranscriptWord } from "../src/types";
import { buildTimelineMapper, mapWordsToOutput } from "../src/timeline";

const project = process.argv[2];
const compArg = process.argv[3] ?? "both";
const draft = process.argv.includes("--draft");
if (!project || !["Wide", "Vertical", "both"].includes(compArg)) {
  console.error("usage: npx tsx scripts/render.ts <project-name> <Wide|Vertical|both> [--draft]");
  process.exit(1);
}
const editorDir = path.resolve(__dirname, "..");
const projDir = path.join(editorDir, "projects", project);
const plan = EditPlan.parse(JSON.parse(fs.readFileSync(path.join(projDir, "edit-plan.json"), "utf8")));

if (plan.segments.length === 0) {
  console.error("edit-plan.json has no segments — run tighten.ts (or copy baseSegments into segments)");
  process.exit(1);
}

// Load transcripts for every clip referenced by the final segments.
const clips = [...new Set(plan.segments.map((s) => s.clip))];
const transcripts = new Map<string, TranscriptWord[]>();
for (const clip of clips) {
  const p = path.join(projDir, "transcript", `${clip}.json`);
  if (fs.existsSync(p)) {
    transcripts.set(clip, Transcript.parse(JSON.parse(fs.readFileSync(p, "utf8"))).words);
  } else {
    console.warn(`no transcript for ${clip} — captions/overlays from it will be empty`);
    transcripts.set(clip, []);
  }
}

const mapper = buildTimelineMapper(plan.segments);

// Output-time spans of segments flagged noCaptions. A silent insert still
// carries whatever words whisper smeared across the silence; captioning them
// puts stray text over a shot with no speech in it.
const mutedSpans: { startS: number; endS: number }[] = [];
{
  let acc = 0;
  for (const seg of plan.segments) {
    const dur = seg.outS - seg.inS;
    if (seg.noCaptions) mutedSpans.push({ startS: acc, endS: acc + dur });
    acc += dur;
  }
}
const outputWords = mapWordsToOutput(transcripts, plan.segments).filter(
  (w) => !mutedSpans.some((m) => w.startS < m.endS && w.endS > m.startS)
);

const outputOverlays = plan.overlays.flatMap((cue) => {
  const anchor = mapper.toOutputNear(cue.clip, cue.wordStartS, 0.5);
  if (anchor === null) {
    console.warn(`overlay ${cue.id} ("${cue.phrase}"): anchor word was cut — skipping`);
    return [];
  }
  const outStartS = Math.max(0, anchor - cue.leadS);
  const outEndS = Math.min(mapper.totalDurationS, outStartS + cue.holdS);
  if (!cue.resolvedFile) {
    console.warn(`overlay ${cue.id}: no resolvedFile — run fetch-assets.ts first; skipping`);
    return [];
  }
  return [{ ...cue, outStartS, outEndS }];
});

// Banners are anchored to a source time range, not a spoken phrase — the
// moments they mark are usually silent. Tolerance is wide because the anchor
// is a shot boundary rather than a word.
const outputBanners = plan.banners.flatMap((b) => {
  const outStartS = mapper.toOutputNear(b.clip, b.sourceStartS, 1.5);
  const outEndS = mapper.toOutputNear(b.clip, b.sourceEndS, 1.5);
  if (outStartS === null || outEndS === null || outEndS <= outStartS) {
    console.warn(`banner ${b.id}: source range ${b.sourceStartS}-${b.sourceEndS}s is not in the cut — skipping`);
    return [];
  }
  return [{ ...b, outStartS, outEndS }];
});

// Probe each clip once for dimensions (drives crop math + upscale warning).
const clipMeta: RenderProps["clipMeta"] = {};
for (const clip of clips) {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-show_entries", "format=duration", "-of", "json", path.join(projDir, "input", clip)],
    { encoding: "utf8" }
  );
  const j = JSON.parse(out);
  clipMeta[clip] = {
    width: j.streams?.[0]?.width ?? 1920,
    height: j.streams?.[0]?.height ?? 1080,
    durationS: parseFloat(j.format?.duration ?? "0"),
  };
}

const props: RenderProps = { project, plan, outputWords, outputOverlays, outputBanners, clipMeta };

// Printed so the draft can be verified: extract a frame at each time below and
// look at it (see CLAUDE.md step 7).
for (const c of outputOverlays) {
  console.log(`  overlay ${c.id.padEnd(22)} @ ${c.outStartS.toFixed(2)}s–${c.outEndS.toFixed(2)}s  [${c.style}]  "${c.phrase}"`);
}
for (const b of outputBanners) {
  console.log(`  banner  ${b.id.padEnd(22)} @ ${b.outStartS.toFixed(2)}s–${b.outEndS.toFixed(2)}s  "${b.topText}"`);
}
const propsPath = path.join(projDir, ".render-props.json");
fs.writeFileSync(propsPath, JSON.stringify(props, null, 2));

const comps = compArg === "both" ? ["Wide", "Vertical"] : [compArg];
fs.mkdirSync(path.join(projDir, "out"), { recursive: true });

for (const comp of comps) {
  if (comp === "Vertical") {
    for (const clip of clips) {
      const m = clipMeta[clip];
      if (m.height < 1920) {
        const cropW = Math.round((m.height * 9) / 16);
        console.warn(
          `⚠ ${clip} is ${m.width}x${m.height}: the 9:16 crop uses a ${cropW}x${m.height} region ` +
            `upscaled ${(1920 / m.height).toFixed(2)}x to 1080x1920 — output will be soft.`
        );
      }
    }
  }
  const outFile = path.join(projDir, "out", `${comp}-${draft ? "draft" : "final"}.mp4`);
  console.log(`rendering ${comp} → ${outFile}${draft ? " (draft, 25% scale)" : ""}`);
  const args = [
    "remotion", "render", "remotion/index.ts", comp, outFile,
    `--props=${propsPath}`,
  ];
  if (draft) args.push("--scale=0.25", "--jpeg-quality=70");
  execFileSync("npx", args, { cwd: editorDir, stdio: "inherit" });
}
console.log(`output duration: ${mapper.totalDurationS.toFixed(2)}s, ${outputWords.length} caption words, ${outputOverlays.length} overlays`);
