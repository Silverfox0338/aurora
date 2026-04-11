import { MAX_HOLD_DURATION_MS } from "./chart.ts";

import { V2_CONFIG } from "./config.ts";
import type { MusicalEvent, MusicalEventRole, SpectralFrame } from "./types.ts";

const SUSTAINED_ROLES = new Set<MusicalEventRole>(["melody", "bass", "vocal", "harmonic"]);

/**
 * Raw sustain length (ms) for an event with stable pitch evidence, cut short where the
 * same voice re-articulates. Grid quantisation and frequency caps happen in the planner.
 */
export function sustainedHoldDuration(
  event: MusicalEvent,
  futureEvents: readonly MusicalEvent[],
): number | undefined {
  if (
    !SUSTAINED_ROLES.has(event.role) ||
    event.endTimeMs === undefined ||
    event.pitchMidi === undefined ||
    (event.pitchConfidence ?? event.confidence) < V2_CONFIG.pitch.confidenceThreshold
  )
    return undefined;
  let endTimeMs = event.endTimeMs;
  const rearticulation = futureEvents.find(
    (candidate) =>
      candidate.timeMs > event.timeMs + 140 &&
      candidate.timeMs < endTimeMs &&
      SUSTAINED_ROLES.has(candidate.role) &&
      // Re-attacking the same pitch ends the sustain; a different voice playing over it does not.
      (candidate.pitchMidi === undefined || Math.abs(candidate.pitchMidi - event.pitchMidi!) < 1) &&
      candidate.evidence.some((evidence) => evidence.includes("onset") || evidence === "spectral-flux") &&
      // A faint flicker under a held note is not a new attack.
      candidate.strength >= event.strength * 0.6,
  );
  if (rearticulation) endTimeMs = rearticulation.timeMs - 90;
  const duration = Math.min(MAX_HOLD_DURATION_MS, Math.round(endTimeMs - event.timeMs));
  return duration >= V2_CONFIG.holds.minimumDurationMs ? duration : undefined;
}

export type SustainEvidence = Readonly<{ frames: readonly SpectralFrame[]; chroma: Float32Array }>;

/**
 * Pitch tracking drops out inside many real sung or bowed notes, so a note also counts as
 * sustained while the mix keeps its pitch-class profile and most of its tonal energy.
 * Returns the time the sustain ends, or undefined when it is shorter than a hold.
 */
export function spectralSustainEndMs(timeMs: number, evidence: SustainEvidence): number | undefined {
  const { frames, chroma } = evidence;
  if (frames.length < 8 || chroma.length < frames.length * 12) return undefined;
  const hopMs = frames[1]!.timeMs - frames[0]!.timeMs;
  const start = Math.max(0, Math.round((timeMs - frames[0]!.timeMs) / hopMs));
  if (start + 6 >= frames.length) return undefined;
  const tonal = (index: number) => {
    const energy = frames[index]!.bandEnergy;
    return energy.lowMid + energy.mid + energy.upperMid;
  };
  // Three-frame chroma smoothing keeps one noisy frame from ending the note.
  const profile = (index: number) => {
    const vector = new Float64Array(12);
    for (let frame = Math.max(0, index - 1); frame <= Math.min(frames.length - 1, index + 1); frame += 1)
      for (let pitchClass = 0; pitchClass < 12; pitchClass += 1)
        vector[pitchClass]! += chroma[frame * 12 + pitchClass]!;
    return vector;
  };
  const similarity = (left: Float64Array, right: Float64Array) => {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
      dot += left[pitchClass]! * right[pitchClass]!;
      leftNorm += left[pitchClass]! ** 2;
      rightNorm += right[pitchClass]! ** 2;
    }
    return dot / Math.sqrt(leftNorm * rightNorm + 1e-12);
  };
  let peak = 0;
  for (let index = start; index < start + 6; index += 1) peak = Math.max(peak, tonal(index));
  if (peak <= 0) return undefined;
  // Take the reference just after the attack transient.
  const reference = profile(start + 4);
  const { sustainChromaSimilarity, sustainEnergyRatio, sustainMissFrames } = V2_CONFIG.holds;
  const limit = Math.min(frames.length, start + Math.ceil(MAX_HOLD_DURATION_MS / hopMs));
  let last = start + 4;
  let misses = 0;
  for (let index = start + 5; index < limit; index += 1) {
    if (
      tonal(index) >= peak * sustainEnergyRatio &&
      similarity(profile(index), reference) >= sustainChromaSimilarity
    ) {
      last = index;
      misses = 0;
    } else if (++misses > sustainMissFrames) break;
  }
  const endMs = frames[last]!.timeMs;
  return endMs - timeMs >= V2_CONFIG.holds.minimumDurationMs ? endMs : undefined;
}
