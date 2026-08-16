// OPTIONAL helper: describe each input clip with Gemini → shotlog.json.
// Gives Claude clip summaries for edit planning and a subject position for
// the 9:16 crop. A helper, not a decision-maker.
//
// Uploads a 360p proxy via the Gemini File API. Uploads are cached (keyed by
// path+mtime in .cache/uploads.json) so re-runs don't re-upload; files expire
// server-side after ~48h. Pass --cleanup to delete server files afterwards.
// Usage: npx tsx scripts/describe.ts <project-name> [--cleanup]
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { GoogleGenAI, createUserContent, createPartFromUri } from "@google/genai";
import { ShotLog } from "../src/types";

const project = process.argv[2];
const cleanup = process.argv.includes("--cleanup");
if (!project) {
  console.error("usage: npx tsx scripts/describe.ts <project-name> [--cleanup]");
  process.exit(1);
}
const editorDir = path.resolve(__dirname, "..");
const projDir = path.join(editorDir, "projects", project);
const cacheDir = path.join(editorDir, ".cache");
const cachePath = path.join(cacheDir, "uploads.json");
fs.mkdirSync(cacheDir, { recursive: true });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const cache: Record<string, { name: string; uri: string; mimeType: string; mtimeMs: number }> =
  fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};

async function uploadProxy(clipPath: string) {
  const stat = fs.statSync(clipPath);
  const cached = cache[clipPath];
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    try {
      const f = await ai.files.get({ name: cached.name });
      if (f.state === "ACTIVE") {
        console.log("  upload cache hit");
        return cached;
      }
    } catch {
      /* expired — re-upload */
    }
  }
  const proxy = path.join(os.tmpdir(), `proxy-${path.basename(clipPath)}.mp4`);
  console.log("  making 360p proxy…");
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-i", clipPath,
    "-vf", "scale=-2:360", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
    "-c:a", "aac", "-b:a", "64k", proxy,
  ]);
  console.log("  uploading…");
  const file = await ai.files.upload({ file: proxy, config: { mimeType: "video/mp4" } });
  // Poll to ACTIVE with timeout.
  const deadline = Date.now() + 120_000;
  let f = file;
  while (f.state !== "ACTIVE") {
    if (f.state === "FAILED") throw new Error(`upload failed for ${clipPath}`);
    if (Date.now() > deadline) throw new Error(`upload never became ACTIVE: ${clipPath}`);
    await new Promise((r) => setTimeout(r, 2000));
    f = await ai.files.get({ name: file.name! });
  }
  fs.rmSync(proxy, { force: true });
  const entry = { name: f.name!, uri: f.uri!, mimeType: f.mimeType!, mtimeMs: stat.mtimeMs };
  cache[clipPath] = entry;
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  return entry;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          startS: { type: "number" },
          endS: { type: "number" },
          description: { type: "string" },
          subjectXPct: { type: "number", description: "horizontal center of main subject, 0-100 % of frame width" },
        },
        required: ["startS", "endS", "description"],
      },
    },
  },
  required: ["entries"],
};

(async () => {
  const inputDir = path.join(projDir, "input");
  const shotlogDir = path.join(projDir, "shotlog");
  fs.mkdirSync(shotlogDir, { recursive: true });

  for (const base of fs.readdirSync(inputDir)) {
    if (!/\.(mp4|mov|mkv|webm)$/i.test(base)) continue;
    const outPath = path.join(shotlogDir, `${base}.json`);
    if (fs.existsSync(outPath)) {
      console.log(`skip (exists): ${base}`);
      continue;
    }
    console.log(`describing: ${base}`);
    const clipPath = path.join(inputDir, base);
    const up = await uploadProxy(clipPath);

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: createUserContent([
        createPartFromUri(up.uri, up.mimeType),
        "Segment this video into visually distinct shots. For each shot give startS/endS " +
          "(seconds), a one-sentence description of what is on screen, and subjectXPct — the " +
          "horizontal center of the main subject as a percentage of frame width (50 = centered). " +
          "Give denser, more precise timestamps around any moment where the framing or subject " +
          "position changes.",
      ]),
      config: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
    });
    const parsed = JSON.parse(response.text ?? "{}");
    const shotlog = ShotLog.parse({ clip: base, entries: parsed.entries ?? [] });
    fs.writeFileSync(outPath, JSON.stringify(shotlog, null, 2));
    console.log(`  ${shotlog.entries.length} shots → shotlog/${base}.json`);

    if (cleanup) {
      await ai.files.delete({ name: up.name });
      delete cache[clipPath];
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
    }
  }
  console.log("done.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
