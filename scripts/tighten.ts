// Refine edit-plan.json: subtract shaped pauses + detected silence from
// baseSegments to produce the final `segments` list. Every auto cut is
// recorded in plan.autoCuts with a stable id; set veto:true on any of them
// and re-run this script to rebuild segments without that cut.
// Usage: npx tsx scripts/tighten.ts <project-name>
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { EditPlan, Transcript, type AutoCut } from "../src/types";
import {
  shapePauseIntervals,
  applyAutoCuts,
  autoCutId,
  edgeKeepS,
  subtractIntervals,
  type Interval,
} from "../src/timeline";

const project = process.argv[2];
if (!project) {
  console.error("usage: npx tsx scripts/tighten.ts <project-name>");
  process.exit(1);
}
const editorDir = path.resolve(__dirname, "..");
const projDir = path.join(editorDir, "projects", project);
const planPath = path.join(projDir, "edit-plan.json");

const plan = EditPlan.parse(JSON.parse(fs.readFileSync(planPath, "utf8")));
const prevVetoes = new Set(plan.autoCuts.filter((c) => c.veto).map((c) => c.id));

// ffmpeg silencedetect over one clip. Synthesizes an interval end at EOF for
// trailing silence (silencedetect emits no silence_end there).
function detectSilence(clipPath: string, noiseDb: number, minDurS: number, durS: number): Interval[] {
  const hasAudio = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", clipPath],
    { encoding: "utf8" }
  ).includes("audio");
  if (!hasAudio) return [{ startS: 0, endS: durS }];

  const res = spawnSync(
    "ffmpeg",
    ["-i", clipPath, "-af", `silencedetect=noise=${noiseDb}dB:d=${minDurS}`, "-f", "null", "-"],
    { encoding: "utf8" }
  );
  const stderr = res.stderr ?? "";
  const intervals: Interval[] = [];
  let openStart: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start:\s*([\d.]+)/);
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (s) openStart = parseFloat(s[1]);
    if (e && openStart !== null) {
      intervals.push({ startS: openStart, endS: parseFloat(e[1]) });
      openStart = null;
    }
  }
  if (openStart !== null) intervals.push({ startS: openStart, endS: durS }); // trailing silence → EOF
  return intervals;
}

const clips = [...new Set(plan.baseSegments.map((s) => s.clip))];
const autoCuts: AutoCut[] = [];

// Regions the user marked keepSilence: deliberately silent inserts. Both
// passes would flag them wholesale, so every candidate cut is punched through
// with these removed before it becomes an auto cut.
const protectedByClip = new Map<string, Interval[]>();
for (const seg of plan.baseSegments) {
  if (!seg.keepSilence) continue;
  const list = protectedByClip.get(seg.clip) ?? [];
  list.push({ startS: seg.inS, endS: seg.outS });
  protectedByClip.set(seg.clip, list);
}
const push = (clip: string, iv: Interval, reason: "pause" | "silence") => {
  for (const piece of subtractIntervals(iv, protectedByClip.get(clip) ?? [])) {
    const id = autoCutId(clip, piece.startS, piece.endS);
    autoCuts.push({ id, clip, startS: piece.startS, endS: piece.endS, reason, veto: prevVetoes.has(id) });
  }
};

for (const clip of clips) {
  const tPath = path.join(projDir, "transcript", `${clip}.json`);
  if (!fs.existsSync(tPath)) {
    console.error(`missing transcript for ${clip} — run scripts/transcribe.sh ${project} first`);
    process.exit(1);
  }
  const transcript = Transcript.parse(JSON.parse(fs.readFileSync(tPath, "utf8")));

  if (plan.tighten.enabled) {
    for (const iv of shapePauseIntervals(transcript.words, plan.tighten, transcript.durationS)) {
      push(clip, iv, "pause");
    }
    if (plan.tighten.silence.enabled) {
      const keep = edgeKeepS(plan.tighten);
      const clipPath = path.join(projDir, "input", clip);
      for (const iv of detectSilence(clipPath, plan.tighten.silence.noiseDb, plan.tighten.silence.minDurS, transcript.durationS)) {
        // Trim inward so silence cuts respect the same residual-beat rule,
        // and skip anything the pause pass already covers.
        const startS = iv.startS + keep;
        const endS = iv.endS - keep;
        if (endS <= startS) continue;
        const dup = autoCuts.some((c) => c.clip === clip && c.startS <= startS && c.endS >= endS);
        if (dup) continue;
        push(clip, { startS, endS }, "silence");
      }
    }
  }
}

plan.autoCuts = autoCuts;
plan.segments = plan.tighten.enabled ? applyAutoCuts(plan.baseSegments, autoCuts) : plan.baseSegments;

fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

const baseDur = plan.baseSegments.reduce((n, s) => n + s.outS - s.inS, 0);
const finalDur = plan.segments.reduce((n, s) => n + s.outS - s.inS, 0);
console.log(
  `tightened: ${autoCuts.filter((c) => !c.veto).length} cuts (${autoCuts.filter((c) => c.reason === "pause").length} pause, ${autoCuts.filter((c) => c.reason === "silence").length} silence), ` +
    `${baseDur.toFixed(1)}s → ${finalDur.toFixed(1)}s`
);
