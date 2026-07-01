import { V2_CONFIG } from "./config.ts";
import type { BeatMarker, OnsetEvent } from "./types.ts";

export type TempoCandidate = Readonly<{ bpm: number; lagFrames: number; score: number }>;

export type BeatTrackingOptions = Readonly<{
  /** Added to frame-start timestamps so beats share the onset time base. */
  timeOffsetMs?: number;
  /** Low-band flux; kicks and bass notes concentrate on downbeats. */
  bassEnvelope?: Float32Array;
  /** Harmonic flux; chord changes concentrate on downbeats. */
  harmonicEnvelope?: Float32Array;
  /** Midrange flux; snares land here, which the octave resolver uses with the bass band. */
  midEnvelope?: Float32Array;
  tightness?: number;
}>;

/** One reading of the tempo at a different metrical level, ranked by how well it fits. */
export type TempoAlternative = Readonly<{ bpm: number; score: number }>;

export type BeatTrackingResult = Readonly<{
  bpm: number | null;
  confidence: number;
  beats: readonly BeatMarker[];
  candidates: readonly TempoCandidate[];
  /** The chosen tempo first, then its half/double readings; lets apps offer a speed override. */
  alternatives: readonly TempoAlternative[];
  meter: number;
}>;

function tempoPrior(bpm: number): number {
  const octaves = Math.log2(bpm / V2_CONFIG.beat.priorCenterBpm) / V2_CONFIG.beat.priorOctaveWidth;
  return Math.exp(-0.5 * octaves * octaves);
}

/** Mean-removed, length-unbiased autocorrelation normalised so lag 0 equals 1. */
function autocorrelation(envelope: Float32Array, maximumLag: number): Float64Array {
  const length = envelope.length;
  let mean = 0;
  for (const value of envelope) mean += value;
  mean /= Math.max(1, length);
  const centered = new Float64Array(length);
  for (let index = 0; index < length; index += 1) centered[index] = (envelope[index] ?? 0) - mean;
  const result = new Float64Array(maximumLag + 1);
  for (let lag = 0; lag <= maximumLag && lag < length; lag += 1) {
    let sum = 0;
    for (let index = lag; index < length; index += 1) sum += centered[index]! * centered[index - lag]!;
    result[lag] = sum / (length - lag);
  }
  const zero = result[0]!;
  if (zero <= Number.EPSILON) return new Float64Array(maximumLag + 1);
  for (let lag = 0; lag < result.length; lag += 1) result[lag] = result[lag]! / zero;
  return result;
}

function parabolicOffset(left: number, center: number, right: number): number {
  const curvature = left - 2 * center + right;
  return curvature < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / curvature)) : 0;
}

/**
 * Harmonic-sum tempogram: each lag is rewarded for periodicity at its own lag and its
 * double, then weighted by a log-Gaussian tempo prior so octave errors are resolved by
 * musical plausibility instead of whichever lag happens to peak first.
 */
export function scoreTempoCandidates(
  envelope: Float32Array,
  frameRate: number,
  minimumBpm: number,
  maximumBpm: number,
): TempoCandidate[] {
  const minimumLag = Math.max(1, Math.floor((60 * frameRate) / maximumBpm));
  const maximumLag = Math.min(envelope.length - 2, Math.ceil((60 * frameRate) / minimumBpm));
  if (maximumLag <= minimumLag) return [];
  const correlation = autocorrelation(envelope, Math.min(envelope.length - 1, maximumLag * 2 + 2));
  if (correlation[0] === 0) return [];
  const at = (lag: number) => Math.max(0, correlation[lag] ?? 0);
  const scores = new Float64Array(maximumLag + 2);
  for (let lag = minimumLag - 1; lag <= maximumLag + 1; lag += 1) {
    if (lag < 1) continue;
    const bpm = (60 * frameRate) / lag;
    scores[lag] =
      tempoPrior(bpm) * (at(lag) + 0.5 * Math.max(at(lag * 2), 0.5 * (at(lag * 2 - 1) + at(lag * 2 + 1))));
  }
  const candidates: TempoCandidate[] = [];
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    const score = scores[lag]!;
    if (score <= 0 || score < scores[lag - 1]! || score < scores[lag + 1]!) continue;
    const fractionalLag = lag + parabolicOffset(scores[lag - 1]!, score, scores[lag + 1]!);
    candidates.push({ bpm: (60 * frameRate) / fractionalLag, lagFrames: fractionalLag, score });
  }
  return candidates.sort((left, right) => right.score - left.score).slice(0, 8);
}

function smoothEnvelope(envelope: Float32Array, sigmaFrames: number): Float64Array {
  const radius = Math.max(1, Math.ceil(sigmaFrames * 3));
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, index) =>
    Math.exp(-0.5 * ((index - radius) / Math.max(0.5, sigmaFrames)) ** 2),
  );
  const output = new Float64Array(envelope.length);
  let sumSquares = 0;
  for (let index = 0; index < envelope.length; index += 1) {
    let value = 0;
    for (let offset = -radius; offset <= radius; offset += 1)
      value += (envelope[index + offset] ?? 0) * kernel[offset + radius]!;
    output[index] = value;
    sumSquares += value * value;
  }
  const deviation = Math.sqrt(sumSquares / Math.max(1, envelope.length));
  if (deviation > Number.EPSILON)
    for (let index = 0; index < output.length; index += 1) output[index]! /= deviation;
  return output;
}

/** Ellis (2007) dynamic-programming beat tracking over a fractional beat period. */
function dynamicProgrammingBeats(local: Float64Array, period: number, tightness: number): number[] {
  const length = local.length;
  const cumulative = new Float64Array(length);
  const backlink = new Int32Array(length).fill(-1);
  const searchStart = Math.max(1, Math.round(period * 2));
  const searchEnd = Math.max(1, Math.round(period / 2));
  for (let frame = 0; frame < length; frame += 1) {
    let best = -Infinity;
    let bestIndex = -1;
    for (let previous = frame - searchStart; previous <= frame - searchEnd; previous += 1) {
      if (previous < 0) continue;
      const ratio = Math.log((frame - previous) / period);
      const score = cumulative[previous]! - tightness * ratio * ratio;
      if (score > best) {
        best = score;
        bestIndex = previous;
      }
    }
    cumulative[frame] = local[frame]! + (bestIndex >= 0 ? Math.max(0, best) : 0);
    backlink[frame] = bestIndex >= 0 && best > 0 ? bestIndex : -1;
  }
  const maxima: number[] = [];
  for (let frame = 1; frame < length - 1; frame += 1)
    if (cumulative[frame]! > cumulative[frame - 1]! && cumulative[frame]! >= cumulative[frame + 1]!)
      maxima.push(frame);
  if (maxima.length === 0) return [];
  const sortedValues = maxima.map((frame) => cumulative[frame]!).sort((left, right) => left - right);
  const medianValue = sortedValues[Math.floor(sortedValues.length / 2)]!;
  let last = maxima[maxima.length - 1]!;
  for (let index = maxima.length - 1; index >= 0; index -= 1) {
    if (cumulative[maxima[index]!]! >= medianValue * 0.5) {
      last = maxima[index]!;
      break;
    }
  }
  const beats: number[] = [];
  for (let frame = last; frame >= 0; frame = backlink[frame]!) {
    beats.push(frame);
    if (backlink[frame]! < 0) break;
  }
  return beats.reverse();
}

/** Least-squares local line through ±4 beats removes frame-quantisation jitter but follows drift. */
function smoothBeatTimes(times: readonly number[]): number[] {
  const radius = 4;
  return times.map((_, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(times.length - 1, index + radius);
    const count = end - start + 1;
    if (count < 3) return times[index]!;
    let meanX = 0;
    let meanY = 0;
    for (let position = start; position <= end; position += 1) {
      meanX += position;
      meanY += times[position]!;
    }
    meanX /= count;
    meanY /= count;
    let covariance = 0;
    let variance = 0;
    for (let position = start; position <= end; position += 1) {
      covariance += (position - meanX) * (times[position]! - meanY);
      variance += (position - meanX) ** 2;
    }
    const slope = variance > 0 ? covariance / variance : 0;
    const fitted = meanY + slope * (index - meanX);
    // Preserve genuine expressive timing: only pull points that sit within 6% of a beat of the fit.
    return Math.abs(fitted - times[index]!) <= slope * 0.06 ? fitted : times[index]!;
  });
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function extendToSongBounds(times: number[], durationMs: number): number[] {
  if (times.length < 4) return times;
  const leading = median(times.slice(1, 9).map((time, index) => time - times[index]!));
  const trailing = median(
    times
      .slice(-9)
      .slice(1)
      .map((time, index) => time - times.slice(-9)[index]!),
  );
  const extended = [...times];
  if (leading > 0)
    for (let time = times[0]! - leading; time >= -leading * 0.25; time -= leading)
      extended.unshift(Math.max(0, time));
  if (trailing > 0)
    for (let time = times[times.length - 1]! + trailing; time <= durationMs; time += trailing)
      extended.push(time);
  return extended.filter((time, index) => index === 0 || time - extended[index - 1]! > 1);
}

function envelopePeak(envelope: Float32Array | undefined, frame: number): number {
  if (!envelope) return 0;
  let peak = 0;
  for (let offset = -2; offset <= 2; offset += 1) peak = Math.max(peak, envelope[frame + offset] ?? 0);
  return peak;
}

function meanOf(values: Float32Array | undefined): number {
  if (!values || values.length === 0) return 1;
  let sum = 0;
  for (const value of values) sum += value;
  return Math.max(Number.EPSILON, sum / values.length);
}

/** Pick meter and bar phase from where low-end attacks and harmonic changes accumulate. */
function estimateMeter(accents: readonly number[]): Readonly<{ meter: number; phase: number }> {
  if (accents.length < 8) return { meter: 4, phase: 0 };
  const overall = accents.reduce((sum, value) => sum + value, 0) / accents.length;
  if (overall <= Number.EPSILON) return { meter: 4, phase: 0 };
  const contrast = (meter: number) => {
    let bestPhase = 0;
    let bestMean = -Infinity;
    for (let phase = 0; phase < meter; phase += 1) {
      let sum = 0;
      let count = 0;
      for (let index = phase; index < accents.length; index += meter) {
        sum += accents[index]!;
        count += 1;
      }
      const mean = sum / Math.max(1, count);
      if (mean > bestMean) {
        bestMean = mean;
        bestPhase = phase;
      }
    }
    return { phase: bestPhase, contrast: bestMean / overall };
  };
  const quadruple = contrast(4);
  const triple = contrast(3);
  if (triple.contrast > quadruple.contrast * 1.12 && triple.contrast > 1.15)
    return { meter: 3, phase: triple.phase };
  return { meter: 4, phase: quadruple.phase };
}

function normalizedByMean(envelope: Float32Array): Float32Array {
  const mean = meanOf(envelope);
  return Float32Array.from(envelope, (value) => value / mean);
}

/**
 * Off-beat to on-beat energy at a candidate beat period. Each window picks its own best phase,
 * so slow drift does not smear the comb. Near 1 means the half-beats are as busy as the beats
 * (the period is two real beats); near 0 means the half-beats are empty (the period is right).
 */
export function offbeatRatio(envelope: Float32Array, lagFrames: number, windowFrames: number): number {
  const peak = (frame: number) => {
    const center = Math.round(frame);
    let value = 0;
    for (let offset = -2; offset <= 2; offset += 1) value = Math.max(value, envelope[center + offset] ?? 0);
    return value;
  };
  const span = Math.max(windowFrames, lagFrames * 4);
  let offbeat = 0;
  let onbeat = 0;
  for (let start = 0; start + span <= envelope.length; start += span / 2) {
    let bestSum = -1;
    let bestPhase = 0;
    for (let phase = 0; phase < lagFrames; phase += 1) {
      let sum = 0;
      for (let frame = start + phase; frame < start + span; frame += lagFrames) sum += peak(frame);
      if (sum > bestSum) {
        bestSum = sum;
        bestPhase = phase;
      }
    }
    let sum = 0;
    for (let frame = start + bestPhase + lagFrames / 2; frame < start + span; frame += lagFrames) sum += peak(frame);
    offbeat += sum;
    onbeat += bestSum;
  }
  return onbeat > Number.EPSILON ? offbeat / onbeat : 0;
}

/**
 * Off-beat ratio where the slower reading becomes as likely as the faster one. Measured on ten
 * songs with known tempos: true-fast songs read 0.66–0.87 at half speed, true-slow ones 0.58–0.65.
 */
const OCTAVE_RATIO_THRESHOLD = 0.645;
const OCTAVE_EVIDENCE_WEIGHT = 8;
const OCTAVE_PRIOR_WEIGHT = 0.5;

/**
 * Autocorrelation cannot tell a tempo from its double: both repeat. Kicks and snares can. At
 * the real beat they fill the beats and leave the half-beats light; at half speed the snares
 * land on the half-beats. Walk up the octave family from the slowest reading while the
 * half-beats stay busy.
 */
function resolveOctave(
  bestBpm: number,
  envelope: Float32Array,
  frameRate: number,
  minimumBpm: number,
  maximumBpm: number,
): Readonly<{ bpm: number; alternatives: TempoAlternative[]; decisiveness: number }> {
  const windowFrames = Math.round(8 * frameRate);
  let bpm = bestBpm / 2 >= minimumBpm ? bestBpm / 2 : bestBpm;
  const family: { bpm: number; logScore: number }[] = [{ bpm, logScore: Math.log(tempoPrior(bpm)) }];
  let decisiveness = Infinity;
  while (bpm * 2 <= maximumBpm) {
    const ratio = offbeatRatio(envelope, (60 * frameRate) / bpm, windowFrames);
    const evidence =
      (ratio - OCTAVE_RATIO_THRESHOLD) * OCTAVE_EVIDENCE_WEIGHT +
      OCTAVE_PRIOR_WEIGHT * Math.log(tempoPrior(bpm * 2) / tempoPrior(bpm));
    const previous = family[family.length - 1]!;
    family.push({ bpm: bpm * 2, logScore: previous.logScore + evidence });
    decisiveness = Math.min(decisiveness, Math.abs(evidence));
    if (evidence <= 0) break;
    bpm *= 2;
  }
  // Softmax over the family gives comparable scores for apps that offer a half/double override.
  const top = Math.max(...family.map((item) => item.logScore));
  const total = family.reduce((sum, item) => sum + Math.exp(item.logScore - top), 0);
  const alternatives = family
    .map((item) => ({ bpm: item.bpm, score: Math.exp(item.logScore - top) / total }))
    .sort((left, right) => (left.bpm === bpm ? -1 : right.bpm === bpm ? 1 : right.score - left.score));
  return { bpm, alternatives, decisiveness: Number.isFinite(decisiveness) ? decisiveness : 0 };
}

export function trackBeats(
  envelope: Float32Array,
  onsets: readonly OnsetEvent[],
  durationMs: number,
  sampleRate: number,
  hopSize: number,
  minimumBpm: number,
  maximumBpm: number,
  options: BeatTrackingOptions = {},
): BeatTrackingResult {
  const frameRate = sampleRate / hopSize;
  const frameMs = 1000 / frameRate;
  const timeOffsetMs = options.timeOffsetMs ?? 0;
  const candidates = scoreTempoCandidates(envelope, frameRate, minimumBpm, maximumBpm);
  const best = candidates[0];
  const periodicity = best ? Math.min(1, best.score / Math.max(Number.EPSILON, tempoPrior(best.bpm))) : 0;
  if (!best || periodicity < 0.08 || onsets.length === 0)
    return { bpm: null, confidence: periodicity, beats: [], candidates, alternatives: [], meter: 4 };

  // Kicks and snares decide the octave; fall back to the tracking envelope when bands are absent.
  const octaveEnvelope = options.bassEnvelope
    ? (() => {
        const bass = normalizedByMean(options.bassEnvelope!);
        const mid = options.midEnvelope ? normalizedByMean(options.midEnvelope) : undefined;
        return mid ? Float32Array.from(bass, (value, index) => value + mid[index]!) : bass;
      })()
    : envelope;
  const octave = resolveOctave(best.bpm, octaveEnvelope, frameRate, minimumBpm, maximumBpm);
  const periodFrames = (60 * frameRate) / octave.bpm;
  const local = smoothEnvelope(envelope, periodFrames / 32);
  const beatFrames = dynamicProgrammingBeats(local, periodFrames, options.tightness ?? V2_CONFIG.beat.tightness);
  if (beatFrames.length < 2)
    return { bpm: null, confidence: periodicity, beats: [], candidates, alternatives: [], meter: 4 };
  const rawTimes = beatFrames.map((frame) => frame * frameMs + timeOffsetMs);
  const times = extendToSongBounds(smoothBeatTimes(rawTimes), durationMs);
  const intervals = times.slice(1).map((time, index) => time - times[index]!);
  const bpm = 60_000 / Math.max(1, median(intervals));

  const strengths: number[] = [];
  let cursor = 0;
  for (const [index, time] of times.entries()) {
    const window = (intervals[Math.min(index, intervals.length - 1)] ?? 500) * 0.15;
    while (cursor < onsets.length && onsets[cursor]!.timeMs < time - window) cursor += 1;
    let strength = 0;
    for (let probe = cursor; probe < onsets.length && onsets[probe]!.timeMs <= time + window; probe += 1) {
      const distance = Math.abs(onsets[probe]!.timeMs - time);
      strength = Math.max(strength, onsets[probe]!.strength * (1 - distance / window));
    }
    strengths.push(strength);
  }
  const alignedRatio = strengths.filter((strength) => strength > 0.05).length / Math.max(1, strengths.length);
  const octaveConfidence = 1 - Math.exp(-octave.decisiveness);
  const confidence = Math.min(1, periodicity * 0.5 + alignedRatio * 0.3 + octaveConfidence * 0.2);

  const bassMean = meanOf(options.bassEnvelope);
  const harmonicMean = meanOf(options.harmonicEnvelope);
  const accents = times.map((time, index) => {
    const frame = Math.round((time - timeOffsetMs) / frameMs);
    return (
      envelopePeak(options.bassEnvelope, frame) / bassMean +
      (envelopePeak(options.harmonicEnvelope, frame) / harmonicMean) * 0.8 +
      strengths[index]! * 0.4
    );
  });
  const { meter, phase } = estimateMeter(accents);

  const beats: BeatMarker[] = times.map((timeMs, index) => {
    const offset = index - phase;
    const beatInBar = ((offset % meter) + meter) % meter;
    const barIndex = Math.floor(offset / meter) + (phase > 0 ? 1 : 0);
    return {
      timeMs,
      beatIndex: index,
      strength: strengths[index]!,
      confidence: Math.min(1, confidence * 0.7 + strengths[index]! * 0.3),
      beatInBar,
      barIndex,
      ...(beatInBar === 0 ? { isDownbeat: true } : {}),
    };
  });
  return { bpm, confidence, beats, candidates, alternatives: octave.alternatives, meter };
}
