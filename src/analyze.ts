import type { AnalysisContext, DecodedAudio } from "./audio.ts";
import { throwIfAborted } from "./audio.ts";

import { prepareAnalysisChannels } from "./audio-prep.ts";
import { trackBeats } from "./beat-tracking.ts";
import { AURORA_CONFIG, AURORA_VERSION } from "./config.ts";
import { buildMusicalEvents } from "./event-builder.ts";
import { detectOnsets } from "./onset-detection.ts";
import { buildMelodySegments, stabilizePitchTrack } from "./pitch-tracking.ts";
import { analyzeSections } from "./sections.ts";
import { analyzeSpectrum } from "./spectrum.ts";
import type { AuroraAnalysis, AuroraDebugExport } from "./types.ts";

function clock(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function analyzeAudio(audio: DecodedAudio, context: AnalysisContext = {}): AuroraAnalysis {
  const report = context.report ?? (() => undefined);
  const stageDurationsMs: Record<string, number> = {};
  const timed = <T>(stage: string, task: () => T): T => {
    const start = clock();
    const result = task();
    stageDurationsMs[stage] = Math.round((clock() - start) * 100) / 100;
    return result;
  };
  const durationMs = Math.round(((audio.channels[0]?.length ?? 0) / audio.sampleRate) * 1000);
  throwIfAborted(context.signal);
  report({ stage: "Resampling audio", progress: 0.12 });
  const channels = timed("resampling", () =>
    prepareAnalysisChannels(audio.channels, audio.sampleRate, AURORA_CONFIG.sampleRate, context.signal),
  );
  report({ stage: "Building spectrum", progress: 0.24 });
  const spectrum = timed("spectral-analysis", () =>
    analyzeSpectrum(
      channels.mono,
      AURORA_CONFIG.sampleRate,
      AURORA_CONFIG.frameSize,
      AURORA_CONFIG.hopSize,
      AURORA_CONFIG.pitch,
      context.signal,
      AURORA_CONFIG.onsetLatencyMs,
    ),
  );
  throwIfAborted(context.signal);
  report({ stage: "Detecting rhythm", progress: 0.48 });
  const onsets = timed("onset-detection", () =>
    detectOnsets(spectrum.envelopes, AURORA_CONFIG.sampleRate, AURORA_CONFIG.hopSize, {
      ...AURORA_CONFIG.onset,
      timeOffsetMs: AURORA_CONFIG.onsetLatencyMs,
    }),
  );
  report({ stage: "Tracking the beat", progress: 0.6 });
  const beatAnalysis = timed("beat-tracking", () =>
    trackBeats(
      spectrum.envelopes.percussive,
      onsets,
      durationMs,
      AURORA_CONFIG.sampleRate,
      AURORA_CONFIG.hopSize,
      AURORA_CONFIG.beat.minimumBpm,
      AURORA_CONFIG.beat.maximumBpm,
      {
        timeOffsetMs: AURORA_CONFIG.onsetLatencyMs,
        bassEnvelope: spectrum.envelopes.bass,
        harmonicEnvelope: spectrum.envelopes.harmonic,
        midEnvelope: spectrum.envelopes.midrange,
        broadbandEnvelope: spectrum.envelopes.broadband,
        harmonicChroma: spectrum.harmonicChroma,
      },
    ),
  );
  throwIfAborted(context.signal);
  report({ stage: "Following the melody", progress: 0.72 });
  const pitchTrack = timed("pitch-tracking", () =>
    stabilizePitchTrack(
      spectrum.rawPitch,
      AURORA_CONFIG.pitch.confidenceThreshold,
      AURORA_CONFIG.pitch.continuityPenalty,
    ),
  );
  // Pitch is sampled every second hop. Real mixes drop several voiced points inside one sung
  // or bowed note, so bridge short dropouts but only let the note ring one point past the last.
  const pitchStepMs = (AURORA_CONFIG.hopSize * 2 * 1000) / AURORA_CONFIG.sampleRate;
  const melody = buildMelodySegments(
    pitchTrack,
    pitchStepMs * (AURORA_CONFIG.holds.maximumDroppedPoints + 1.5),
    AURORA_CONFIG.holds.pitchToleranceCents,
    pitchStepMs * 2.5,
  );
  report({ stage: "Building musical events", progress: 0.86 });
  const sections = timed("section-analysis", () =>
    analyzeSections(
      durationMs,
      spectrum.frames,
      onsets,
      beatAnalysis.beats,
      AURORA_CONFIG.sections.windowMs,
      spectrum.chroma,
    ),
  );
  const events = timed("event-building", () =>
    buildMusicalEvents(onsets, beatAnalysis.beats, pitchTrack, melody, sections, {
      frames: spectrum.frames,
      harmonicChroma: spectrum.harmonicChroma,
    }),
  );
  const hpssConfidence =
    spectrum.frames.length > 0
      ? spectrum.frames.reduce((sum, frame) => sum + Math.abs(frame.harmonicity - 0.5) * 2, 0) /
        spectrum.frames.length
      : 0;
  let debug: AuroraDebugExport | undefined;
  if (context.debug) {
    const sampleStep = Math.max(1, Math.floor(channels.mono.length / 1200));
    const frameStep = Math.max(1, Math.floor(spectrum.envelopes.broadband.length / 1200));
    debug = {
      metadata: {
        algorithmVersion: AURORA_VERSION,
        durationMs,
        sampleRate: AURORA_CONFIG.sampleRate,
        frameSize: AURORA_CONFIG.frameSize,
        hopSize: AURORA_CONFIG.hopSize,
        hpssMode: "median-filter",
        onsetLatencyMs: AURORA_CONFIG.onsetLatencyMs,
      },
      waveform: Array.from(
        { length: Math.min(1200, Math.ceil(channels.mono.length / sampleStep)) },
        (_, index) => channels.mono[index * sampleStep] ?? 0,
      ),
      spectralEnergy: spectrum.frames
        .filter((_, index) => index % frameStep === 0)
        .slice(0, 1200)
        .map((frame) => frame.totalEnergy),
      onsetEnvelope: Array.from(
        spectrum.envelopes.broadband.filter((_, index) => index % frameStep === 0).slice(0, 1200),
      ),
      onsets,
      beats: beatAnalysis.beats,
      pitchTrack,
      sections,
      events,
      removedCandidates: [],
    };
  }
  report({ stage: "Musical analysis complete", progress: 0.92 });
  return Object.freeze({
    kind: "aurora-analysis",
    durationMs,
    sourceSampleRate: audio.sampleRate,
    analysisSampleRate: AURORA_CONFIG.sampleRate,
    estimatedBpm: beatAnalysis.bpm,
    tempoConfidence: beatAnalysis.confidence,
    tempoAlternatives: beatAnalysis.alternatives,
    tempoMap: beatAnalysis.tempoMap,
    meter: beatAnalysis.meter,
    spectralFrames: spectrum.frames,
    onsets,
    beats: beatAnalysis.beats,
    pitchTrack,
    melody,
    sections,
    events,
    stageDurationsMs: Object.freeze(stageDurationsMs),
    hpssConfidence,
    ...(debug ? { debug } : {}),
  });
}
