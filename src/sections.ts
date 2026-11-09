import { AURORA_CONFIG } from "./config.ts";
import { BeatGrid } from "./grid.ts";
import type { BeatMarker, OnsetEvent, SectionLabel, SongSection, SpectralFrame } from "./types.ts";

const BANDS = ["sub", "bass", "lowMid", "mid", "upperMid", "high"] as const;

type Unit = Readonly<{ startMs: number; endMs: number }>;

/** Bars when downbeats exist; fixed windows otherwise so un-pulsed audio still gets sections. */
function analysisUnits(durationMs: number, beats: readonly BeatMarker[], windowMs: number): Unit[] {
  const downbeats = beats.filter((beat) => beat.isDownbeat).map((beat) => beat.timeMs);
  if (downbeats.length >= 8) {
    const edges = [0, ...downbeats.filter((time) => time > 50 && time < durationMs - 50), durationMs];
    return edges.slice(1).map((endMs, index) => ({ startMs: edges[index]!, endMs }));
  }
  const step = Math.min(windowMs / 2, 4_000);
  const units: Unit[] = [];
  for (let startMs = 0; startMs < durationMs; startMs += step)
    units.push({ startMs, endMs: Math.min(durationMs, startMs + step) });
  return units;
}

function unitFeatures(
  units: readonly Unit[],
  frames: readonly SpectralFrame[],
  chroma: Float32Array | undefined,
): Readonly<{ vectors: number[][]; energy: number[]; harmonicity: number[]; frameCounts: number[] }> {
  const vectors: number[][] = [];
  const energy: number[] = [];
  const harmonicity: number[] = [];
  const frameCounts: number[] = [];
  let cursor = 0;
  for (const unit of units) {
    while (cursor < frames.length && frames[cursor]!.timeMs < unit.startMs) cursor += 1;
    const pitchClasses = Array.from({ length: 12 }, () => 0);
    const bands = Array.from({ length: BANDS.length }, () => 0);
    let totalEnergy = 0;
    let totalHarmonicity = 0;
    let count = 0;
    for (let index = cursor; index < frames.length && frames[index]!.timeMs < unit.endMs; index += 1) {
      const frame = frames[index]!;
      totalEnergy += frame.totalEnergy;
      totalHarmonicity += frame.harmonicity;
      BANDS.forEach((band, bandIndex) => (bands[bandIndex]! += frame.bandEnergy[band]));
      if (chroma) for (let pc = 0; pc < 12; pc += 1) pitchClasses[pc]! += chroma[index * 12 + pc] ?? 0;
      count += 1;
    }
    const chromaTotal = pitchClasses.reduce((sum, value) => sum + value, 0);
    vectors.push([
      ...pitchClasses.map((value) => (chromaTotal > 0 ? value / chromaTotal : 0)),
      ...bands.map((value) => Math.log1p((value / Math.max(1, count)) * 1e4) * 0.15),
    ]);
    energy.push(totalEnergy / Math.max(1, count));
    harmonicity.push(totalHarmonicity / Math.max(1, count));
    frameCounts.push(count);
  }
  return { vectors, energy, harmonicity, frameCounts };
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

/** Foote checkerboard novelty along the self-similarity diagonal. */
function noveltyCurve(vectors: readonly number[][], kernelHalf: number): number[] {
  const count = vectors.length;
  const similarity = vectors.map((left) => vectors.map((right) => cosineSimilarity(left, right)));
  const novelty = Array.from({ length: count }, () => 0);
  const taper = (offset: number) => Math.exp(-0.5 * (offset / Math.max(1, kernelHalf * 0.6)) ** 2);
  for (let boundary = 1; boundary < count; boundary += 1) {
    let score = 0;
    let weight = 0;
    for (let a = -kernelHalf; a < kernelHalf; a += 1) {
      for (let b = -kernelHalf; b < kernelHalf; b += 1) {
        const row = boundary + a;
        const column = boundary + b;
        if (row < 0 || column < 0 || row >= count || column >= count) continue;
        const sign = a < 0 === b < 0 ? 1 : -1;
        const kernel = sign * taper(a + 0.5) * taper(b + 0.5);
        score += kernel * similarity[row]![column]!;
        weight += Math.abs(kernel);
      }
    }
    novelty[boundary] = weight > 0 ? Math.max(0, score / weight) : 0;
  }
  return novelty;
}

function pickBoundaries(novelty: readonly number[], minimumUnits: number, maximumUnits: number): number[] {
  const mean = novelty.reduce((sum, value) => sum + value, 0) / Math.max(1, novelty.length);
  const deviation = Math.sqrt(
    novelty.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, novelty.length),
  );
  const peaks = novelty
    .map((value, index) => ({ value, index }))
    .filter(
      ({ value, index }) =>
        index >= minimumUnits &&
        index <= novelty.length - minimumUnits &&
        value > mean + deviation * 0.5 &&
        value >= (novelty[index - 1] ?? 0) &&
        value >= (novelty[index + 1] ?? 0),
    )
    .sort((left, right) => right.value - left.value || left.index - right.index);
  const chosen: number[] = [];
  for (const peak of peaks)
    if (chosen.every((index) => Math.abs(index - peak.index) >= minimumUnits)) chosen.push(peak.index);
  const edges = [0, ...chosen.sort((left, right) => left - right), novelty.length];
  // Long uniform stretches still need local intensity tracking, so split them evenly.
  const result: number[] = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const start = edges[index]!;
    const end = edges[index + 1]!;
    const pieces = Math.max(1, Math.ceil((end - start) / maximumUnits));
    for (let piece = 0; piece < pieces; piece += 1)
      result.push(start + Math.round(((end - start) * piece) / pieces));
  }
  result.push(novelty.length);
  return result;
}

function detectFeel(
  onsets: readonly OnsetEvent[],
  grid: BeatGrid,
  startMs: number,
  endMs: number,
): "straight" | "triplet" {
  if (grid.isEmpty) return "straight";
  let offBeat = 0;
  let triplet = 0;
  for (const onset of onsets) {
    if (onset.timeMs < startMs || onset.timeMs >= endMs || onset.strength < 0.2) continue;
    const interval = grid.intervalAtTime(onset.timeMs);
    const beat = grid.snap(onset.timeMs, 1);
    if (!beat || beat.distanceMs < interval / 12) continue;
    offBeat += 1;
    const straight = grid.snap(onset.timeMs, 4)!.distanceMs;
    const swung = grid.snap(onset.timeMs, 3)!.distanceMs;
    if (swung + interval * 0.03 < straight) triplet += 1;
  }
  return offBeat >= 8 && triplet / offBeat > 0.6 ? "triplet" : "straight";
}

function labelFor(
  index: number,
  intensities: readonly number[],
  densityRatio: number,
  previous: SectionLabel | undefined,
): SectionLabel {
  const intensity = intensities[index]!;
  const next = intensities[index + 1];
  const last = intensities.length - 1;
  if (index === 0 && intensity < 0.55) return "intro";
  if (index === last && intensity < 0.55) return "outro";
  if (intensity < 0.3) return "break";
  // A song with no dynamic contrast has no chorus to distinguish; its body is all verse.
  const contrast = Math.max(...intensities) - Math.min(...intensities);
  if (intensity >= 0.8 && contrast >= 0.2) {
    const before = intensities[index - 1] ?? intensity;
    return (previous === "break" || previous === "build") && intensity - before >= 0.25 && densityRatio > 0.7
      ? "drop"
      : "chorus";
  }
  if (next !== undefined && next - intensity >= 0.2 && intensity < 0.75) return "build";
  return "verse";
}

export function analyzeSections(
  durationMs: number,
  frames: readonly SpectralFrame[],
  onsets: readonly OnsetEvent[],
  beats: readonly BeatMarker[],
  windowMs: number,
  chroma?: Float32Array,
): SongSection[] {
  if (durationMs <= 0) return [];
  const units = analysisUnits(durationMs, beats, windowMs);
  const features = unitFeatures(units, frames, chroma);
  const usingBars = beats.some((beat) => beat.isDownbeat) && units.length >= 8;
  const kernelHalf = usingBars ? AURORA_CONFIG.sections.noveltyKernelBars : 2;
  const minimumUnits = usingBars ? AURORA_CONFIG.sections.minimumBars : 2;
  const maximumUnits = usingBars ? AURORA_CONFIG.sections.maximumBars : 4;
  const edges =
    units.length > minimumUnits * 2
      ? pickBoundaries(noveltyCurve(features.vectors, kernelHalf), minimumUnits, maximumUnits)
      : [0, units.length];
  const grid = new BeatGrid(beats);

  type Raw = Omit<SongSection, "intensity" | "label"> & { energy: number };
  const raw: Raw[] = [];
  let onsetCursor = 0;
  let beatCursor = 0;
  for (let index = 0; index < edges.length - 1; index += 1) {
    const first = edges[index]!;
    const lastUnit = edges[index + 1]! - 1;
    if (lastUnit < first) continue;
    const startMs = units[first]!.startMs;
    const endMs = units[lastUnit]!.endMs;
    let energy = 0;
    let harmonicity = 0;
    let frameCount = 0;
    for (let unit = first; unit <= lastUnit; unit += 1) {
      energy += features.energy[unit]! * features.frameCounts[unit]!;
      harmonicity += features.harmonicity[unit]! * features.frameCounts[unit]!;
      frameCount += features.frameCounts[unit]!;
    }
    while (onsetCursor < onsets.length && onsets[onsetCursor]!.timeMs < startMs) onsetCursor += 1;
    let onsetCount = 0;
    for (let probe = onsetCursor; probe < onsets.length && onsets[probe]!.timeMs < endMs; probe += 1)
      onsetCount += 1;
    while (beatCursor < beats.length && beats[beatCursor]!.timeMs < startMs) beatCursor += 1;
    let beatStrength = 0;
    for (let probe = beatCursor; probe < beats.length && beats[probe]!.timeMs < endMs; probe += 1)
      beatStrength += beats[probe]!.strength;
    const seconds = Math.max(0.001, (endMs - startMs) / 1000);
    raw.push({
      startMs,
      endMs,
      energy: energy / Math.max(1, frameCount),
      onsetDensity: onsetCount / seconds,
      harmonicDensity: harmonicity / Math.max(1, frameCount),
      rhythmicDensity: beatStrength / seconds,
      confidence: Math.min(1, frameCount / 20),
      feel: detectFeel(onsets, grid, startMs, endMs),
    });
  }
  const maximumEnergy = Math.max(0, ...raw.map((section) => section.energy));
  const maximumDensity = Math.max(0, ...raw.map((section) => section.onsetDensity));
  const intensities = raw.map((section) =>
    maximumEnergy > 0
      ? Math.sqrt(section.energy / maximumEnergy) * 0.75 +
        (maximumDensity > 0 ? section.onsetDensity / maximumDensity : 0) * 0.25
      : 0,
  );
  const sections: SongSection[] = [];
  for (const [index, rawSection] of raw.entries()) {
    const { energy, ...section } = rawSection;
    void energy;
    const label = labelFor(
      index,
      intensities,
      maximumDensity > 0 ? section.onsetDensity / maximumDensity : 0,
      sections[index - 1]?.label,
    );
    sections.push({ ...section, intensity: intensities[index]!, label });
  }
  return sections;
}
