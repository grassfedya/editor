// Resolve an image file for every overlay cue in edit-plan.json.
// Resolution order per cue: user asset → Pexels (if PEXELS_API_KEY) → Gemini
// image generation. Writes resolvedFile (path relative to the project dir)
// back into the plan. Already-resolved cues are skipped unless --force.
// Usage: npx tsx scripts/fetch-assets.ts <project-name> [--force]
import * as fs from "node:fs";
import * as path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { EditPlan, type OverlayCue } from "../src/types";

const project = process.argv[2];
const force = process.argv.includes("--force");
if (!project) {
  console.error("usage: npx tsx scripts/fetch-assets.ts <project-name> [--force]");
  process.exit(1);
}
const projDir = path.resolve(__dirname, "..", "projects", project);
const planPath = path.join(projDir, "edit-plan.json");
const resolvedDir = path.join(projDir, "assets-resolved");
fs.mkdirSync(resolvedDir, { recursive: true });

const plan = EditPlan.parse(JSON.parse(fs.readFileSync(planPath, "utf8")));

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function fromPexels(cue: OverlayCue, query: string): Promise<string | null> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  const orientation = cue.style === "fullscreen" ? "landscape" : "landscape";
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=3&orientation=${orientation}`;
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) {
    console.warn(`  pexels ${res.status} for "${query}" — falling through`);
    return null;
  }
  const data: any = await res.json();
  const photo = data.photos?.[0];
  if (!photo) {
    console.warn(`  pexels: no results for "${query}" — falling through`);
    return null;
  }
  const imgRes = await fetch(photo.src.large2x ?? photo.src.original);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const file = `assets-resolved/${safeName(cue.id)}.jpg`;
  fs.writeFileSync(path.join(projDir, file), buf);
  console.log(`  pexels → ${file} (photo ${photo.id} by ${photo.photographer})`);
  return file;
}

// Attribution rows accumulated across the run, flushed to CREDITS.md.
const credits: string[] = [];

async function download(url: string, cue: OverlayCue): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`download ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (url.split("?")[0].match(/\.(jpe?g|png|webp)$/i)?.[1] ?? "jpg").toLowerCase();
  const file = `assets-resolved/${safeName(cue.id)}.${ext === "jpeg" ? "jpg" : ext}`;
  fs.writeFileSync(path.join(projDir, file), buf);
  return file;
}

const UA = "arboria-editor/0.1 (local video toolkit)";

// Openverse: aggregated CC-licensed images, no API key for anonymous search.
async function fromOpenverse(cue: OverlayCue, query: string): Promise<string | null> {
  const url =
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}` +
    `&license_type=commercial&page_size=8&mature=false`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    console.warn(`  openverse ${res.status} for "${query}" — falling through`);
    return null;
  }
  const data: any = await res.json();
  for (const r of data.results ?? []) {
    const src = r.url;
    if (!src) continue;
    // Skip tiny/oddly-shaped source images — they look bad scaled up.
    if (r.width && r.height && (r.width < 800 || r.height < 500)) continue;
    try {
      const file = await download(src, cue);
      credits.push(`- **${cue.id}** — "${r.title ?? "untitled"}" by ${r.creator ?? "unknown"} (${r.license}${r.license_version ? " " + r.license_version : ""}) — ${r.foreign_landing_url ?? src}`);
      console.log(`  openverse → ${file} ("${r.title}" / ${r.license})`);
      return file;
    } catch (e) {
      console.warn(`  openverse candidate failed (${(e as Error).message}) — next`);
    }
  }
  console.warn(`  openverse: no usable result for "${query}" — falling through`);
  return null;
}

// Wikimedia Commons fallback — also key-free, reliably available.
async function fromCommons(cue: OverlayCue, query: string): Promise<string | null> {
  const url =
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search` +
    `&gsrsearch=${encodeURIComponent("filetype:bitmap " + query)}&gsrnamespace=6&gsrlimit=8` +
    `&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=1600`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    console.warn(`  commons ${res.status} for "${query}" — falling through`);
    return null;
  }
  const data: any = await res.json();
  const pages: any[] = Object.values(data.query?.pages ?? {});
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    if (!info) continue;
    if (info.width && info.height && (info.width < 800 || info.height < 500)) continue;
    const src = info.thumburl ?? info.url;
    try {
      const file = await download(src, cue);
      const lic = info.extmetadata?.LicenseShortName?.value ?? "see source";
      const artist = (info.extmetadata?.Artist?.value ?? "unknown").replace(/<[^>]*>/g, "").trim();
      credits.push(`- **${cue.id}** — "${p.title}" by ${artist} (${lic}) — ${info.descriptionurl ?? src}`);
      console.log(`  commons → ${file} (${p.title} / ${lic})`);
      return file;
    } catch (e) {
      console.warn(`  commons candidate failed (${(e as Error).message}) — next`);
    }
  }
  console.warn(`  commons: no usable result for "${query}" — falling through`);
  return null;
}

async function fromGemini(cue: OverlayCue, prompt: string): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const full =
    cue.style === "fullscreen"
      ? `${prompt}. Cinematic photographic style, 16:9 wide framing, no text or watermarks.`
      : `${prompt}. Clean subject on simple background, suitable as a picture-in-picture popup, no text or watermarks.`;
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents: full,
  });
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      const file = `assets-resolved/${safeName(cue.id)}.png`;
      fs.writeFileSync(path.join(projDir, file), Buffer.from(part.inlineData.data, "base64"));
      console.log(`  gemini → ${file}`);
      return file;
    }
  }
  throw new Error(`gemini returned no image for cue ${cue.id}`);
}

async function resolve(cue: OverlayCue): Promise<string> {
  switch (cue.source.kind) {
    case "asset": {
      const rel = `assets/${cue.source.file}`;
      if (!fs.existsSync(path.join(projDir, rel))) {
        throw new Error(`cue ${cue.id}: asset not found: ${rel}`);
      }
      console.log(`  asset → ${rel}`);
      return rel;
    }
    case "pexels": {
      const hit = await fromPexels(cue, cue.source.query);
      return hit ?? fromGemini(cue, cue.source.query);
    }
    case "web": {
      const q = cue.source.query;
      const hit = (await fromOpenverse(cue, q)) ?? (await fromCommons(cue, q));
      return hit ?? fromGemini(cue, q);
    }
    case "generate":
      return fromGemini(cue, cue.source.prompt);
  }
}

(async () => {
  for (const cue of plan.overlays) {
    if (cue.resolvedFile && !force && fs.existsSync(path.join(projDir, cue.resolvedFile))) {
      console.log(`skip (resolved): ${cue.id}`);
      continue;
    }
    console.log(`resolving ${cue.id} ("${cue.phrase}")`);
    cue.resolvedFile = await resolve(cue);
  }
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  if (credits.length) {
    // Merge with any existing rows keyed by cue id — a run that only resolves
    // a few cues must not drop attribution for the ones it skipped.
    const p = path.join(resolvedDir, "CREDITS.md");
    const rows = new Map<string, string>();
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^- \*\*([^*]+)\*\* —/);
        if (m) rows.set(m[1], line);
      }
    }
    for (const line of credits) {
      const m = line.match(/^- \*\*([^*]+)\*\* —/);
      if (m) rows.set(m[1], line);
    }
    const ordered = plan.overlays.map((c) => rows.get(c.id)).filter(Boolean) as string[];
    fs.writeFileSync(p, `# Image credits\n\nOpenly-licensed images fetched for this edit.\n\n${ordered.join("\n")}\n`);
    console.log(`wrote ${path.relative(projDir, p)} (${ordered.length} entries)`);
  }
  console.log("done.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
