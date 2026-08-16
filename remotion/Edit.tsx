import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  staticFile,
  useVideoConfig,
} from "remotion";
import type { RenderProps, Segment } from "../src/types";
import { Banner } from "./Banner";
import { Captions } from "./Captions";
import { Overlay } from "./Overlay";

// Scale/position one source video inside the composition frame. Wide: cover
// (sources are 16:9, so this is normally 1:1). Vertical: scale to full frame
// height and pan horizontally so cropXPct of the source sits at frame center.
const videoStyle = (
  seg: Segment,
  meta: { width: number; height: number } | undefined,
  compW: number,
  compH: number,
  defaultCropXPct: number
): React.CSSProperties => {
  const srcW = meta?.width ?? 1920;
  const srcH = meta?.height ?? 1080;
  const scale = Math.max(compW / srcW, compH / srcH);
  const scaledW = srcW * scale;
  const scaledH = srcH * scale;
  const cropXPct = seg.cropXPct ?? defaultCropXPct;
  // Put the crop center at the middle of the frame, clamped to the source.
  let left = compW / 2 - (cropXPct / 100) * scaledW;
  left = Math.min(0, Math.max(compW - scaledW, left));
  const top = (compH - scaledH) / 2;
  return {
    position: "absolute",
    width: scaledW,
    height: scaledH,
    left,
    top,
  };
};

export const Edit: React.FC<RenderProps> = (props) => {
  const { plan, project, outputWords, outputOverlays, outputBanners, clipMeta } = props;
  const { fps, width, height } = useVideoConfig();

  let cursor = 0;
  const placed = plan.segments.map((seg) => {
    const fromFrame = Math.round(cursor * fps);
    const durFrames = Math.max(1, Math.round((seg.outS - seg.inS) * fps));
    cursor += seg.outS - seg.inS;
    return { seg, fromFrame, durFrames };
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {placed.map(({ seg, fromFrame, durFrames }, i) => (
        <Sequence key={i} from={fromFrame} durationInFrames={durFrames}>
          <OffthreadVideo
            src={staticFile(`${project}/input/${seg.clip}`)}
            trimBefore={Math.round(seg.inS * fps)}
            trimAfter={Math.round(seg.outS * fps)}
            style={videoStyle(seg, clipMeta[seg.clip], width, height, plan.cropXPct)}
          />
        </Sequence>
      ))}

      {outputOverlays.map((cue) => (
        <Overlay key={cue.id} cue={cue} project={project} />
      ))}

      {plan.captions.enabled && (
        <Captions words={outputWords} config={plan.captions} />
      )}

      {/* Banners sit above the captions — they own the frame for their beat. */}
      {(outputBanners ?? []).map((cue) => (
        <Banner key={cue.id} cue={cue} project={project} />
      ))}
    </AbsoluteFill>
  );
};
