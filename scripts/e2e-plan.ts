// e2e helper: compose edit-plan.json for the synthetic test project by
// locating the three cue phrases in the transcript. Not part of the normal
// workflow (there, Claude writes the plan in chat).
import * as fs from "node:fs";
import * as path from "node:path";
import { EditPlan, OverlayCue, Transcript } from "../src/types";

const project = process.argv[2] ?? "e2e-test";
const clip = "test.mp4";
const projDir = path.resolve(__dirname, "..", "projects", project);
const transcript = Transcript.parse(
  JSON.parse(fs.readFileSync(path.join(projDir, "transcript", `${clip}.json`), "utf8"))
);

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
function find(phrase: string): { startS: number; endS: number } {
  const target = phrase.split(/\s+/).map(norm).filter(Boolean);
  const words = transcript.words;
  for (let i = 0; i <= words.length - target.length; i++) {
    if (target.every((t, j) => norm(words[i + j].word) === t)) {
      return { startS: words[i].startS, endS: words[i + target.length - 1].endS };
    }
  }
  throw new Error(
    `phrase "${phrase}" not in transcript: ${words.map((w) => w.word).join(" ")}`
  );
}

const cue = (
  id: string,
  phrase: string,
  style: "popup" | "fullscreen",
  file: string
): OverlayCue => {
  const hit = find(phrase);
  return OverlayCue.parse({
    id,
    phrase,
    clip,
    wordStartS: hit.startS,
    wordEndS: hit.endS,
    style,
    source: { kind: "asset", file },
  });
};

const plan = EditPlan.parse({
  baseSegments: [{ clip, inS: 0, outS: transcript.durationS }],
  segments: [{ clip, inS: 0, outS: transcript.durationS }],
  overlays: [
    cue("divers", "saturation divers", "popup", "red.png"),
    cue("spaces", "second spaces", "fullscreen", "green.png"),
    cue("car", "sitting in the car", "popup", "blue.png"),
  ],
});

fs.writeFileSync(path.join(projDir, "edit-plan.json"), JSON.stringify(plan, null, 2));
console.log("edit-plan.json written with 3 overlay cues");
