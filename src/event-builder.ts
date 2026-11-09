import { AURORA_CONFIG } from "./config.ts";
import { BeatGrid } from "./grid.ts";
import { spectralSustainEndMs, type SustainEvidence } from "./holds.ts";
import type {
  BeatMarker,
  MelodyNote,
  MusicalEvent,
  MusicalEventRole,
  OnsetBand,
  OnsetEvent,
  PitchPoint,
  SongSection,
} from "./types.ts";

/** Binary search for the item nearest `targetMs` in a time-sorted list. */
export function nearestByTime<T>(
  items: readonly T[],
  time: (item: T) => number,
  targetMs: number,
): T | undefined {
  if (items.length === 0) return undefined;
  let low = 0;
  let high = items.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (time(items[middle]!) < targetMs) low = middle + 1;
    else high = middle;
  }
  const after = items[low]!;
  const before = items[low - 1];
  return before !== undefined && Math.abs(time(before) - targetMs) <= Math.abs(time(after) - targetMs)
    ? before
    : after;
}

export function sectionAt(sections: readonly SongSection[], timeMs: number): SongSection | undefined {
  let low = 0;
  let high = sections.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const section = sections[middle]!;
    if (timeMs < section.startMs) high = middle - 1;
    else if (timeMs >= section.endMs) low = middle + 1;
    else return section;
  }
  return undefined;
}

type OnsetCluster = { onsets: OnsetEvent[]; strongest: OnsetEvent };

/**
 * Each detector band fires independently, so one kick typically produces a broadband and
 * a bass onset a few milliseconds apart. Treating those as separate events manufactured
 * false chords; clustering restores one event per musical attack.
 */
export function mergeOnsets(onsets: readonly OnsetEvent[], windowMs: number): OnsetCluster[] {
  const clusters: OnsetCluster[] = [];
  for (const onset of onsets) {
    const last = clusters[clusters.length - 1];
    if (
      last &&
      onset.timeMs - last.onsets[0]!.timeMs <= windowMs &&
      !last.onsets.some((item) => item.band === onset.band)
    ) {
      last.onsets.push(onset);
      if (onset.strength > last.strongest.strength) last.strongest = onset;
    } else clusters.push({ onsets: [onset], strongest: onset });
  }
  return clusters;
}

/**
 * A sustained note sounding underneath a hat does not make the hat pitched, so an attack
 * only counts as tonal when a stable pitch segment begins with it.
 */
function classifyRole(
  bands: ReadonlyMap<OnsetBand, number>,
  pitch: PitchPoint | undefined,
  startsPitch: boolean,
): MusicalEventRole {
  const bass = bands.get("bass") ?? 0;
  const mid = bands.get("mid") ?? 0;
  const high = bands.get("high") ?? 0;
  const pitched = startsPitch && pitch !== undefined && pitch.confidence >= 0.4;
  if (pitched && pitch.midi < 48 && bass > 0) return "bass";
  if (pitched && (mid > 0 || bands.size === 1)) return "melody";
  if (bass > 0 && bass >= mid && bass >= high * 0.8) return "kick";
  if (high > 0 && high >= mid && bass === 0) return "hat";
  if (mid > 0) return "snare";
  if (high > 0) return "hat";
  return "percussive";
}

const SUSTAINED_ROLES = new Set<MusicalEventRole>(["melody", "bass", "vocal", "harmonic"]);

export function buildMusicalEvents(
  onsets: readonly OnsetEvent[],
  beats: readonly BeatMarker[],
  pitchTrack: readonly PitchPoint[],
  melody: readonly MelodyNote[],
  sections: readonly SongSection[],
  sustain?: SustainEvidence,
): MusicalEvent[] {
  const grid = new BeatGrid(beats);
  const events: MusicalEvent[] = [];
  const noteStarts = melody.map((note) => note.startMs).sort((left, right) => left - right);
  const rhythmicDetails = (timeMs: number) => {
    if (grid.isEmpty) return {};
    const beatSnap = grid.snap(timeMs, 4);
    const tripletSnap = grid.snap(timeMs, 3);
    const snap =
      tripletSnap && beatSnap && tripletSnap.distanceMs + 4 < beatSnap.distanceMs ? tripletSnap : beatSnap;
    if (!snap) return {};
    const tolerance = snap.intervalMs / 8;
    const fit = Math.max(0, 1 - snap.distanceMs / tolerance);
    const beat = beats[Math.min(beats.length - 1, snap.beatIndex)];
    const rhythmicConfidence = fit * (beat?.confidence ?? 0.5) * (snap.level <= 1 ? 1 : 0.85);
    return rhythmicConfidence > 0
      ? {
          beatIndex: snap.beatIndex,
          beatSubdivision: snap.level === 0 ? 1 : snap === tripletSnap ? 3 : snap.level === 1 ? 2 : 4,
          rhythmicConfidence,
        }
      : {};
  };

  for (const [index, cluster] of mergeOnsets(onsets, AURORA_CONFIG.onsetMergeWindowMs).entries()) {
    const timeMs = cluster.strongest.timeMs;
    const bands = new Map<OnsetBand, number>();
    for (const onset of cluster.onsets)
      bands.set(onset.band, Math.max(bands.get(onset.band) ?? 0, onset.strength));
    const nearestPitch = nearestByTime(pitchTrack, (item) => item.timeMs, timeMs);
    const nearbyPitch =
      nearestPitch && Math.abs(nearestPitch.timeMs - timeMs) < 60 ? nearestPitch : undefined;
    const nearestStart = nearestByTime(noteStarts, (start) => start, timeMs);
    const startsPitch = nearestStart !== undefined && Math.abs(nearestStart - timeMs) < 60;
    const role = classifyRole(bands, nearbyPitch, startsPitch);
    const pitch = role === "melody" || role === "bass" ? nearbyPitch : undefined;
    const section = sectionAt(sections, timeMs);
    const rhythm = rhythmicDetails(timeMs);
    const peakStrength = Math.max(...cluster.onsets.map((onset) => onset.strength));
    const peakConfidence = Math.max(...cluster.onsets.map((onset) => onset.confidence));
    const corroboration = Math.min(0.15, (cluster.onsets.length - 1) * 0.06);
    const sourceBands = [...bands.keys()].sort();
    const evidence = ["spectral-flux", ...sourceBands.map((band) => `${band}-onset`)];
    if ((rhythm.rhythmicConfidence ?? 0) > 0.25) evidence.push("beat-grid");
    if (pitch) evidence.push("pitch-salience");
    events.push({
      id: `e${index}-${Math.round(timeMs)}-${sourceBands.join("+")}`,
      timeMs,
      role,
      strength: Math.min(1, (peakStrength + corroboration) * (0.72 + (section?.intensity ?? 0.5) * 0.28)),
      confidence: Math.min(
        1,
        (peakConfidence + corroboration) * 0.72 +
          (rhythm.rhythmicConfidence ?? 0) * 0.18 +
          (pitch?.confidence ?? 0) * 0.1,
      ),
      ...(pitch ? { pitchMidi: pitch.midi, pitchConfidence: pitch.confidence } : {}),
      ...rhythm,
      sourceBands,
      evidence,
    });
  }

  // Sustained pitch either lengthens the attack that started it or becomes its own event.
  const attackTimes = events.map((event) => event.timeMs);
  for (const [index, note] of melody.entries()) {
    const nearest = nearestByTime(attackTimes, (time) => time, note.startMs);
    const attackIndex = nearest === undefined ? -1 : attackTimes.indexOf(nearest);
    const attack = attackIndex >= 0 ? events[attackIndex]! : undefined;
    if (attack && Math.abs(attack.timeMs - note.startMs) < 55) {
      // Melody notes often land with a snare or hat. A short note there stays a drum hit, but a
      // held note takes the attack over, or its hold would be lost to the drum.
      const held = note.endMs - note.startMs >= AURORA_CONFIG.holds.minimumDurationMs;
      if (attack.endTimeMs === undefined && (held || (attack.role !== "hat" && attack.role !== "snare")))
        events[attackIndex] = {
          ...attack,
          endTimeMs: note.endMs,
          role: SUSTAINED_ROLES.has(attack.role) ? attack.role : note.midiPitch < 48 ? "bass" : "melody",
          pitchMidi: note.midiPitch,
          pitchConfidence: Math.max(attack.pitchConfidence ?? 0, note.confidence),
          evidence: [...attack.evidence, "stable-pitch"],
        };
      continue;
    }
    events.push({
      id: `m${index}-${Math.round(note.startMs)}`,
      timeMs: note.startMs,
      endTimeMs: note.endMs,
      role: note.midiPitch < 48 ? "bass" : "melody",
      strength: Math.min(1, note.attackStrength * 0.65 + note.confidence * 0.35),
      confidence: note.confidence,
      pitchMidi: note.midiPitch,
      pitchConfidence: note.confidence,
      ...rhythmicDetails(note.startMs),
      sourceBands: ["harmonic"],
      evidence: ["stable-pitch", "harmonic-persistence"],
    });
  }
  if (sustain)
    events.forEach((event, index) => {
      if (!SUSTAINED_ROLES.has(event.role) || event.pitchMidi === undefined) return;
      const endMs = spectralSustainEndMs(event.timeMs, event.pitchMidi, sustain);
      if (endMs !== undefined && endMs > (event.endTimeMs ?? -Infinity))
        events[index] = { ...event, endTimeMs: endMs, evidence: [...event.evidence, "spectral-sustain"] };
    });
  return events.sort((left, right) => left.timeMs - right.timeMs || left.id.localeCompare(right.id));
}
