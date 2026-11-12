import type { Difficulty } from "./chart.ts";

export const AURORA_VERSION = "aurora-v3.0.0";

export const AURORA_FEATURE_FLAGS = Object.freeze({
  hpssApproximation: true,
  slides: false,
  advancedDownbeats: true,
  /** Track beats on the learned beat activation and label bars from the learned downbeat activation. */
  learnedBeats: true,
  tempoMap: true,
});

const SAMPLE_RATE = 22_050;
const FRAME_SIZE = 2048;

export const AURORA_CONFIG = Object.freeze({
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
    tightness: 300,
    /** Log2-Gaussian tempo prior centred on 120 BPM. */
    priorCenterBpm: 120,
    priorOctaveWidth: 0.9,
    /**
     * Downbeat decoding (`advancedDownbeats`): weights for chord change, kick and snare evidence,
     * and the cost of re-syncing the bar position where the beat tracker slipped a beat.
     */
    downbeat: Object.freeze({
      chord: 1,
      kick: 0.6,
      snare: 0.6,
      resync: 8,
    }),
    /** With `learnedBeats`: re-sync cost when bar positions come from the learned downbeat activation. */
    learnedDownbeatResync: 4,
    /** With `learnedBeats`: share of the learned beat activation in the beat tracker's input. */
    learnedBeatWeight: 0.6,
  }),
  holds: Object.freeze({
    minimumDurationMs: 420,
    /**
     * Hard/Extreme short holds: a pitched sustain this long (and at least `shortMinimumBeats` of a
     * beat) may become a hold even though it is below `minimumDurationMs`. Hand-made rhythm-game
     * charts put about half their holds on these half-beat sustains.
     */
    shortMinimumMs: 180,
    shortMinimumBeats: 0.6,
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

export type AuroraAnalysisConfig = typeof AURORA_CONFIG;

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
  /** Chords below this group strength collapse to a single note (Easy/Normal). */
  chordStrength: number;
  /** Hard/Extreme: share of moments that become chords, picked by rhythmic weight. */
  chordShare: number;
  /** Hard/Extreme: share of moments (strongest downbeats) that become three-note chords. */
  tripleChordShare: number;
  /** Share of moments that may carry a short hold (below `holds.minimumDurationMs`); 0 disables. */
  shortHoldShare: number;
  /** Repeated-pitch jacks are allowed when their spacing reaches this multiple of the lane gap. */
  jackGapMultiplier: number | null;
}>;

export const AURORA_DIFFICULTY: Readonly<Record<Difficulty, DifficultyProfile>> = Object.freeze({
  easy: {
    notesPerSecond: [1.1, 2.3],
    peakNotesPerSecond: 4,
    subdivision: { fast: 1, slow: 2, slowBeatMs: 650 },
    holdSubdivision: 1,
    movementWeight: 0.95,
    travelMsPerLane: 160,
    chordStrength: Infinity,
    chordShare: 0,
    tripleChordShare: 0,
    shortHoldShare: 0,
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
    chordShare: 0,
    tripleChordShare: 0,
    shortHoldShare: 0,
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
    chordShare: 0.28,
    tripleChordShare: 0.03,
    shortHoldShare: 0.1,
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
    chordShare: 0.38,
    tripleChordShare: 0.05,
    shortHoldShare: 0.05,
    jackGapMultiplier: 1.4,
  },
});

/** Hard and Extreme keep off-grid attacks and may draw jacks. */
export function isAdvancedDifficulty(difficulty: Difficulty): boolean {
  return difficulty === "hard" || difficulty === "extreme";
}
