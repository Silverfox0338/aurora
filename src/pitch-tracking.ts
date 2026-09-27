import type { MelodyNote, PitchPoint } from "./types.ts";

export function frequencyToMidi(frequencyHz: number): number {
  return 69 + 12 * Math.log2(frequencyHz / 440);
}

export function centsDistance(leftMidi: number, rightMidi: number): number {
  return Math.abs(leftMidi - rightMidi) * 100;
}

export function stabilizePitchTrack(
  candidates: readonly PitchPoint[],
  confidenceThreshold: number,
  continuityPenalty: number,
): PitchPoint[] {
  const filtered = candidates.filter((point) => point.confidence >= confidenceThreshold);
  if (filtered.length < 2) return [...filtered];
  const result: PitchPoint[] = [];
  let previous: PitchPoint | undefined;
  for (let index = 0; index < filtered.length; index += 1) {
    const point = filtered[index]!;
    const next = filtered[index + 1];
    if (previous) {
      const jump = point.midi - previous.midi;
      const octaves = Math.round(jump / 12);
      // Only genuine octave (or double-octave) slips are folded back; a 9-semitone leap is melody.
      const isOctaveSlip = octaves !== 0 && Math.abs(octaves) <= 2 && Math.abs(jump - octaves * 12) <= 1.5;
      if (isOctaveSlip && point.confidence < previous.confidence + continuityPenalty) {
        const octaveAdjusted = point.midi - octaves * 12;
        const adjustedFrequency = 440 * 2 ** ((octaveAdjusted - 69) / 12);
        const adjusted = {
          ...point,
          midi: octaveAdjusted,
          frequencyHz: adjustedFrequency,
          confidence: point.confidence * 0.86,
        };
        result.push(adjusted);
        previous = adjusted;
        continue;
      }
    }
    if (
      previous &&
      next &&
      Math.abs(point.midi - previous.midi) > 5 &&
      Math.abs(point.midi - next.midi) > 5 &&
      point.confidence < 0.55
    )
      continue;
    result.push(point);
    previous = point;
  }
  return result;
}

export function buildMelodySegments(
  pitchTrack: readonly PitchPoint[],
  maximumGapMs: number,
  pitchToleranceCents: number,
  /** How far past the last voiced point a segment is assumed to ring. */
  tailMs = maximumGapMs,
): MelodyNote[] {
  const segments: MelodyNote[] = [];
  let group: PitchPoint[] = [];
  // A single off-pitch point is held back until the next point shows whether the pitch really moved.
  let outlier: PitchPoint | undefined;
  const finish = () => {
    if (group.length < 2) {
      group = [];
      return;
    }
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const totalWeight = group.reduce((sum, point) => sum + point.confidence, 0);
    const midiPitch =
      group.reduce((sum, point) => sum + point.midi * point.confidence, 0) /
      Math.max(totalWeight, Number.EPSILON);
    segments.push({
      startMs: first.timeMs,
      endMs: last.timeMs + tailMs,
      midiPitch,
      confidence: totalWeight / group.length,
      attackStrength: first.salience / Math.max(1, first.salience + 2),
    });
    group = [];
  };
  // Vibrato swings around the note, so compare with the median of roughly one vibrato cycle
  // (nine points ≈ 200 ms) rather than the last point.
  const reference = () => {
    const recent = group
      .slice(-9)
      .map((point) => point.midi)
      .sort((left, right) => left - right);
    return recent[recent.length >> 1]!;
  };
  const add = (point: PitchPoint) => {
    const previous = group[group.length - 1];
    if (!previous || point.timeMs - previous.timeMs > maximumGapMs) {
      outlier = undefined;
      finish();
      group.push(point);
      return;
    }
    if (centsDistance(point.midi, reference()) <= pitchToleranceCents) {
      outlier = undefined;
      group.push(point);
      return;
    }
    if (!outlier) {
      outlier = point;
      return;
    }
    // Two consecutive points away from the note: the pitch genuinely changed.
    const started = outlier;
    outlier = undefined;
    finish();
    group.push(started);
    add(point);
  };
  for (const point of pitchTrack) add(point);
  finish();
  return segments;
}
