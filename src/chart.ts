export const DIFFICULTIES = ["easy", "normal", "hard", "extreme"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export const LANE_STYLES = ["balanced", "frequency", "alternating"] as const;
export type LaneStyle = (typeof LANE_STYLES)[number];

/** `Id` lets a host app narrow algorithm ids to the set it knows about. */
export type ChartGeneratorMetadata<Id extends string = string> = Readonly<{
  algorithmId: Id;
  algorithmVersion: string;
  seed: string;
  requestedAlgorithm?: Id;
  actualAlgorithm?: Id;
  fallbackReason?: string;
}>;

export type ChartSettings = Readonly<{
  difficulty: Difficulty;
  laneCount: number;
  laneStyle: LaneStyle;
  density: number;
  algorithmVersion: string;
}>;

export type TapNote = Readonly<{
  id: string;
  kind: "tap";
  timeMs: number;
  lane: number;
  strength: number;
}>;

export type HoldNote = Readonly<{
  id: string;
  kind: "hold";
  timeMs: number;
  lane: number;
  durationMs: number;
  strength: number;
}>;

export type ChartNote = TapNote | HoldNote;

export const GIMMICK_KINDS = ["flip", "hidden", "shuffle"] as const;
export type GimmickKind = (typeof GIMMICK_KINDS)[number];

/**
 * A timed visual effect on Extreme charts. Gimmicks change only how the highway is drawn,
 * never when notes must be hit, so scoring and server replay ignore them.
 */
export type ChartGimmick =
  | Readonly<{ id: string; kind: "flip"; startMs: number; endMs: number }>
  /** Notes fade out once they have travelled `fadeFromMilli`/1000 of the way to the receptor. */
  | Readonly<{ id: string; kind: "hidden"; startMs: number; endMs: number; fadeFromMilli: number }>
  /** `order[lane]` is the on-screen column that lane is drawn in. */
  | Readonly<{ id: string; kind: "shuffle"; startMs: number; endMs: number; order: readonly number[] }>;

export type TempoMetadata = Readonly<{
  bpmMilli: number | null;
  confidenceBasisPoints: number;
  halfTimeBpmMilli: number | null;
  doubleTimeBpmMilli: number | null;
}>;

export type PlayabilityDiagnostics = Readonly<{
  candidates: number;
  accepted: number;
  removedForGap: number;
  movedForConflict: number;
  reducedChords: number;
}>;

export type ChartQualityMetadata = Readonly<{
  playabilityScore: number;
  musicalityScore: number;
  varietyScore: number;
  confidenceScore: number;
  averageNotesPerSecond: number;
  peakNotesPerSecond: number;
  handBalance: number;
  beatAlignmentRatio: number;
  warnings: readonly Readonly<{ code: string; message: string; timeMs?: number }>[];
  /** Fraction of notes drawn as streams, trills, jacks, or free placement (Aurora 2.3+). */
  patternShares?: Readonly<Record<string, number>>;
  /** Bars whose lane pattern was reused from an earlier identical musical bar. */
  repeatedBars?: number;
}>;

export type ChartDefinition<Id extends string = string> = Readonly<{
  audioFingerprint: string;
  durationMs: number;
  settings: ChartSettings;
  tempo: TempoMetadata;
  notes: readonly ChartNote[];
  /** Extreme only; absent on every other chart so their hashes are unchanged. */
  gimmicks?: readonly ChartGimmick[];
  diagnostics: PlayabilityDiagnostics;
  quality?: ChartQualityMetadata;
  /** Optional so charts created before algorithm metadata was introduced remain loadable. */
  generator?: ChartGeneratorMetadata<Id>;
}>;

export const DIFFICULTY_RULES: Record<
  Difficulty,
  Readonly<{
    minimumGapMs: number;
    maximumChordSize: number;
    candidatePercentile: number;
    defaultLaneCount: number;
    holdFrequencyCap: number;
  }>
> = {
  easy: {
    minimumGapMs: 240,
    maximumChordSize: 1,
    candidatePercentile: 0.7,
    defaultLaneCount: 4,
    holdFrequencyCap: 0.06,
  },
  normal: {
    minimumGapMs: 145,
    maximumChordSize: 2,
    candidatePercentile: 0.46,
    defaultLaneCount: 5,
    holdFrequencyCap: 0.14,
  },
  hard: {
    minimumGapMs: 92,
    maximumChordSize: 3,
    candidatePercentile: 0.24,
    defaultLaneCount: 6,
    holdFrequencyCap: 0.22,
  },
  extreme: {
    minimumGapMs: 75,
    maximumChordSize: 3,
    candidatePercentile: 0.15,
    defaultLaneCount: 7,
    holdFrequencyCap: 0.25,
  },
};

export const MIN_HOLD_DURATION_MS = 350;
export const MAX_HOLD_DURATION_MS = 4000;
