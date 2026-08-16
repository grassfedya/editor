import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { groupCaptions, CAPTION_POLICY } from "../src/captions";
import type { CaptionConfig, TranscriptWord } from "../src/types";

// Word-highlight captions: words are grouped into cues by the ported policy;
// within the active cue the currently-spoken word is highlighted.
export const Captions: React.FC<{
  words: TranscriptWord[];
  config: CaptionConfig;
}> = ({ words, config }) => {
  const frame = useCurrentFrame();
  const { fps, height, width } = useVideoConfig();
  const t = frame / fps;

  const cues = useMemo(() => groupCaptions(words), [words]);
  const cue = cues.find((c) => t >= c.startS && t < c.endS);
  if (!cue) return null;

  // The active word: the one whose span contains t, else the last one started.
  let activeIdx = -1;
  for (let i = 0; i < cue.words.length; i++) {
    if (t >= cue.words[i].startS) activeIdx = i;
  }

  // Height-relative sizing (ported policy), capped so a full policy line
  // (maxCharsPerLine) always fits the frame width — otherwise the Vertical
  // composition browser-wraps cues past maxLines. 0.55 ≈ avg char width em.
  const usableW = width * (1 - (2 * CAPTION_POLICY.sideMarginPct) / 100);
  const fontSize = Math.min(
    (CAPTION_POLICY.fontSizePctOfHeight / 100) * height,
    usableW / (CAPTION_POLICY.maxCharsPerLine * 0.55)
  );
  let wordIdx = 0;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: (CAPTION_POLICY.bottomMarginPct / 100) * height,
        paddingLeft: (CAPTION_POLICY.sideMarginPct / 100) * width,
        paddingRight: (CAPTION_POLICY.sideMarginPct / 100) * width,
      }}
    >
      <div style={{ textAlign: "center" }}>
        {cue.lines.map((line, li) => (
          <div key={li} style={{ lineHeight: 1.25 }}>
            {line.map((text) => {
              const idx = wordIdx++;
              const active = idx === activeIdx;
              return (
                <span
                  key={idx}
                  style={{
                    fontFamily: config.fontFamily,
                    fontWeight: 800,
                    fontSize,
                    color: active ? config.highlightColor : config.textColor,
                    transform: active ? "scale(1.08)" : "scale(1)",
                    display: "inline-block",
                    // JSX puts no whitespace between these spans, so this
                    // padding is the *only* gap between words. At 0.12em the
                    // highlighted word's scale-up closes it and adjacent words
                    // read as one ("justpregnant").
                    padding: `0 ${fontSize * 0.18}px`,
                    textShadow:
                      "0 2px 8px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.9)",
                    WebkitTextStroke: `${fontSize * 0.03}px rgba(0,0,0,0.6)`,
                  }}
                >
                  {text}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
