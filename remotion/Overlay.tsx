import React from "react";
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { OverlayCue } from "../src/types";

type OutputCue = OverlayCue & { outStartS: number; outEndS: number };

// Hard cut in and out — the image is simply there for its hold, no spring,
// no fade, no border.
const Popup: React.FC<{ cue: OutputCue; src: string }> = ({ cue, src }) => {
  const { width, height } = useVideoConfig();

  const w = (cue.widthPct / 100) * width;
  return (
    <Img
      src={src}
      style={{
        position: "absolute",
        width: w,
        left: (cue.xPct / 100) * width - w / 2,
        top: (cue.yPct / 100) * height,
        transform: "translateY(-50%)",
        borderRadius: 24,
        boxShadow: "0 12px 48px rgba(0,0,0,0.55)",
      }}
    />
  );
};

const Fullscreen: React.FC<{ cue: OutputCue; src: string }> = ({ cue, src }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const durFrames = Math.round((cue.outEndS - cue.outStartS) * fps);

  // Subtle push-in so the cutaway doesn't read as a freeze. The cut itself is
  // hard at both ends — no fade.
  const zoom = interpolate(frame, [0, durFrames], [1.0, 1.06]);

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <Img
        src={src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${zoom})`,
        }}
      />
    </AbsoluteFill>
  );
};

// One overlay cue: enters at its remapped output time (leadS already applied
// upstream), holds for holdS. Audio from the underlying edit continues.
export const Overlay: React.FC<{ cue: OutputCue; project: string }> = ({
  cue,
  project,
}) => {
  const { fps } = useVideoConfig();
  if (!cue.resolvedFile) return null; // not fetched yet — render nothing
  const src = staticFile(`${project}/${cue.resolvedFile}`);
  const from = Math.round(cue.outStartS * fps);
  const durFrames = Math.max(1, Math.round((cue.outEndS - cue.outStartS) * fps));
  return (
    <Sequence from={from} durationInFrames={durFrames}>
      {cue.style === "popup" ? (
        <Popup cue={cue} src={src} />
      ) : (
        <Fullscreen cue={cue} src={src} />
      )}
    </Sequence>
  );
};
