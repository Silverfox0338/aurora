import { analyzeV2 } from "./analyze-v2.ts";
import { V2_VERSION } from "./config.ts";
import { generateV2Chart } from "./generate-v2.ts";

/**
 * Aurora as a single object: `analyze` decoded PCM once, then `generateChart` as many times as
 * needed for different settings. Both steps are synchronous and deterministic.
 */
export const aurora = Object.freeze({
  id: "v2" as const,
  name: "Aurora",
  description:
    "Tempo-following beats, bar-aware sections, density matched to each part of the song, and stream, trill, and repeated-phrase lane patterns.",
  version: V2_VERSION,
  analyze: analyzeV2,
  generateChart: generateV2Chart,
});

export * from "./analyze-v2.ts";
export * from "./audio-prep.ts";
export * from "./audio.ts";
export * from "./beat-tracking.ts";
export * from "./chart.ts";
export * from "./config.ts";
export * from "./event-builder.ts";
export * from "./fft.ts";
export * from "./generate-v2.ts";
export * from "./gimmicks.ts";
export * from "./grid.ts";
export * from "./harmonic-percussive.ts";
export * from "./holds.ts";
export * from "./lane-planner.ts";
export * from "./metadata.ts";
export * from "./onset-detection.ts";
export * from "./pitch-tracking.ts";
export * from "./prng.ts";
export * from "./quality.ts";
export * from "./sections.ts";
export * from "./slides.ts";
export * from "./spectrum.ts";
export * from "./types.ts";
