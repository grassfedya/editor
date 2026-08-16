import React from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { BannerCue } from "../src/types";

type OutputBanner = BannerCue & { outStartS: number; outEndS: number };

// A band of text slammed across the frame. Both bands share the flash phase so
// they read as one unit rather than two blinking rectangles.
const Band: React.FC<{
  text: string;
  edge: "top" | "bottom";
  cue: OutputBanner;
  inverted: boolean;
  offset: number;
}> = ({ text, edge, cue, inverted, offset }) => {
  const { width, height } = useVideoConfig();

  // Size to the frame, then shrink if this string would overrun the width.
  // 0.62 ≈ average glyph width per em for heavy condensed uppercase.
  const usableW = width * 0.94;
  const fontSize = Math.min(
    height * 0.11,
    usableW / Math.max(1, text.length * 0.62)
  );
  const padY = fontSize * 0.22;

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        [edge]: height * 0.06,
        transform: `translateY(${edge === "top" ? -offset : offset}px) skewY(-1.2deg)`,
        backgroundColor: inverted ? cue.textColor : cue.bgColor,
        borderTop: `${Math.round(fontSize * 0.07)}px solid ${inverted ? cue.bgColor : cue.textColor}`,
        borderBottom: `${Math.round(fontSize * 0.07)}px solid ${inverted ? cue.bgColor : cue.textColor}`,
        padding: `${padY}px 0`,
        textAlign: "center",
        boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
      }}
    >
      <span
        style={{
          fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif",
          fontWeight: 900,
          fontSize,
          lineHeight: 1,
          letterSpacing: fontSize * 0.02,
          color: inverted ? cue.bgColor : cue.textColor,
          textTransform: "uppercase",
          display: "inline-block",
          textShadow: "0 3px 10px rgba(0,0,0,0.45)",
        }}
      >
        {text}
      </span>
    </div>
  );
};

const BannerBody: React.FC<{ cue: OutputBanner; project: string }> = ({
  cue,
  project,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = frame / fps;

  // Slam in, hold, slam out. The bands travel in from off-frame edges.
  const enter = spring({ frame, fps, config: { damping: 11, mass: 0.5 }, durationInFrames: Math.round(fps * 0.45) });
  const exitStart = durationInFrames - Math.round(fps * 0.25);
  const exit = interpolate(frame, [exitStart, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const offset = (1 - enter) * 600 + exit * 600;

  // Square wave, so the colours snap rather than crossfade.
  const inverted = cue.flashHz > 0 && Math.floor(t * cue.flashHz * 2) % 2 === 1;
  // The wash pulses on the opposite phase of the bands — the frame brightens
  // between flashes the way a light bar sweeps past.
  const wash = cue.strobeOpacity * (inverted ? 1 : 0.25) * (1 - exit);

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: cue.bgColor, opacity: wash }} />
      <Band text={cue.topText} edge="top" cue={cue} inverted={inverted} offset={offset} />
      <Band text={cue.bottomText} edge="bottom" cue={cue} inverted={!inverted} offset={offset} />
      {cue.sfx && (
        <Audio src={staticFile(`${project}/${cue.sfx}`)} volume={cue.sfxVolume} />
      )}
    </AbsoluteFill>
  );
};

// One banner: appears at its remapped output time and holds to outEndS.
export const Banner: React.FC<{ cue: OutputBanner; project: string }> = ({
  cue,
  project,
}) => {
  const { fps } = useVideoConfig();
  const from = Math.round(cue.outStartS * fps);
  const durFrames = Math.max(1, Math.round((cue.outEndS - cue.outStartS) * fps));
  return (
    <Sequence from={from} durationInFrames={durFrames}>
      <BannerBody cue={cue} project={project} />
    </Sequence>
  );
};
