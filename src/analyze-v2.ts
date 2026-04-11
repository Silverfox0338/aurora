import type { AnalysisContext, DecodedAudio } from "./audio.ts";
import { throwIfAborted } from "./audio.ts";

import { prepareAnalysisChannels } from "./audio-prep.ts";
import { trackBeats } from "./beat-tracking.ts";
import { V2_CONFIG, V2_VERSION } from "./config.ts";
import { buildMusicalEvents } from "./event-builder.ts";
import { detectOnsets } from "./onset-detection.ts";
import { buildMelodySegments, stabilizePitchTrack } from "./pitch-tracking.ts";
import { analyzeSections } from "./sections.ts";
import { analyzeSpectrum } from "./spectrum.ts";
import type { V2Analysis, V2DebugExport } from "./types.ts";

function clock(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function analyzeV2(audio: DecodedAudio, context: AnalysisContext = {}): V2Analysis {
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
    prepareAnalysisChannels(audio.channels, audio.sampleRate, V2_CONFIG.sampleRate, context.signal),
  );
  report({ stage: "Building spectrum", progress: 0.24 });
  const spectrum = timed("spectral-analysis", () =>
    analyzeSpectrum(
      channels.mono,
      V2_CONFIG.sampleRate,
      V2_CONFIG.frameSize,
      V2_CONFIG.hopSize,
      V2_CONFIG.pitch,
      context.signal,
      V2_CONFIG.onsetLatencyMs,
    ),
  );
  throwIfAborted(context.signal);
  report({ stage: "Detecting rhythm", progress: 0.48 });
  const onsets = timed("onset-detection", () =>
    detectOnsets(spectrum.envelopes, V2_CONFIG.sampleRate, V2_CONFIG.hopSize, {
      ...V2_CONFIG.onset,
      timeOffsetMs: V2_CONFIG.onsetLatencyMs,
    }),
  );
  report({ stage: "Tracking the beat", progress: 0.6 });
  const beatAnalysis = timed("beat-tracking", () =>
    trackBeats(
      spectrum.envelopes.percussive,
      onsets,
      durationMs,
      V2_CONFIG.sampleRate,
      V2_CONFIG.hopSize,
      V2_CONFIG.beat.minimumBpm,
      V2_CONFIG.beat.maximumBpm,
      {
        timeOffsetMs: V2_CONFIG.onsetLatencyMs,
        bassEnvelope: spectrum.envelopes.bass,
        harmonicEnvelope: spectrum.envelopes.harmonic,
      },
    ),
  );
  throwIfAborted(context.signal);
  report({ stage: "Following the melody", progress: 0.72 });
  const pitchTrack = timed("pitch-tracking", () =>
    stabilizePitchTrack(
      spectrum.rawPitch,
      V2_CONFIG.pitch.confidenceThreshold,
      V2_CONFIG.pitch.continuityPenalty,
    ),
  );
  // Pitch is sampled every second hop. Real mixes drop several voiced points inside one sung
  // or bowed note, so bridge short dropouts but only let the note ring one point past the last.
  const pitchStepMs = (V2_CONFIG.hopSize * 2 * 1000) / V2_CONFIG.sampleRate;
  const melody = buildMelodySegments(
    pitchTrack,
    pitchStepMs * (V2_CONFIG.holds.maximumDroppedPoints + 1.5),
    V2_CONFIG.holds.pitchToleranceCents,
    pitchStepMs * 2.5,
  );
  report({ stage: "Building musical events", progress: 0.86 });
  const sections = timed("section-analysis", () =>
    analyzeSections(
      durationMs,
      spectrum.frames,
      onsets,
      beatAnalysis.beats,
      V2_CONFIG.sections.windowMs,
      spectrum.chroma,
    ),
  );
  const events = timed("event-building", () =>
    buildMusicalEvents(onsets, beatAnalysis.beats, pitchTrack, melody, sections, {
      frames: spectrum.frames,
      chroma: spectrum.chroma,
    }),
  );
  const hpssConfidence =
    spectrum.frames.length > 0
      ? spectrum.frames.reduce((sum, frame) => sum + Math.abs(frame.harmonicity - 0.5) * 2, 0) /
        spectrum.frames.length
      : 0;
  let debug: V2DebugExport | undefined;
  if (context.debug) {
    const sampleStep = Math.max(1, Math.floor(channels.mono.length / 1200));
    const frameStep = Math.max(1, Math.floor(spectrum.envelopes.broadband.length / 1200));
    debug = {
      metadata: {
        algorithmVersion: V2_VERSION,
        durationMs,
        sampleRate: V2_CONFIG.sampleRate,
        frameSize: V2_CONFIG.frameSize,
        hopSize: V2_CONFIG.hopSize,
        hpssMode: "spectral-persistence-approximation",
        onsetLatencyMs: V2_CONFIG.onsetLatencyMs,
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
    kind: "v2-analysis",
    durationMs,
    sourceSampleRate: audio.sampleRate,
    analysisSampleRate: V2_CONFIG.sampleRate,
    estimatedBpm: beatAnalysis.bpm,
    tempoConfidence: beatAnalysis.confidence,
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
