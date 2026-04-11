import type { OnsetEnvelopes } from "./spectrum.ts";
import type { OnsetBand, OnsetEvent } from "./types.ts";

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function maximumOf(values: Float32Array): number {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, value);
  return maximum;
}

export function adaptiveThreshold(
  envelope: Float32Array,
  windowFrames: number,
  multiplier: number,
): Float32Array {
  const thresholds = new Float32Array(envelope.length);
  for (let index = 0; index < envelope.length; index += 1) {
    const start = Math.max(0, index - windowFrames);
    const end = Math.min(envelope.length, index + windowFrames + 1);
    const local = Array.from(envelope.subarray(start, end));
    const center = median(local);
    const mad = median(local.map((value) => Math.abs(value - center)));
    thresholds[index] = center + Math.max(center * 0.12, mad * multiplier);
  }
  return thresholds;
}

function peaksForBand(
  envelope: Float32Array,
  band: OnsetBand,
  frameDurationMs: number,
  localWindowFrames: number,
  thresholdMultiplier: number,
  minimumGapMs: number,
  timeOffsetMs: number,
): OnsetEvent[] {
  const threshold = adaptiveThreshold(envelope, localWindowFrames, thresholdMultiplier);
  const events: OnsetEvent[] = [];
  let lastTime = -Infinity;
  let maximum = 0;
  for (const value of envelope) maximum = Math.max(maximum, value);
  if (maximum <= Number.EPSILON) return events;
  for (let index = 1; index < envelope.length - 1; index += 1) {
    const value = envelope[index] ?? 0;
    const previousValue = envelope[index - 1] ?? 0;
    const nextValue = envelope[index + 1] ?? 0;
    // Parabolic peak interpolation gives sub-frame (< 11.6 ms) attack placement.
    const curvature = previousValue - 2 * value + nextValue;
    const refinement =
      curvature < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (previousValue - nextValue)) / curvature)) : 0;
    const timeMs = (index + refinement) * frameDurationMs + timeOffsetMs;
    const localThreshold = threshold[index] ?? 0;
    if (
      value <= localThreshold ||
      value < maximum * 0.035 ||
      value < previousValue ||
      value <= nextValue ||
      timeMs - lastTime < minimumGapMs
    )
      continue;
    const prominence = (value - localThreshold) / Math.max(value, Number.EPSILON);
    events.push({
      timeMs,
      strength: Math.min(1, value / maximum),
      confidence: Math.min(1, 0.35 + prominence * 0.65),
      band,
    });
    lastTime = timeMs;
  }
  return events;
}

export function detectOnsets(
  envelopes: OnsetEnvelopes,
  sampleRate: number,
  hopSize: number,
  options: Readonly<{
    localWindowFrames: number;
    thresholdMultiplier: number;
    minimumGapMs: number;
    timeOffsetMs?: number;
  }>,
): OnsetEvent[] {
  const frameDurationMs = (hopSize * 1000) / sampleRate;
  const entries: readonly [OnsetBand, Float32Array][] = [
    ["broadband", envelopes.broadband],
    ["bass", envelopes.bass],
    ["mid", envelopes.midrange],
    ["high", envelopes.highFrequency],
  ];
  const broadbandMaximum = Math.max(maximumOf(envelopes.broadband), Number.EPSILON);
  return entries
    .filter(([band, envelope]) => band === "broadband" || maximumOf(envelope) >= broadbandMaximum * 0.015)
    .flatMap(([band, envelope]) =>
      peaksForBand(
        envelope,
        band,
        frameDurationMs,
        options.localWindowFrames,
        options.thresholdMultiplier,
        options.minimumGapMs,
        options.timeOffsetMs ?? 0,
      ),
    )
    .sort((left, right) => left.timeMs - right.timeMs || left.band.localeCompare(right.band));
}
