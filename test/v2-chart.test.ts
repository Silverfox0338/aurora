import { describe, expect, it } from "vitest";

import { buildMusicalEvents } from "../src/event-builder.ts";
import { planLanes } from "../src/lane-planner.ts";
import { repairHardConflicts, validateChartQuality } from "../src/quality.ts";
import type { BeatMarker, MusicalEvent, SongSection } from "../src/types.ts";
import { V2_VERSION } from "../src/config.ts";
import type { ChartSettings } from "../src/chart.ts";

const settings: ChartSettings = {
  algorithmVersion: V2_VERSION,
  density: 1,
  difficulty: "normal",
  laneCount: 5,
  laneStyle: "balanced",
};
const sections: SongSection[] = [
  {
    startMs: 0,
    endMs: 10_000,
    intensity: 0.8,
    onsetDensity: 2,
    harmonicDensity: 0.5,
    rhythmicDensity: 2,
    confidence: 1,
    label: "chorus",
  },
];
const beats: BeatMarker[] = Array.from({ length: 20 }, (_, index) => ({
  timeMs: index * 500,
  beatIndex: index,
  strength: 1,
  confidence: 0.9,
  ...(index % 4 === 0 ? { isDownbeat: true } : {}),
}));

function event(overrides: Partial<MusicalEvent> & Pick<MusicalEvent, "id" | "timeMs">): MusicalEvent {
  return {
    role: "percussive",
    strength: 0.9,
    confidence: 0.9,
    sourceBands: ["broadband"],
    evidence: ["spectral-flux", "beat-grid"],
    ...overrides,
  };
}

describe("V2 event and chart planning", () => {
  it("keeps musical evidence separate from lane choices", () => {
    const events = buildMusicalEvents(
      [{ timeMs: 500, strength: 1, confidence: 0.9, band: "bass" }],
      beats,
      [],
      [],
      sections,
    );
    expect(events[0]).toMatchObject({ role: "kick", evidence: expect.arrayContaining(["spectral-flux"]) });
    expect(events[0]).not.toHaveProperty("suggestedLane");
  });

  it("is seeded, phrase-aware, lane-safe, and creates playable chords", () => {
    const events = [
      event({ id: "kick", timeMs: 1000, role: "kick", sourceBands: ["bass"], pitchMidi: 60 }),
      event({ id: "melody", timeMs: 1000, role: "melody", sourceBands: ["harmonic"], pitchMidi: 67 }),
      event({ id: "up", timeMs: 1500, role: "melody", sourceBands: ["harmonic"], pitchMidi: 72 }),
      event({ id: "down", timeMs: 2000, role: "melody", sourceBands: ["harmonic"], pitchMidi: 64 }),
    ];
    const first = planLanes(events, beats, sections, settings, "seed");
    const second = planLanes(events, beats, sections, settings, "seed");
    expect(first).toEqual(second);
    const chord = first.notes.filter((note) => note.timeMs === 1000);
    expect(chord).toHaveLength(2);
    expect(new Set(chord.map((note) => note.lane)).size).toBe(2);
    expect(first.notes.every((note) => note.lane >= 0 && note.lane < settings.laneCount)).toBe(true);
  });

  it("uses sustained pitch evidence for holds but cuts at re-articulation", () => {
    const sustained = event({
      id: "sustain",
      timeMs: 1000,
      endTimeMs: 2200,
      role: "melody",
      sourceBands: ["harmonic"],
      pitchMidi: 69,
    });
    const plan = planLanes([sustained], beats, sections, settings, "hold-seed");
    // The sustain ends at 2200 ms; holds release on the normal-difficulty eighth grid (2000 ms).
    expect(plan.notes[0]).toMatchObject({ kind: "hold", durationMs: 1000 });
    const repeated = planLanes(
      [
        sustained,
        event({ id: "repeat", timeMs: 1450, role: "melody", sourceBands: ["harmonic"], pitchMidi: 69 }),
      ],
      beats,
      sections,
      settings,
      "hold-seed",
    );
    expect(repeated.notes[0]!.kind).toBe("tap");
  });

  it("shapes clustered detections into a playable musical stream", () => {
    const clustered = [
      event({ id: "attack", timeMs: 1000, strength: 1 }),
      event({ id: "echo-1", timeMs: 1080, strength: 0.82 }),
      event({ id: "echo-2", timeMs: 1160, strength: 0.74 }),
      event({ id: "next-beat", timeMs: 1500, strength: 0.9 }),
    ];
    const plan = planLanes(clustered, beats, sections, settings, "flow-seed");
    const distinctMoments = [...new Set(plan.notes.map((note) => note.timeMs))];
    expect(distinctMoments).toHaveLength(2);
    // The echoes sit between eighth-grid points, which normal difficulty does not ask players to read.
    expect(plan.removed.filter((item) => item.reason === "off-grid")).toHaveLength(2);
  });

  it("snaps rhythmic attacks to an adaptive subdivision even when detector confidence is modest", () => {
    const slowBeats: BeatMarker[] = Array.from({ length: 8 }, (_, index) => ({
      timeMs: index * 750,
      beatIndex: index,
      strength: 0.8,
      confidence: 0.7,
    }));
    const plan = planLanes(
      [event({ id: "near-sixteenth", timeMs: 1190, role: "kick", rhythmicConfidence: 0.2 })],
      slowBeats,
      sections,
      settings,
      "grid-seed",
    );
    expect(plan.notes[0]!.timeMs).toBe(1125);
  });

  it("reserves normal-difficulty chords for clear musical accents", () => {
    const plan = planLanes(
      [
        event({ id: "soft-kick", timeMs: 1000, role: "kick", strength: 0.45, confidence: 0.5 }),
        event({ id: "soft-hat", timeMs: 1000, role: "hat", strength: 0.45, confidence: 0.5 }),
      ],
      beats,
      sections,
      settings,
      "chord-shape-seed",
    );
    expect(plan.notes).toHaveLength(1);
    expect(plan.reducedChords).toBe(1);
  });

  it("spreads recurring rhythm roles across both hands", () => {
    const rhythm = Array.from({ length: 24 }, (_, index) =>
      event({
        id: `rhythm-${index}`,
        timeMs: 250 + index * 375,
        role: index % 3 === 0 ? "kick" : index % 3 === 1 ? "snare" : "hat",
      }),
    );
    const plan = planLanes(rhythm, beats, sections, settings, "hand-balance-seed");
    const left = plan.notes.filter((note) => note.lane < 2).length;
    const right = plan.notes.filter((note) => note.lane > 2).length;
    expect(Math.abs(left - right)).toBeLessThan(plan.notes.length * 0.35);
  });

  it("repairs hold conflicts and reports quality metrics", () => {
    const repaired = repairHardConflicts(
      [
        { id: "h", kind: "hold", timeMs: 1000, lane: 1, durationMs: 1000, strength: 1 },
        { id: "t", kind: "tap", timeMs: 1500, lane: 1, strength: 1 },
      ],
      4,
    );
    expect(repaired).toHaveLength(1);
    const report = validateChartQuality(repaired, 5000, 4, beats, []);
    expect(report.playabilityScore).toBeGreaterThan(90);
    expect(report.averageNotesPerSecond).toBeCloseTo(0.2, 4);
  });
});
