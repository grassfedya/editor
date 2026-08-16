// Repair a range of word timings in an existing transcript by re-running
// whisper.cpp over just that window of audio.
//
// Why this exists: whisper's `-ml 1` word timestamps collapse when a take is
// slow, mumbled, or followed by a long silent stretch — a dozen words land on
// one timestamp, or get smeared across the silence that follows. Captions built
// from those timings flash all at once and then go dead. Re-transcribing the
// window alone (with the surrounding silence as padding) gives whisper a much
// easier alignment problem and produces usable timings.
//
// Usage:
//   npx tsx scripts/retime-window.ts <project> <clip> <winStartS> <winEndS> \
//     [--replace <fromS> <toS>] [--speech <startS> <endS>] [--dry]
//
//   --replace  source range whose words are swapped out (default: the window)
//   --gain     boost the window by N dB before transcribing. A trailing aside
//              muttered off-mic transcribes as silence — or worse, as a
//              hallucinated "Thank you." Lift it and whisper hears the words.
//   --speech   measured speech boundaries from silencedetect. Words falling
//              before/after are linearly warped back inside — whisper clamps a
//              word that begins before the window to the window edge, which
//              would otherwise place it in silence.
//   --dry      print the new words, write nothing.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Transcript, type TranscriptWord } from "../src/types";

const argv = process.argv.slice(2);
const flag = (name: string, n: number): string[] | null => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv.slice(i + 1, i + 1 + n);
};
const [project, clip, winStartRaw, winEndRaw] = argv;
if (!project || !clip || !winStartRaw || !winEndRaw) {
  console.error("usage: npx tsx scripts/retime-window.ts <project> <clip> <winStartS> <winEndS> [--replace <fromS> <toS>] [--speech <startS> <endS>] [--dry]");
  process.exit(1);
}
const winStart = parseFloat(winStartRaw);
const winEnd = parseFloat(winEndRaw);
const replaceArgs = flag("--replace", 2);
const repFrom = replaceArgs ? parseFloat(replaceArgs[0]) : winStart;
const repTo = replaceArgs ? parseFloat(replaceArgs[1]) : winEnd;
const speechArgs = flag("--speech", 2);
const gainArgs = flag("--gain", 1);
const gainDb = gainArgs ? parseFloat(gainArgs[0]) : 0;
const dry = argv.includes("--dry");

const editorDir = path.resolve(__dirname, "..");
const projDir = path.join(editorDir, "projects", project);
const clipPath = path.join(projDir, "input", clip);
const tPath = path.join(projDir, "transcript", `${clip}.json`);
const model = path.join(editorDir, "models", "ggml-large-v3-turbo.bin");

const transcript = Transcript.parse(JSON.parse(fs.readFileSync(tPath, "utf8")));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retime-"));
try {
  const wav = path.join(tmp, "win.wav");
  execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(winStart), "-t", String(winEnd - winStart), "-i", clipPath,
    ...(gainDb ? ["-af", `volume=${gainDb}dB`] : []),
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-y", wav,
  ]);

  const outBase = path.join(tmp, "win");
  const run = (extra: string[]) =>
    execFileSync("whisper-cli", ["-m", model, "-f", wav, "-ml", "1", "-sow", "-oj", "-of", outBase, ...extra, "-t", "8"], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    run(["--dtw", "large.v3.turbo"]);
  } catch {
    run([]); // build without DTW support
  }

  const raw = JSON.parse(fs.readFileSync(`${outBase}.json`, "utf8"));
  let fresh: TranscriptWord[] = (raw.transcription ?? [])
    .filter((s: any) => s.text.trim())
    .map((s: any) => ({
      word: s.text.trim(),
      startS: s.offsets.from / 1000 + winStart,
      endS: s.offsets.to / 1000 + winStart,
    }));

  // Warp the window's words onto the measured speech span. whisper clamps a
  // word that starts before the window to the window edge; without this the
  // leading words sit in silence and the caption leads the audio.
  if (speechArgs && fresh.length) {
    const [sStart, sEnd] = speechArgs.map(parseFloat);
    const wStart = fresh[0].startS;
    const wEnd = fresh[fresh.length - 1].endS;
    if (wEnd > wStart) {
      const scale = (sEnd - sStart) / (wEnd - wStart);
      const map = (t: number) => sStart + (t - wStart) * scale;
      fresh = fresh.map((w) => ({ ...w, startS: map(w.startS), endS: map(w.endS) }));
    }
  }

  fresh = fresh.filter((w) => w.startS >= repFrom && w.startS < repTo);

  const before = transcript.words.length;
  const kept = transcript.words.filter((w) => w.startS < repFrom || w.startS >= repTo);
  const merged = [...kept, ...fresh].sort((a, b) => a.startS - b.startS);

  console.log(`window ${winStart}-${winEnd}s, replacing [${repFrom}, ${repTo}) in ${clip}`);
  console.log(`  ${before - kept.length} words out → ${fresh.length} words in`);
  console.log("  " + fresh.map((w) => `${w.startS.toFixed(2)} ${w.word}`).join(" | "));

  if (dry) {
    console.log("(dry run — transcript not written)");
  } else {
    transcript.words = merged;
    fs.writeFileSync(tPath, JSON.stringify(transcript, null, 2));
    console.log(`  wrote ${path.relative(editorDir, tPath)} (${merged.length} words)`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
