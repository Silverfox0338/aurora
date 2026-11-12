import { AURORA_CONFIG, AURORA_FEATURE_FLAGS } from "./config.ts";
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
  /** Full-band flux; with the tracking envelope it decides between duple and triple readings. */
  broadbandEnvelope?: Float32Array;
  /** Drum-free chroma, 12 values per frame; chord changes mark downbeats. */
  harmonicChroma?: Float32Array;
  tightness?: number;
}>;

/** One reading of the tempo at a different metrical level, ranked by how well it fits. */
export type TempoAlternative = Readonly<{ bpm: number; score: number }>;

/** From `startMs` until the next entry, beats run at `bpm`. A steady song has one entry. */
export type TempoMapEntry = Readonly<{ startMs: number; bpm: number }>;

export type BeatTrackingResult = Readonly<{
  bpm: number | null;
  confidence: number;
  beats: readonly BeatMarker[];
  candidates: readonly TempoCandidate[];
  /** The chosen tempo first, then its half/double readings; lets apps offer a speed override. */
  alternatives: readonly TempoAlternative[];
  /** Tempo segments in time order; more than one when the song changes tempo. */
  tempoMap: readonly TempoMapEntry[];
  meter: number;
}>;

function tempoPrior(bpm: number): number {
  const octaves = Math.log2(bpm / AURORA_CONFIG.beat.priorCenterBpm) / AURORA_CONFIG.beat.priorOctaveWidth;
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

/** A stretch of the song with one beat period, in analysis frames. */
type TempoSegment = { startFrame: number; endFrame: number; periodFrames: number };

const LOCAL_WINDOW_SECONDS = 8;
const LOCAL_HOP_SECONDS = 2;
/** Local tempo may wander this far (as a ratio) from the global reading; beyond it is another octave. */
const LOCAL_RANGE = 1.38;
/** Viterbi: squared log-ratio cost for drift, and the flat cost of an abrupt tempo change. */
const DRIFT_WEIGHT = 60;
const JUMP_COST = 0.9;
/** Windows within this log-ratio of a segment's median belong to it (≈4%). */
const SEGMENT_TOLERANCE = 0.04;
/** Six windows two seconds apart cover about 18 s: shorter stretches are fills, not tempo changes. */
const MINIMUM_SEGMENT_WINDOWS = 6;
/** Mean normalised periodicity a segment's own period must gain over the main period. */
const SEGMENT_EVIDENCE = 0.15;

/**
 * Tempo changes: score every allowed period in overlapping windows, take the smoothest path
 * through them with Viterbi, then group the path into steady segments. A song whose path never
 * leaves one segment keeps exactly the global period, so steady songs track as before.
 */
function tempoSegments(envelope: Float32Array, globalPeriod: number, frameRate: number): TempoSegment[] {
  const length = envelope.length;
  const whole: TempoSegment[] = [{ startFrame: 0, endFrame: length, periodFrames: globalPeriod }];
  const windowFrames = Math.round(LOCAL_WINDOW_SECONDS * frameRate);
  const hopFrames = Math.round(LOCAL_HOP_SECONDS * frameRate);
  if (length < windowFrames * 2) return whole;
  const minimumLag = Math.max(2, Math.floor(globalPeriod / LOCAL_RANGE));
  const maximumLag = Math.ceil(globalPeriod * LOCAL_RANGE);
  const states = maximumLag - minimumLag + 1;
  const starts: number[] = [];
  for (let start = 0; start + windowFrames <= length; start += hopFrames) starts.push(start);
  if (starts[starts.length - 1]! + windowFrames < length) starts.push(length - windowFrames);

  const emissions = starts.map((start) => {
    const correlation = autocorrelation(envelope.subarray(start, start + windowFrames), maximumLag * 2 + 1);
    const scores = new Float64Array(states);
    let peak = 0;
    for (let state = 0; state < states; state += 1) {
      const lag = minimumLag + state;
      scores[state] = Math.max(0, correlation[lag] ?? 0) + 0.5 * Math.max(0, correlation[lag * 2] ?? 0);
      peak = Math.max(peak, scores[state]!);
    }
    if (peak > Number.EPSILON) for (let state = 0; state < states; state += 1) scores[state]! /= peak;
    return scores;
  });

  const cost = (from: number, to: number) => {
    const distance = Math.log((minimumLag + to) / (minimumLag + from));
    return Math.min(DRIFT_WEIGHT * distance * distance, JUMP_COST);
  };
  let score = Float64Array.from(emissions[0]!);
  const backlinks: Int32Array[] = [];
  for (let window = 1; window < emissions.length; window += 1) {
    const next = new Float64Array(states);
    const link = new Int32Array(states);
    for (let to = 0; to < states; to += 1) {
      let best = -Infinity;
      let bestFrom = to;
      for (let from = 0; from < states; from += 1) {
        const candidate = score[from]! - cost(from, to);
        if (candidate > best) {
          best = candidate;
          bestFrom = from;
        }
      }
      next[to] = best + emissions[window]![to]!;
      link[to] = bestFrom;
    }
    backlinks.push(link);
    score = next;
  }
  const path = new Array<number>(emissions.length);
  path[path.length - 1] = score.indexOf(Math.max(...score));
  for (let window = path.length - 1; window > 0; window -= 1) path[window - 1] = backlinks[window - 1]![path[window]!]!;
  const periods = path.map((state, window) => {
    const scores = emissions[window]!;
    const offset = state > 0 && state < states - 1 ? parabolicOffset(scores[state - 1]!, scores[state]!, scores[state + 1]!) : 0;
    return minimumLag + state + offset;
  });

  // Greedy grouping into steady stretches, then fold short ones into the closer neighbour.
  const groups: number[][] = [];
  for (const [window, period] of periods.entries()) {
    const current = groups[groups.length - 1];
    if (current && Math.abs(Math.log(period / median(current.map((index) => periods[index]!)))) <= SEGMENT_TOLERANCE)
      current.push(window);
    else groups.push([window]);
  }
  const groupPeriod = (group: number[]) => median(group.map((index) => periods[index]!));
  for (let index = 0; index < groups.length && groups.length > 1; ) {
    if (groups[index]!.length >= MINIMUM_SEGMENT_WINDOWS) {
      index += 1;
      continue;
    }
    const period = groupPeriod(groups[index]!);
    const left = groups[index - 1];
    const right = groups[index + 1];
    const distance = (group: number[] | undefined) =>
      group ? Math.abs(Math.log(groupPeriod(group) / period)) : Infinity;
    const target = distance(left) <= distance(right) ? index - 1 : index + 1;
    groups[target] = target < index ? [...groups[target]!, ...groups[index]!] : [...groups[index]!, ...groups[target]!];
    groups.splice(index, 1);
    index = Math.max(0, index - 1);
  }
  // A segment has to earn its own tempo: across its windows, its period must fit clearly better
  // than the song's main one. Breakdowns and intros with no steady beat fit every period about
  // equally, so they fold back into the main tempo instead of inventing a change.
  const stateOf = (period: number) => Math.max(0, Math.min(states - 1, Math.round(period) - minimumLag));
  const globalState = stateOf(globalPeriod);
  for (const group of groups) {
    const period = groupPeriod(group);
    if (Math.abs(Math.log(period / globalPeriod)) <= SEGMENT_TOLERANCE) continue;
    const state = stateOf(period);
    const advantage =
      group.reduce((sum, window) => sum + emissions[window]![state]! - emissions[window]![globalState]!, 0) /
      group.length;
    if (advantage < SEGMENT_EVIDENCE) for (const window of group) periods[window] = globalPeriod;
  }
  // Neighbours that now agree are one segment.
  for (let index = 1; index < groups.length; ) {
    if (Math.abs(Math.log(groupPeriod(groups[index]!) / groupPeriod(groups[index - 1]!))) <= SEGMENT_TOLERANCE) {
      groups[index - 1] = [...groups[index - 1]!, ...groups[index]!];
      groups.splice(index, 1);
    } else index += 1;
  }
  if (groups.length === 1) return whole;
  const centre = (window: number) => starts[window]! + windowFrames / 2;
  return groups.map((group, index) => ({
    startFrame: index === 0 ? 0 : Math.round((centre(groups[index - 1]!.at(-1)!) + centre(group[0]!)) / 2),
    endFrame: index === groups.length - 1 ? length : Math.round((centre(group.at(-1)!) + centre(groups[index + 1]![0]!)) / 2),
    periodFrames: groupPeriod(group),
  }));
}

/** Ellis (2007) dynamic-programming beat tracking over a per-frame fractional beat period. */
function dynamicProgrammingBeats(local: Float64Array, periods: Float64Array, tightness: number): number[] {
  const length = local.length;
  const cumulative = new Float64Array(length);
  const backlink = new Int32Array(length).fill(-1);
  for (let frame = 0; frame < length; frame += 1) {
    const period = periods[frame]!;
    const searchStart = Math.max(1, Math.round(period * 2));
    const searchEnd = Math.max(1, Math.round(period / 2));
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

/** Robust z-score: centre on the median, scale by the median absolute deviation. */
function robustZ(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const center = sorted[sorted.length >> 1]!;
  const deviations = values.map((value) => Math.abs(value - center)).sort((a, b) => a - b);
  const spread = Math.max(Number.EPSILON, deviations[deviations.length >> 1]! * 1.4826);
  return values.map((value) => Math.max(-4, Math.min(4, (value - center) / spread)));
}

/**
 * Harmonic change at each beat: cosine distance between the mean drum-free chroma of the two beats
 * before it and the two beats from it. Chords change on downbeats far more often than mid-bar.
 */
function chromaNovelty(times: readonly number[], chroma: Float32Array, frameMs: number, timeOffsetMs: number): number[] {
  const frameCount = Math.floor(chroma.length / 12);
  const perBeat = times.map((time, index) => {
    const start = Math.max(0, Math.round((time - timeOffsetMs) / frameMs));
    const nextTime = times[index + 1] ?? time + (time - (times[index - 1] ?? time - 500));
    const end = Math.min(frameCount, Math.max(start + 1, Math.round((nextTime - timeOffsetMs) / frameMs)));
    const vector = new Float64Array(12);
    for (let frame = start; frame < end; frame += 1)
      for (let pc = 0; pc < 12; pc += 1) vector[pc] = vector[pc]! + (chroma[frame * 12 + pc] ?? 0);
    return vector;
  });
  const span = (from: number, to: number) => {
    const sum = new Float64Array(12);
    for (let index = Math.max(0, from); index < Math.min(perBeat.length, to); index += 1)
      for (let pc = 0; pc < 12; pc += 1) sum[pc] = sum[pc]! + perBeat[index]![pc]!;
    return sum;
  };
  return times.map((_, index) => {
    const before = span(index - 2, index);
    const after = span(index, index + 2);
    let dot = 0;
    let normBefore = 0;
    let normAfter = 0;
    for (let pc = 0; pc < 12; pc += 1) {
      dot += before[pc]! * after[pc]!;
      normBefore += before[pc]! ** 2;
      normAfter += after[pc]! ** 2;
    }
    if (normBefore <= Number.EPSILON || normAfter <= Number.EPSILON) return 0;
    return 1 - dot / Math.sqrt(normBefore * normAfter);
  });
}

/** Expected accent of each feature at each bar position (index 0 = downbeat). */
const BAR_TEMPLATES: Readonly<Record<number, Readonly<{ chord: number[]; kick: number[]; snare: number[] }>>> = {
  4: { chord: [1, -0.5, 0.25, -0.5], kick: [0.6, -0.4, 0.3, -0.4], snare: [-0.5, 0.5, -0.5, 0.5] },
  3: { chord: [1, -0.5, -0.5], kick: [0.8, -0.4, -0.4], snare: [-0.4, 0.2, 0.2] },
};

/**
 * Bar position of every beat by Viterbi decoding: each beat normally advances one position, but the
 * path may re-sync (at a cost) where the beat tracker added or dropped a beat. Emissions match chord
 * change, kick and snare accents against the meter's template.
 */
export function decodeBarPositions(
  meter: number,
  features: Readonly<{ chord: readonly number[]; kick: readonly number[]; snare: readonly number[] }>,
  weights: Readonly<{ chord: number; kick: number; snare: number; resync: number }>,
): number[] {
  const template = BAR_TEMPLATES[meter] ?? BAR_TEMPLATES[4]!;
  const count = features.chord.length;
  if (count === 0) return [];
  const chord = robustZ(features.chord);
  const kick = robustZ(features.kick);
  const snare = robustZ(features.snare);
  const emission = (beat: number, position: number) =>
    weights.chord * chord[beat]! * template.chord[position]! +
    weights.kick * kick[beat]! * template.kick[position]! +
    weights.snare * snare[beat]! * template.snare[position]!;
  let scores = Array.from({ length: meter }, (_, position) => emission(0, position));
  const back: Int8Array[] = [];
  for (let beat = 1; beat < count; beat += 1) {
    const from = new Int8Array(meter);
    const next = new Array<number>(meter);
    for (let position = 0; position < meter; position += 1) {
      const advance = (position - 1 + meter) % meter;
      let best = scores[advance]!;
      let bestFrom = advance;
      for (let previous = 0; previous < meter; previous += 1) {
        if (previous === advance) continue;
        const candidate = scores[previous]! - weights.resync;
        if (candidate > best) {
          best = candidate;
          bestFrom = previous;
        }
      }
      next[position] = best + emission(beat, position);
      from[position] = bestFrom;
    }
    back.push(from);
    scores = next;
  }
  const positions = new Array<number>(count);
  let position = scores.indexOf(Math.max(...scores));
  for (let beat = count - 1; beat >= 0; beat -= 1) {
    positions[beat] = position;
    if (beat > 0) position = back[beat - 1]![position]!;
  }
  return positions;
}

/** Per-beat downbeat evidence: chord change, kick (low band) and snare (mid band) accents. */
export function barFeatures(
  times: readonly number[],
  options: BeatTrackingOptions,
  frameMs: number,
  timeOffsetMs: number,
): Readonly<{ chord: number[]; kick: number[]; snare: number[] }> {
  const bassMean = meanOf(options.bassEnvelope);
  const midMean = meanOf(options.midEnvelope);
  const frames = times.map((time) => Math.round((time - timeOffsetMs) / frameMs));
  return {
    chord: options.harmonicChroma
      ? chromaNovelty(times, options.harmonicChroma, frameMs, timeOffsetMs)
      : times.map(() => 0),
    kick: frames.map((frame) => envelopePeak(options.bassEnvelope, frame) / bassMean),
    snare: frames.map((frame) => envelopePeak(options.midEnvelope, frame) / midMean),
  };
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
 * Octave decision constants, fitted on 104 songs across ~50 genres with reference tempos
 * (90 of them octave-resolvable): 83/90 correct, on a broad plateau of nearby settings. The
 * off-beat ratio where the slower reading becomes as likely as the faster one, and a tempo
 * likelihood of its own (centred on 110 BPM, 0.6 octaves wide) weighed against it.
 */
const OCTAVE_RATIO_THRESHOLD = 0.5;
const OCTAVE_EVIDENCE_WEIGHT = 8;
const OCTAVE_PRIOR_WEIGHT = 3;
const OCTAVE_PRIOR_CENTER_BPM = 110;
const OCTAVE_PRIOR_WIDTH = 0.6;

/** Log-likelihood of a tempo as the felt beat. */
function octaveLogPrior(bpm: number): number {
  const octaves = Math.log2(bpm / OCTAVE_PRIOR_CENTER_BPM) / OCTAVE_PRIOR_WIDTH;
  return -0.5 * octaves * octaves;
}

/**
 * How sharply a beat grid at `bpm` lands on the envelope's peaks: the mean on-grid peak (best
 * phase per 8 s window) over the envelope mean. A grid at the real tempo hits every accent;
 * a grid at 2/3 or 3/2 of it puts half its points between them.
 */
export function gridContrast(envelope: Float32Array, bpm: number, frameRate: number): number {
  const lagFrames = (60 * frameRate) / bpm;
  const span = Math.max(Math.round(8 * frameRate), lagFrames * 4);
  const mean = meanOf(envelope);
  if (mean <= Number.EPSILON) return 0;
  const peak = (frame: number) => {
    const center = Math.round(frame);
    let value = 0;
    for (let offset = -2; offset <= 2; offset += 1) {
      const index = center + offset;
      if (index >= 0 && index < envelope.length) value = Math.max(value, envelope[index]!);
    }
    return value;
  };
  let sum = 0;
  let count = 0;
  for (let start = 0; start + span <= envelope.length; start += span / 2) {
    let bestSum = -1;
    let bestCount = 0;
    for (let phase = 0; phase < lagFrames; phase += 1) {
      let windowSum = 0;
      let windowCount = 0;
      for (let frame = start + phase; frame < start + span; frame += lagFrames) {
        windowSum += peak(frame);
        windowCount += 1;
      }
      if (windowSum > bestSum) {
        bestSum = windowSum;
        bestCount = windowCount;
      }
    }
    sum += bestSum;
    count += bestCount;
  }
  return count ? sum / count / mean : 0;
}

/**
 * Contrast gain a triple (×3/2, folded into the same octave) reading needs over the duple
 * one, as the geometric mean over the tracking and full-band envelopes. Fitted on 104
 * songs: the five songs whose beat is a triple of the autocorrelation peak score 1.09–1.42;
 * the nearest duple songs stay under 1.05.
 */
const TRIPLE_CONTRAST_GAIN = 1.07;

/** Fold a tempo into the octave [low, 2·low). */
function foldIntoOctave(bpm: number, low: number): number {
  while (bpm < low) bpm *= 2;
  while (bpm >= low * 2) bpm /= 2;
  return bpm;
}

/**
 * Autocorrelation peaks at the strongest repetition, which for swung, dembow and half-time
 * trap grooves is often two-thirds or four-thirds of the beat. Compare the grid sharpness of
 * the duple reading against the triple one inside the same octave and switch when the
 * triple grid is clearly sharper. The octave walk then picks the level.
 */
function resolveTripleFamily(bestBpm: number, envelopes: readonly Float32Array[], frameRate: number): number {
  const duple = foldIntoOctave(bestBpm, 80);
  const triple = foldIntoOctave(bestBpm * 1.5, 80);
  let logGain = 0;
  for (const envelope of envelopes)
    logGain += Math.log(gridContrast(envelope, triple, frameRate) / Math.max(Number.EPSILON, gridContrast(envelope, duple, frameRate)));
  return Math.exp(logGain / envelopes.length) >= TRIPLE_CONTRAST_GAIN ? bestBpm * 1.5 : bestBpm;
}

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
  let bpm = bestBpm;
  while (bpm / 2 >= minimumBpm) bpm /= 2;
  const family: { bpm: number; logScore: number }[] = [{ bpm, logScore: octaveLogPrior(bpm) }];
  let decisiveness = Infinity;
  while (bpm * 2 <= maximumBpm) {
    const ratio = offbeatRatio(envelope, (60 * frameRate) / bpm, windowFrames);
    const evidence =
      (ratio - OCTAVE_RATIO_THRESHOLD) * OCTAVE_EVIDENCE_WEIGHT +
      OCTAVE_PRIOR_WEIGHT * (octaveLogPrior(bpm * 2) - octaveLogPrior(bpm));
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
    return { bpm: null, confidence: periodicity, beats: [], candidates, alternatives: [], tempoMap: [], meter: 4 };

  // Kicks and snares decide the octave; fall back to the tracking envelope when bands are absent.
  const octaveEnvelope = options.bassEnvelope
    ? (() => {
        const bass = normalizedByMean(options.bassEnvelope!);
        const mid = options.midEnvelope ? normalizedByMean(options.midEnvelope) : undefined;
        return mid ? Float32Array.from(bass, (value, index) => value + mid[index]!) : bass;
      })()
    : envelope;
  const familyBpm = resolveTripleFamily(
    best.bpm,
    options.broadbandEnvelope ? [envelope, options.broadbandEnvelope] : [envelope],
    frameRate,
  );
  const octave = resolveOctave(familyBpm, octaveEnvelope, frameRate, minimumBpm, maximumBpm);
  const periodFrames = (60 * frameRate) / octave.bpm;
  const local = smoothEnvelope(envelope, periodFrames / 32);
  const segments = tempoSegments(envelope, periodFrames, frameRate);
  const periods = new Float64Array(envelope.length);
  for (const segment of segments) periods.fill(segment.periodFrames, segment.startFrame, segment.endFrame);
  const beatFrames = dynamicProgrammingBeats(local, periods, options.tightness ?? AURORA_CONFIG.beat.tightness);
  if (beatFrames.length < 2)
    return { bpm: null, confidence: periodicity, beats: [], candidates, alternatives: [], tempoMap: [], meter: 4 };
  const rawTimes = beatFrames.map((frame) => frame * frameMs + timeOffsetMs);
  const times = extendToSongBounds(smoothBeatTimes(rawTimes), durationMs);
  const intervals = times.slice(1).map((time, index) => time - times[index]!);
  const tempoMap = segments.map((segment, index): TempoMapEntry => {
    const startMs = index === 0 ? 0 : segment.startFrame * frameMs + timeOffsetMs;
    const endMs = index === segments.length - 1 ? Infinity : segment.endFrame * frameMs + timeOffsetMs;
    const inside = intervals.filter((_, beat) => times[beat]! >= startMs && times[beat + 1]! <= endMs);
    return {
      startMs: Math.round(startMs),
      bpm: inside.length >= 3 ? 60_000 / median(inside) : (60 * frameRate) / segment.periodFrames,
    };
  });
  // The median beat interval names the song's tempo: it follows where most beats sit, even when it changes.
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
  const positions = (() => {
    if (!AURORA_FEATURE_FLAGS.advancedDownbeats || !options.harmonicChroma)
      return times.map((_, index) => (((index - phase) % meter) + meter) % meter);
    return decodeBarPositions(meter, barFeatures(times, options, frameMs, timeOffsetMs), AURORA_CONFIG.beat.downbeat);
  })();

  // Pickup beats before the first downbeat are bar 0, as before.
  let barIndex = 0;
  const beats: BeatMarker[] = times.map((timeMs, index) => {
    const beatInBar = positions[index]!;
    if (index > 0 && beatInBar === 0) barIndex += 1;
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
  return { bpm, confidence, beats, candidates, alternatives: octave.alternatives, tempoMap, meter };
}
