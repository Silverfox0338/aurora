import { describe, expect, it } from "vitest";

import { analyzeAudio } from "../src/analyze.ts";
import { AURORA_VERSION } from "../src/config.ts";
import { generateChart } from "../src/generate.ts";

import { heldMelodyMix } from "./synth.ts";

describe.each([
  { label: "a lead over drums", accompaniment: false },
  { label: "a lead over drums, pad chords and bass", accompaniment: true },
])("hold notes: $label", ({ accompaniment }) => {
  const { audio, notes, beatSec } = heldMelodyMix(accompaniment);
  const analysis = analyzeAudio({ channels: [audio], sampleRate: 22_050 });
  const chart = generateChart("h".repeat(64), analysis, {
    algorithmVersion: AURORA_VERSION,
    density: 1,
    difficulty: "hard",
    laneCount: 6,
    laneStyle: "balanced",
  });
  const holds = chart.notes.filter((note) => note.kind === "hold");
  // The detector's onset latency shifts every time equally; measure it from the notes themselves.
  const holdFor = (startSec: number) =>
    holds.find((hold) => Math.abs(hold.timeMs - startSec * 1000) <= 90);

  it("puts a hold on every note of two beats or longer", () => {
    const long = notes.filter((note) => note.durationSec >= 2 * beatSec - 0.1);
    const found = long.filter((note) => holdFor(note.startSec));
    expect(found.length / long.length).toBeGreaterThanOrEqual(0.85);
  }, 60_000);

  it("ends holds within a quarter beat of where the note stops", () => {
    const long = notes.filter((note) => note.durationSec >= 2 * beatSec - 0.1);
    const errors = long.flatMap((note) => {
      const hold = holdFor(note.startSec);
      if (!hold || hold.kind !== "hold") return [];
      return [Math.abs(hold.timeMs + hold.durationMs - (note.startSec + note.durationSec) * 1000)];
    });
    expect(errors.length).toBeGreaterThan(0);
    const withinQuarterBeat = errors.filter((error) => error <= beatSec * 250).length / errors.length;
    expect(withinQuarterBeat).toBeGreaterThanOrEqual(0.8);
  }, 60_000);

  it("does not turn quick notes into holds", () => {
    const quick = notes.filter((note) => note.durationSec <= 0.5 * beatSec);
    const wrongly = quick.filter((note) => holdFor(note.startSec));
    expect(wrongly.length).toBeLessThanOrEqual(1);
  }, 60_000);
});
