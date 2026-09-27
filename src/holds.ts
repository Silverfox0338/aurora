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
      // "Same pitch" is the same semitone: vibrato can bring a neighbouring note within 1.
      (candidate.pitchMidi === undefined || Math.abs(candidate.pitchMidi - event.pitchMidi!) < 0.5) &&
      candidate.evidence.some((evidence) => evidence.includes("onset") || evidence === "spectral-flux") &&
      // A faint flicker under a held note is not a new attack.
      candidate.strength >= event.strength * 0.6,
  );
  if (rearticulation) endTimeMs = rearticulation.timeMs - 90;
  const duration = Math.min(MAX_HOLD_DURATION_MS, Math.round(endTimeMs - event.timeMs));
  return duration >= V2_CONFIG.holds.minimumDurationMs ? duration : undefined;
}

export type SustainEvidence = Readonly<{
  frames: readonly SpectralFrame[];
  /** Drum-free twelve-bin pitch-class energy per frame, row-major. */
  harmonicChroma: Float32Array;
}>;

/**
 * Pitch tracking drops out inside many real sung or bowed notes, and on chords it flickers
 * between chord tones. A note therefore also counts as sustained while its own pitch class
 * keeps ringing in the drum-free spectrum: still loud against its post-attack level, and still
 * a fair share of all tonal energy, so a pad holding the same chord underneath does not keep
 * it alive forever. Returns the time the sustain ends, or undefined when shorter than a hold.
 */
export function spectralSustainEndMs(
  timeMs: number,
  pitchMidi: number,
  evidence: SustainEvidence,
): number | undefined {
  const { frames, harmonicChroma } = evidence;
  if (frames.length < 8 || harmonicChroma.length < frames.length * 12) return undefined;
  const hopMs = frames[1]!.timeMs - frames[0]!.timeMs;
  const start = Math.max(0, Math.round((timeMs - frames[0]!.timeMs) / hopMs));
  if (start + 8 >= frames.length) return undefined;
  const pitchClass = ((Math.round(pitchMidi) % 12) + 12) % 12;
  // Three-frame smoothing keeps one noisy frame from ending the note.
  const smoothed = (index: number) => {
    let note = 0;
    let total = 0;
    for (let frame = Math.max(0, index - 1); frame <= Math.min(frames.length - 1, index + 1); frame += 1) {
      note += harmonicChroma[frame * 12 + pitchClass]!;
      for (let bin = 0; bin < 12; bin += 1) total += harmonicChroma[frame * 12 + bin]!;
    }
    return { note, share: total > 1e-20 ? note / total : 0 };
  };
  // Whatever already sounded in this pitch class before the attack (a pad, a held chord) is
  // background: only the energy the note adds on top of it counts as the note.
  // The quietest pre-attack frame: a steady pad is fully counted, while a busy, fluctuating
  // part (strummed or distorted guitar) is not mistaken for a wall of background.
  let background = Infinity;
  for (let index = Math.max(0, start - 8); index <= start - 3; index += 1)
    background = Math.min(background, smoothed(index).note);
  if (!Number.isFinite(background)) background = 0;
  const added = (index: number) => {
    const { note, share } = smoothed(index);
    const extra = Math.max(0, note - background);
    return { note: extra, share: note > 1e-20 ? (share * extra) / note : 0 };
  };
  // Reference level and share just after the attack, where the note is fully sounding.
  let peak = 0;
  let referenceShare = 0;
  for (let index = start + 1; index < start + 8; index += 1) {
    const { note, share } = added(index);
    if (note > peak) {
      peak = note;
      referenceShare = share;
    }
  }
  if (peak <= 1e-20 || referenceShare < V2_CONFIG.holds.sustainMinimumShare) return undefined;
  const { sustainEnergyRatio, sustainShareRatio, sustainMissFrames } = V2_CONFIG.holds;
  const limit = Math.min(frames.length, start + Math.ceil(MAX_HOLD_DURATION_MS / hopMs));
  let last = start + 4;
  let misses = 0;
  for (let index = start + 5; index < limit; index += 1) {
    const { note, share } = added(index);
    if (note >= peak * sustainEnergyRatio && share >= referenceShare * sustainShareRatio) {
      last = index;
      misses = 0;
    } else if (++misses > sustainMissFrames) break;
  }
  const endMs = frames[last]!.timeMs;
  return endMs - timeMs >= V2_CONFIG.holds.minimumDurationMs ? endMs : undefined;
}
