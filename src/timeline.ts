import type { Segment, TranscriptWord, TightenConfig, AutoCut } from "./types";

export interface Interval {
  startS: number;
  endS: number;
}

// ---------------------------------------------------------------------------
// Pause shaping — ported from john-content shapePauseIntervals (pw_tools.go).
// Qualifying gaps are trimmed inward by edgeKeep on every word-adjacent side,
// so cuts never butt against a word and a natural residual pause survives.
// Leading/trailing regions only pad the single side that abuts a word — the
// clip head and tail are cut flush.
// ---------------------------------------------------------------------------

export function edgeKeepS(cfg: { targetGapS: number; padS: number }): number {
  const half = cfg.targetGapS / 2;
  return half > cfg.padS ? half : cfg.padS;
}

export function shapePauseIntervals(
  words: TranscriptWord[],
  cfg: { minGapS: number; targetGapS: number; padS: number },
  sourceDurationS: number
): Interval[] {
  if (words.length === 0) return [{ startS: 0, endS: sourceDurationS }];
  const clamp = (t: number) => Math.min(Math.max(t, 0), sourceDurationS);
  const spans = [...words].sort((a, b) => a.startS - b.startS);
  const keep = edgeKeepS(cfg);
  const pauses: Interval[] = [];

  const first = clamp(spans[0].startS);
  if (first >= cfg.minGapS) {
    const cutEnd = first - keep;
    if (cutEnd > 0) pauses.push({ startS: 0, endS: cutEnd });
  }
  for (let i = 1; i < spans.length; i++) {
    const prevEnd = clamp(spans[i - 1].endS);
    const thisStart = clamp(spans[i].startS);
    if (thisStart - prevEnd < cfg.minGapS) continue;
    const cutStart = prevEnd + keep;
    const cutEnd = thisStart - keep;
    if (cutEnd > cutStart) pauses.push({ startS: cutStart, endS: cutEnd });
  }
  const lastEnd = clamp(spans[spans.length - 1].endS);
  if (sourceDurationS - lastEnd >= cfg.minGapS) {
    const cutStart = lastEnd + keep;
    if (cutStart < sourceDurationS) pauses.push({ startS: cutStart, endS: sourceDurationS });
  }
  return pauses;
}

// Merge overlapping/adjacent intervals; returns sorted, disjoint intervals.
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.startS - b.startS);
  const out: Interval[] = [{ ...sorted[0] }];
  for (const iv of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (iv.startS <= last.endS) last.endS = Math.max(last.endS, iv.endS);
    else out.push({ ...iv });
  }
  return out;
}

// Subtract cut intervals from one base segment, yielding the kept pieces.
// Degenerate slivers below minPieceS are dropped (they read as glitches).
export function subtractCuts(
  seg: Segment,
  cuts: Interval[],
  minPieceS = 0.1
): Segment[] {
  const relevant = mergeIntervals(
    cuts.filter((c) => c.endS > seg.inS && c.startS < seg.outS)
  );
  const pieces: Segment[] = [];
  let cursor = seg.inS;
  for (const c of relevant) {
    const cutStart = Math.max(c.startS, seg.inS);
    if (cutStart - cursor >= minPieceS) {
      pieces.push({ ...seg, inS: cursor, outS: cutStart });
    }
    cursor = Math.max(cursor, Math.min(c.endS, seg.outS));
  }
  if (seg.outS - cursor >= minPieceS) pieces.push({ ...seg, inS: cursor, outS: seg.outS });
  return pieces;
}

// Remove protected regions from one interval, splitting it where a protected
// region sits in the middle. Used to keep auto cuts out of keepSilence
// segments, which are deliberately silent and would otherwise be cut whole.
export function subtractIntervals(iv: Interval, protect: Interval[]): Interval[] {
  let pieces: Interval[] = [iv];
  for (const p of mergeIntervals(protect)) {
    const next: Interval[] = [];
    for (const piece of pieces) {
      if (p.endS <= piece.startS || p.startS >= piece.endS) {
        next.push(piece); // no overlap
        continue;
      }
      if (p.startS > piece.startS) next.push({ startS: piece.startS, endS: p.startS });
      if (p.endS < piece.endS) next.push({ startS: p.endS, endS: piece.endS });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.endS > p.startS);
}

export function autoCutId(clip: string, startS: number, endS: number): string {
  return `${clip}@${Math.round(startS * 1000)}-${Math.round(endS * 1000)}`;
}

// Apply non-vetoed auto cuts to the base segments, preserving order.
export function applyAutoCuts(baseSegments: Segment[], autoCuts: AutoCut[]): Segment[] {
  const byClip = new Map<string, Interval[]>();
  for (const c of autoCuts) {
    if (c.veto) continue;
    const list = byClip.get(c.clip) ?? [];
    list.push({ startS: c.startS, endS: c.endS });
    byClip.set(c.clip, list);
  }
  return baseSegments.flatMap((seg) => subtractCuts(seg, byClip.get(seg.clip) ?? []));
}

// ---------------------------------------------------------------------------
// Source→output time mapping. After tightening, a word's source timestamp no
// longer equals its output timestamp; captions and overlay cues must be
// remapped through the final segment list. This is the single canonical
// mapping — everything that renders in output time goes through it.
// ---------------------------------------------------------------------------

export interface TimelineMapper {
  totalDurationS: number;
  // Maps (clip, source time) → output time, or null if that instant was cut.
  toOutput(clip: string, sourceS: number): number | null;
  // Like toOutput but snaps to the nearest kept instant within `toleranceS`
  // (a word straddling a trimmed edge still resolves). Null if nothing near.
  toOutputNear(clip: string, sourceS: number, toleranceS?: number): number | null;
}

export function buildTimelineMapper(segments: Segment[]): TimelineMapper {
  let acc = 0;
  const placed = segments.map((seg) => {
    const outStartS = acc;
    acc += seg.outS - seg.inS;
    return { ...seg, outStartS };
  });
  const toOutput = (clip: string, sourceS: number): number | null => {
    for (const seg of placed) {
      if (seg.clip === clip && sourceS >= seg.inS && sourceS <= seg.outS) {
        return seg.outStartS + (sourceS - seg.inS);
      }
    }
    return null;
  };
  return {
    totalDurationS: acc,
    toOutput,
    toOutputNear(clip, sourceS, toleranceS = 0.5) {
      const direct = toOutput(clip, sourceS);
      if (direct !== null) return direct;
      let best: { dist: number; outS: number } | null = null;
      for (const seg of placed) {
        if (seg.clip !== clip) continue;
        const clamped = Math.min(Math.max(sourceS, seg.inS), seg.outS);
        const dist = Math.abs(clamped - sourceS);
        if (dist <= toleranceS && (!best || dist < best.dist)) {
          best = { dist, outS: seg.outStartS + (clamped - seg.inS) };
        }
      }
      return best?.outS ?? null;
    },
  };
}

// Remap transcript words (source time, per clip) into output-time words.
// Words that were entirely cut are dropped.
export function mapWordsToOutput(
  transcripts: Map<string, TranscriptWord[]>,
  segments: Segment[]
): TranscriptWord[] {
  const mapper = buildTimelineMapper(segments);
  const out: TranscriptWord[] = [];
  for (const [clip, words] of transcripts) {
    for (const w of words) {
      // Map start and end independently: a word straddling a cut edge keeps
      // whichever side survived. Drop only words that are entirely cut.
      //
      // Require a real overlap first. toOutputNear's tolerance exists to
      // rescue an edge whose timestamp is slightly off, but on its own it also
      // pulls in a word that finished just *before* the cut — and where two
      // takes of the same line are spliced together, that captions the tail of
      // the discarded take over the start of the kept one.
      const dur = w.endS - w.startS;
      const overlapsKept =
        mapper.toOutput(clip, w.startS) !== null ||
        mapper.toOutput(clip, w.endS) !== null ||
        mapper.toOutput(clip, (w.startS + w.endS) / 2) !== null;
      if (!overlapsKept) continue;
      const outStart = mapper.toOutputNear(clip, w.startS, 0.25);
      const outEnd = mapper.toOutputNear(clip, w.endS, 0.25);
      if (outStart === null && outEnd === null) continue;
      const startS = outStart ?? Math.max(0, (outEnd as number) - dur);
      const endS = outEnd ?? Math.min(mapper.totalDurationS, startS + dur);
      out.push({ word: w.word, startS, endS: Math.max(endS, startS + 0.02) });
    }
  }
  return out.sort((a, b) => a.startS - b.startS);
}
