import type { ChartNote } from "./chart.ts";

export type FrequencyBand = "sub" | "bass" | "lowMid" | "mid" | "upperMid" | "high";

export type SpectralFrame = Readonly<{
  timeMs: number;
  totalEnergy: number;
  spectralCentroidHz: number;
  spectralFlux: number;
  harmonicity: number;
  bandEnergy: Readonly<Record<FrequencyBand, number>>;
}>;

export type OnsetBand = "bass" | "mid" | "high" | "broadband";
export type OnsetEvent = Readonly<{
  timeMs: number;
  strength: number;
  confidence: number;
  band: OnsetBand;
}>;

export type BeatMarker = Readonly<{
  timeMs: number;
  beatIndex: number;
  strength: number;
  confidence: number;
  isDownbeat?: boolean;
  /** Zero-based position inside the bar; 0 is the downbeat. */
  beatInBar?: number;
  barIndex?: number;
}>;

export type PitchPoint = Readonly<{
  timeMs: number;
  frequencyHz: number;
  midi: number;
  confidence: number;
  salience: number;
}>;

export type MelodyNote = Readonly<{
  startMs: number;
  endMs: number;
  midiPitch: number;
  confidence: number;
  attackStrength: number;
}>;

export type MusicalEventRole =
  "kick" | "snare" | "hat" | "bass" | "melody" | "chord" | "vocal" | "harmonic" | "percussive" | "unknown";

export type MusicalEvent = Readonly<{
  id: string;
  timeMs: number;
  endTimeMs?: number;
  role: MusicalEventRole;
  strength: number;
  confidence: number;
  pitchMidi?: number;
  pitchConfidence?: number;
  beatIndex?: number;
  beatSubdivision?: number;
  rhythmicConfidence?: number;
  sourceBands: readonly string[];
  evidence: readonly string[];
}>;

export type SongSection = Readonly<{
  startMs: number;
  endMs: number;
  intensity: number;
  onsetDensity: number;
  harmonicDensity: number;
  rhythmicDensity: number;
  confidence: number;
  label?: SectionLabel;
  /** Whether off-beat attacks in this section fit a straight (1/4) or triplet/swing (1/3) grid. */
  feel?: "straight" | "triplet";
}>;

export type SectionLabel = "intro" | "verse" | "build" | "chorus" | "break" | "drop" | "outro" | "unknown";

export type ChartQualityWarning = Readonly<{
  code: string;
  message: string;
  timeMs?: number;
}>;

export type ChartQualityReport = Readonly<{
  playabilityScore: number;
  musicalityScore: number;
  varietyScore: number;
  confidenceScore: number;
  averageNotesPerSecond: number;
  peakNotesPerSecond: number;
  handBalance: number;
  beatAlignmentRatio: number;
  warnings: readonly ChartQualityWarning[];
}>;

export type V2DebugExport = Readonly<{
  metadata: Readonly<{
    algorithmVersion: string;
    durationMs: number;
    sampleRate: number;
    frameSize: number;
    hopSize: number;
    hpssMode: "spectral-persistence-approximation";
    onsetLatencyMs?: number;
  }>;
  waveform: readonly number[];
  spectralEnergy: readonly number[];
  onsetEnvelope: readonly number[];
  onsets: readonly OnsetEvent[];
  beats: readonly BeatMarker[];
  pitchTrack: readonly PitchPoint[];
  sections: readonly SongSection[];
  events: readonly MusicalEvent[];
  generatedNotes?: readonly ChartNote[];
  qualityReport?: ChartQualityReport;
  removedCandidates: readonly Readonly<{ eventId: string; reason: string }>[];
}>;

export type V2Analysis = Readonly<{
  kind: "v2-analysis";
  durationMs: number;
  sourceSampleRate: number;
  analysisSampleRate: number;
  estimatedBpm: number | null;
  tempoConfidence: number;
  /** Beats per bar inferred from accent periodicity (3 or 4). */
  meter?: number;
  spectralFrames: readonly SpectralFrame[];
  onsets: readonly OnsetEvent[];
  beats: readonly BeatMarker[];
  pitchTrack: readonly PitchPoint[];
  melody: readonly MelodyNote[];
  sections: readonly SongSection[];
  events: readonly MusicalEvent[];
  stageDurationsMs: Readonly<Record<string, number>>;
  hpssConfidence: number;
  debug?: V2DebugExport;
}>;

export function isV2Analysis(value: unknown): value is V2Analysis {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "v2-analysis";
}
