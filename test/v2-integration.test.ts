import { describe, expect, it } from "vitest";

import { analyzeV2 } from "../src/analyze-v2.ts";
import { V2_VERSION } from "../src/config.ts";
import { generateV2Chart } from "../src/generate-v2.ts";

const settings = {
  algorithmVersion: V2_VERSION,
  density: 1,
  difficulty: "normal" as const,
  laneCount: 5,
  laneStyle: "balanced" as const,
};

describe("V2 synthetic audio integration", () => {
  it("does not invent events or notes for silence", () => {
    const analysis = analyzeV2({ channels: [new Float32Array(22_050 * 2)], sampleRate: 22_050 });
    const chart = generateV2Chart("0".repeat(64), analysis, settings);
    expect(analysis.onsets).toEqual([]);
    expect(analysis.pitchTrack).toEqual([]);
    expect(chart.notes).toEqual([]);
  });

  it("tracks a sustained 440 Hz tone near MIDI 69 deterministically", () => {
    const sampleRate = 22_050;
    const samples = Float32Array.from(
      { length: sampleRate * 2 },
      (_, index) => Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.4,
    );
    const first = analyzeV2({ channels: [samples], sampleRate });
    const second = analyzeV2({ channels: [samples], sampleRate });
    expect(first.pitchTrack.length).toBeGreaterThan(10);
    expect(first.pitchTrack[0]!.midi).toBeCloseTo(69, 0);
    const { stageDurationsMs: firstTimings, ...firstStable } = first;
    const { stageDurationsMs: secondTimings, ...secondStable } = second;
    expect(firstTimings["spectral-analysis"]).toBeGreaterThanOrEqual(0);
    expect(secondTimings["spectral-analysis"]).toBeGreaterThanOrEqual(0);
    expect(firstStable).toEqual(secondStable);
    const firstChart = generateV2Chart("4".repeat(64), first, settings);
    const secondChart = generateV2Chart("4".repeat(64), second, settings);
    expect(firstChart).toEqual(secondChart);
    expect(firstChart.generator).toMatchObject({ algorithmId: "v2", algorithmVersion: V2_VERSION });
  });

  it("honors a pre-aborted analysis request", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      analyzeV2({ channels: [new Float32Array(2048)], sampleRate: 22_050 }, { signal: controller.signal }),
    ).toThrow(/cancelled/i);
  });
});
