// Locate a spoken phrase in a clip's transcript → source-time anchors for an
// overlay cue. Matching is case/punctuation-insensitive over the word stream.
// Usage: npx tsx scripts/find-phrase.ts <project-name> <clip-filename> "<phrase>"
import * as fs from "node:fs";
import * as path from "node:path";
import { Transcript } from "../src/types";

const [project, clip, phrase] = process.argv.slice(2);
if (!project || !clip || !phrase) {
  console.error('usage: npx tsx scripts/find-phrase.ts <project> <clip> "<phrase>"');
  process.exit(1);
}
const tPath = path.resolve(__dirname, "..", "projects", project, "transcript", `${clip}.json`);
const transcript = Transcript.parse(JSON.parse(fs.readFileSync(tPath, "utf8")));

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
const target = phrase.split(/\s+/).map(norm).filter(Boolean);
const words = transcript.words;

let found = 0;
for (let i = 0; i <= words.length - target.length; i++) {
  if (target.every((t, j) => norm(words[i + j].word) === t)) {
    const startS = words[i].startS;
    const endS = words[i + target.length - 1].endS;
    console.log(
      JSON.stringify({ clip, phrase, wordStartS: startS, wordEndS: endS }, null, 2)
    );
    found++;
  }
}
if (found === 0) {
  console.error(`phrase not found. Transcript words near matches of "${target[0]}":`);
  words.forEach((w, i) => {
    if (norm(w.word) === target[0]) {
      const ctx = words.slice(i, i + target.length + 2).map((x) => x.word).join(" ");
      console.error(`  ${w.startS.toFixed(2)}s: ${ctx}`);
    }
  });
  process.exit(1);
}
