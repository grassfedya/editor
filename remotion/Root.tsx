import React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { Edit } from "./Edit";
import type { RenderProps } from "../src/types";

const emptyProps: RenderProps = {
  project: "",
  plan: {
    baseSegments: [],
    segments: [],
    autoCuts: [],
    tighten: {
      enabled: true,
      minGapS: 0.8,
      targetGapS: 0.25,
      padS: 0.08,
      silence: { enabled: true, noiseDb: -35, minDurS: 1.0 },
    },
    overlays: [],
    banners: [],
    captions: {
      enabled: true,
      textColor: "#ffffff",
      highlightColor: "#ffd60a",
      fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif",
    },
    cropXPct: 50,
    fps: 30,
  },
  outputWords: [],
  outputOverlays: [],
  outputBanners: [],
  clipMeta: {},
};

const calculateMetadata: CalculateMetadataFunction<RenderProps> = ({ props }) => {
  const totalS = props.plan.segments.reduce((n, s) => n + (s.outS - s.inS), 0);
  return {
    fps: props.plan.fps,
    durationInFrames: Math.max(1, Math.round(totalS * props.plan.fps)),
  };
};

export const Root: React.FC = () => (
  <>
    <Composition
      id="Wide"
      component={Edit}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={1}
      defaultProps={emptyProps}
      calculateMetadata={calculateMetadata}
    />
    <Composition
      id="Vertical"
      component={Edit}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={1}
      defaultProps={emptyProps}
      calculateMetadata={calculateMetadata}
    />
  </>
);
