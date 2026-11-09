import { analyzeAudio } from "./analyze.ts";
import { AURORA_VERSION } from "./config.ts";
import { generateChart } from "./generate.ts";

/**
 * Aurora as a single object: `analyze` decoded PCM once, then `generateChart` as many times as
 * needed for different settings. Both steps are synchronous and deterministic.
 */
export const aurora = Object.freeze({
  id: "aurora" as const,
  name: "Aurora",
  description:
    "Tempo-following beats, bar-aware sections, density matched to each part of the song, and stream, trill, and repeated-phrase lane patterns.",
  version: AURORA_VERSION,
  analyze: analyzeAudio,
  generateChart: generateChart,
});

export * from "./analyze.ts";
export * from "./audio-prep.ts";
export * from "./audio.ts";
export * from "./beat-tracking.ts";
export * from "./chart.ts";
export * from "./config.ts";
export * from "./event-builder.ts";
export * from "./fft.ts";
export * from "./generate.ts";
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
