import type { Difficulty } from "./chart.ts";

export const V2_VERSION = "aurora-v3.0.0";

export const V2_FEATURE_FLAGS = Object.freeze({
  hpssApproximation: true,
  slides: false,
  advancedDownbeats: true,
  tempoMap: true,
});

const SAMPLE_RATE = 22_050;
const FRAME_SIZE = 2048;

export const V2_CONFIG = Object.freeze({
  sampleRate: SAMPLE_RATE,
  frameSize: FRAME_SIZE,
  hopSize: 256,
  /**
   * Log spectral flux peaks when an attack sits ~71% of the way into a Hann window, so
   * frame-start timestamps read early. Measured against synthetic clicks, kicks, and plucks.
   */
  onsetLatencyMs: ((FRAME_SIZE * 0.71) / SAMPLE_RATE) * 1000,
  onset: Object.freeze({ localWindowFrames: 24, thresholdMultiplier: 1.5, minimumGapMs: 65 }),
  /** Detector hits from different bands within this window describe one musical attack. */
  onsetMergeWindowMs: 35,
  pitch: Object.freeze({
    minimumHz: 65,
    maximumHz: 1_200,
    confidenceThreshold: 0.18,
    continuityPenalty: 0.22,
  }),
  beat: Object.freeze({
    minimumBpm: 60,
    maximumBpm: 200,
    allowedSubdivisions: [1, 2, 3, 4] as const,
    /** Ellis-style DP transition tightness; larger values hold tempo more rigidly. */
    tightness: 120,
    /** Log2-Gaussian tempo prior centred on 120 BPM. */
    priorCenterBpm: 120,
    priorOctaveWidth: 0.9,
  }),
  holds: Object.freeze({
    minimumDurationMs: 420,
    /**
     * Measured against the recent median pitch, so vibrato stays inside one note. Below a
     * semitone (100 cents) so a step to the neighbouring note starts a new one.
     */
    pitchToleranceCents: 70,
    /**
     * Pitch points (sampled every second hop, ≈23 ms) a sustained note may drop before it is
     * split. Real mixes lose a held vocal for 100–150 ms at a time; a genuine repeat of the same
     * pitch is still split by its re-attack in `sustainedHoldDuration`.
     */
    maximumDroppedPoints: 7,
    /**
     * Spectral sustain, on the drum-free chroma of the note's own pitch class: it must keep this
     * much of its post-attack energy (0.25 ≈ −12 dB), keep this fraction of its share of all
     * tonal energy, and start with at least `sustainMinimumShare` of it.
     */
    sustainEnergyRatio: 0.25,
    sustainShareRatio: 0.5,
    sustainMinimumShare: 0.15,
    /** Consecutive failing frames tolerated before a spectral sustain ends. */
    sustainMissFrames: 3,
  }),
  sections: Object.freeze({
    windowMs: 8_000,
    noveltyKernelBars: 4,
    minimumBars: 4,
    maximumBars: 16,
  }),
});

export type V2AnalysisConfig = typeof V2_CONFIG;

export type DifficultyProfile = Readonly<{
  /** Notes per second at section intensity 0 and 1 before the density multiplier. */
  notesPerSecond: readonly [number, number];
  /** Hard ceiling on notes inside any one-second window, after the density multiplier. */
  peakNotesPerSecond: number;
  /** Finest grid division per beat when the beat interval is short / long. */
  subdivision: Readonly<{ fast: number; slow: number; slowBeatMs: number }>;
  /** Finest grid used to place hold ends, in divisions per beat. */
  holdSubdivision: number;
  /** Lane travel penalty; easy charts should drift, hard charts may jump. */
  movementWeight: number;
  /** Milliseconds of elapsed time that make one lane of travel comfortable. */
  travelMsPerLane: number;
  /** Chords below this group strength collapse to a single note. */
  chordStrength: number;
  /** Repeated-pitch jacks are allowed when their spacing reaches this multiple of the lane gap. */
  jackGapMultiplier: number | null;
}>;

export const V2_DIFFICULTY: Readonly<Record<Difficulty, DifficultyProfile>> = Object.freeze({
  easy: {
    notesPerSecond: [1.1, 2.3],
    peakNotesPerSecond: 4,
    subdivision: { fast: 1, slow: 2, slowBeatMs: 650 },
    holdSubdivision: 1,
    movementWeight: 0.95,
    travelMsPerLane: 160,
    chordStrength: Infinity,
    jackGapMultiplier: null,
  },
  normal: {
    notesPerSecond: [2, 3.9],
    peakNotesPerSecond: 7,
    subdivision: { fast: 2, slow: 4, slowBeatMs: 720 },
    holdSubdivision: 2,
    movementWeight: 0.55,
    travelMsPerLane: 125,
    chordStrength: 0.6,
    jackGapMultiplier: null,
  },
  hard: {
    notesPerSecond: [3.3, 6.2],
    peakNotesPerSecond: 10,
    subdivision: { fast: 4, slow: 4, slowBeatMs: 0 },
    holdSubdivision: 4,
    movementWeight: 0.38,
    travelMsPerLane: 90,
    chordStrength: 0.52,
    jackGapMultiplier: 1.6,
  },
  extreme: {
    notesPerSecond: [4.4, 8.2],
    peakNotesPerSecond: 14,
    subdivision: { fast: 4, slow: 4, slowBeatMs: 0 },
    holdSubdivision: 4,
    movementWeight: 0.3,
    travelMsPerLane: 80,
    chordStrength: 0.45,
    jackGapMultiplier: 1.4,
  },
});

/** Hard and Extreme keep off-grid attacks and may draw jacks. */
export function isAdvancedDifficulty(difficulty: Difficulty): boolean {
  return difficulty === "hard" || difficulty === "extreme";
}
