import type { TranscriptWord } from "./types";

// Caption grouping policy — ported from john-content's ASS cue constants.
// Groups output-time words into cues; highlighting stays per-word.
export const CAPTION_POLICY = {
  maxWordsPerCue: 8,
  maxLines: 2,
  maxCharsPerLine: 32,
  minCueDurS: 0.7,
  maxCueDurS: 4.0,
  charsPerSec: 17, // reading budget
  breakPauseS: 0.4, // start a new cue across a pause this long
  bottomMarginPct: 8, // safe-area margins
  sideMarginPct: 6,
  fontSizePctOfHeight: 4.2, // font sizing relative to frame height
} as const;

export interface CaptionCue {
  words: TranscriptWord[]; // output-time words
  lines: string[][]; // words split into ≤maxLines display lines
  startS: number;
  endS: number;
}

const SENTENCE_END = /[.!?…]["')\]]?$/;

function splitLines(words: string[]): string[][] {
  const lines: string[][] = [[]];
  let lineLen = 0;
  for (const w of words) {
    const cur = lines[lines.length - 1];
    const addLen = (cur.length > 0 ? 1 : 0) + w.length;
    if (cur.length > 0 && lineLen + addLen > CAPTION_POLICY.maxCharsPerLine) {
      lines.push([w]);
      lineLen = w.length;
    } else {
      cur.push(w);
      lineLen += addLen;
    }
  }
  return lines;
}

export function groupCaptions(words: TranscriptWord[]): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let cur: TranscriptWord[] = [];

  const charCount = (ws: TranscriptWord[]) =>
    ws.reduce((n, w) => n + w.word.length, 0) + Math.max(0, ws.length - 1);

  const flush = () => {
    if (cur.length === 0) return;
    const startS = cur[0].startS;
    // End: last word end, floored to reading budget + min duration, capped.
    const readS = charCount(cur) / CAPTION_POLICY.charsPerSec;
    let endS = Math.max(
      cur[cur.length - 1].endS,
      startS + Math.max(readS, CAPTION_POLICY.minCueDurS)
    );
    endS = Math.min(endS, startS + CAPTION_POLICY.maxCueDurS);
    cues.push({
      words: cur,
      lines: splitLines(cur.map((w) => w.word)),
      startS,
      endS,
    });
    cur = [];
  };

  for (const w of words) {
    if (cur.length > 0) {
      const prev = cur[cur.length - 1];
      const gap = w.startS - prev.endS;
      const wouldOverflow =
        cur.length + 1 > CAPTION_POLICY.maxWordsPerCue ||
        charCount([...cur, w]) >
          CAPTION_POLICY.maxCharsPerLine * CAPTION_POLICY.maxLines ||
        w.endS - cur[0].startS > CAPTION_POLICY.maxCueDurS;
      if (gap >= CAPTION_POLICY.breakPauseS || SENTENCE_END.test(prev.word) || wouldOverflow) {
        flush();
      }
    }
    cur.push(w);
  }
  flush();

  // Clamp each cue's display end so it never overlaps the next cue's start.
  for (let i = 0; i < cues.length - 1; i++) {
    cues[i].endS = Math.min(cues[i].endS, cues[i + 1].startS);
  }
  return cues;
}
