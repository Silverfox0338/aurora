import { DIFFICULTY_RULES, MAX_HOLD_DURATION_MS, MIN_HOLD_DURATION_MS } from "./chart.ts";
import type { ChartQualityMetadata, ChartNote, Difficulty } from "./chart.ts";

import { BeatGrid } from "./grid.ts";
import type { BeatMarker, MusicalEvent } from "./types.ts";

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export type QualityOptions = Readonly<{
  difficulty?: Difficulty;
  /** Share of notes drawn from each lane pattern, for diagnostics. */
  patternCounts?: Readonly<Record<string, number>>;
  repeatedBars?: number;
}>;

export function validateChartQuality(
  notes: readonly ChartNote[],
  durationMs: number,
  laneCount: number,
  beats: readonly BeatMarker[],
  sourceEvents: readonly MusicalEvent[],
  options: QualityOptions = {},
): ChartQualityMetadata {
  const warnings: Array<{ code: string; message: string; timeMs?: number }> = [];
  const warnOnce = new Set<string>();
  const warn = (code: string, message: string, timeMs?: number) => {
    if (code !== "LOCAL_DENSITY" && warnOnce.has(code)) return;
    warnOnce.add(code);
    warnings.push(timeMs === undefined ? { code, message } : { code, message, timeMs });
  };

  // Sliding one-second window: aligned bins hide bursts that straddle a second boundary.
  let peakNotesPerSecond = 0;
  let windowStart = 0;
  let lastDenseWarning = -Infinity;
  const densityLimit = Math.max(12, laneCount * 2.5);
  for (let index = 0; index < notes.length; index += 1) {
    while (notes[index]!.timeMs - notes[windowStart]!.timeMs >= 1000) windowStart += 1;
    const count = index - windowStart + 1;
    peakNotesPerSecond = Math.max(peakNotesPerSecond, count);
    if (count > densityLimit && notes[windowStart]!.timeMs - lastDenseWarning >= 1000) {
      lastDenseWarning = notes[windowStart]!.timeMs;
      warn("LOCAL_DENSITY", "A one-second region is unusually dense.", lastDenseWarning);
    }
  }

  const rules = options.difficulty ? DIFFICULTY_RULES[options.difficulty] : undefined;
  const laneCounts = Array.from({ length: laneCount }, () => 0);
  const laneTimes = Array.from({ length: laneCount }, () => -Infinity);
  const holdEnds = Array.from({ length: laneCount }, () => -Infinity);
  let conflicts = 0;
  let rapidJumps = 0;
  let structural = 0;
  let previous: ChartNote | undefined;
  let chordTime = -Infinity;
  let chordSize = 0;
  for (const note of notes) {
    if (previous && note.timeMs < previous.timeMs) {
      structural += 1;
      warn("ORDER", "Notes are not ordered by time.", note.timeMs);
    }
    if (note.lane < 0 || note.lane >= laneCount || !Number.isInteger(note.timeMs) || note.timeMs < 0) {
      structural += 1;
      warn("OUT_OF_RANGE", "A note falls outside the lane range or has an invalid time.", note.timeMs);
      continue;
    }
    if (note.timeMs > durationMs || (note.kind === "hold" && note.timeMs + note.durationMs > durationMs)) {
      structural += 1;
      warn("PAST_END", "A note extends past the end of the song.", note.timeMs);
    }
    if (
      note.kind === "hold" &&
      (note.durationMs < MIN_HOLD_DURATION_MS || note.durationMs > MAX_HOLD_DURATION_MS)
    ) {
      structural += 1;
      warn("HOLD_LIMIT", "A hold length is outside the accepted range.", note.timeMs);
    }
    if (note.strength < 0 || note.strength > 1) {
      structural += 1;
      warn("STRENGTH_RANGE", "A note strength is outside 0..1.", note.timeMs);
    }
    if (note.timeMs === chordTime) chordSize += 1;
    else {
      chordTime = note.timeMs;
      chordSize = 1;
    }
    if (rules && chordSize > rules.maximumChordSize) {
      structural += 1;
      warn("CHORD_SIZE", "A chord is larger than this difficulty allows.", note.timeMs);
    }
    laneCounts[note.lane] = (laneCounts[note.lane] ?? 0) + 1;
    if (note.timeMs < holdEnds[note.lane]!) {
      conflicts += 1;
      warn("HOLD_CONFLICT", "A note overlaps an active hold in the same lane.", note.timeMs);
    } else if (rules && note.timeMs - laneTimes[note.lane]! < rules.minimumGapMs) {
      conflicts += 1;
      warn("LANE_GAP", "Two notes in one lane are closer than this difficulty allows.", note.timeMs);
    }
    if (
      previous &&
      note.timeMs !== previous.timeMs &&
      note.timeMs - previous.timeMs < 110 &&
      Math.abs(note.lane - previous.lane) > Math.ceil(laneCount / 2)
    )
      rapidJumps += 1;
    laneTimes[note.lane] = note.timeMs;
    if (note.kind === "hold") holdEnds[note.lane] = note.timeMs + note.durationMs;
    previous = note;
  }
  if (notes.length === 0) warn("EMPTY_CHART", "No sufficiently confident musical events were found.");
  if (rapidJumps > Math.max(2, notes.length * 0.04))
    warn("RAPID_JUMPS", "Several rapid cross-lane jumps remain.");
  if (notes.length >= laneCount * 20) {
    const uniform = notes.length / laneCount;
    if (Math.max(...laneCounts) > uniform * 1.8 || Math.min(...laneCounts) < uniform * 0.35)
      warn("LANE_IMBALANCE", "Some lanes carry far more notes than others.");
  }

  // Odd lane counts leave the centre lane to either hand, so it is excluded from balance.
  const middle = (laneCount - 1) / 2;
  let left = 0;
  let right = 0;
  laneCounts.forEach((count, lane) => {
    if (lane < middle) left += count;
    else if (lane > middle) right += count;
  });
  const handBalance = left + right > 0 ? 1 - Math.abs(left - right) / (left + right) : 1;

  // Alignment is judged against the sixteenth and triplet grids, not just quarter-note beats.
  const grid = new BeatGrid(beats);
  let aligned = 0;
  if (!grid.isEmpty)
    for (const note of notes) {
      const straight = grid.snap(note.timeMs, 4)?.distanceMs ?? Infinity;
      const triplet = grid.snap(note.timeMs, 3)?.distanceMs ?? Infinity;
      if (Math.min(straight, triplet) <= 25) aligned += 1;
    }
  const beatAlignmentRatio = notes.length > 0 ? aligned / notes.length : 0;

  // Confidence describes the events that became notes, not everything the detector heard.
  let averageConfidence = 0;
  if (sourceEvents.length > 0) {
    const sorted = [...sourceEvents].sort((a, b) => a.timeMs - b.timeMs);
    let cursor = 0;
    let total = 0;
    let matched = 0;
    for (const note of notes) {
      while (cursor < sorted.length - 1 && sorted[cursor + 1]!.timeMs <= note.timeMs + 80) cursor += 1;
      let best: MusicalEvent | undefined;
      for (let probe = Math.max(0, cursor - 6); probe <= cursor; probe += 1) {
        const candidate = sorted[probe]!;
        if (
          Math.abs(candidate.timeMs - note.timeMs) <= 80 &&
          (!best || candidate.confidence > best.confidence)
        )
          best = candidate;
      }
      if (best) {
        total += best.confidence;
        matched += 1;
      }
    }
    averageConfidence =
      matched > 0
        ? total / matched
        : sourceEvents.reduce((sum, event) => sum + event.confidence, 0) / sourceEvents.length;
  }

  const uniqueTransitions = new Set<string>();
  for (let index = 1; index < notes.length; index += 1)
    uniqueTransitions.add(`${notes[index - 1]!.lane}:${notes[index]!.lane}`);
  const variety = Math.min(1, uniqueTransitions.size / Math.max(4, laneCount * 1.5));
  const totalPatternNotes = Object.values(options.patternCounts ?? {}).reduce((sum, value) => sum + value, 0);
  const patternShares =
    options.patternCounts && totalPatternNotes > 0
      ? Object.freeze(
          Object.fromEntries(
            Object.entries(options.patternCounts).map(([kind, count]) => [
              kind,
              Math.round((count / totalPatternNotes) * 1000) / 1000,
            ]),
          ),
        )
      : undefined;
  return Object.freeze({
    playabilityScore: clampScore(
      100 -
        conflicts * 25 -
        structural * 10 -
        rapidJumps * 2 -
        warnings.filter((item) => item.code === "LOCAL_DENSITY").length * 3,
    ),
    musicalityScore: clampScore((averageConfidence * 0.6 + beatAlignmentRatio * 0.4) * 100),
    varietyScore: clampScore(variety * 100),
    confidenceScore: clampScore(averageConfidence * 100),
    averageNotesPerSecond: notes.length / Math.max(1, durationMs / 1000),
    peakNotesPerSecond,
    handBalance,
    beatAlignmentRatio,
    warnings: Object.freeze(warnings),
    ...(patternShares ? { patternShares } : {}),
    ...(options.repeatedBars !== undefined ? { repeatedBars: options.repeatedBars } : {}),
  });
}

export function repairHardConflicts(
  notes: readonly ChartNote[],
  laneCount: number,
  durationMs?: number,
): ChartNote[] {
  const accepted: ChartNote[] = [];
  const laneReady = Array.from({ length: laneCount }, () => -Infinity);
  for (const note of [...notes].sort((left, right) => left.timeMs - right.timeMs || left.lane - right.lane)) {
    if (note.lane < 0 || note.lane >= laneCount || note.timeMs < (laneReady[note.lane] ?? -Infinity))
      continue;
    if (durationMs !== undefined && note.timeMs >= durationMs) continue;
    let repaired = note;
    if (note.kind === "hold" && durationMs !== undefined && note.timeMs + note.durationMs > durationMs) {
      const trimmed = durationMs - note.timeMs;
      repaired =
        trimmed >= MIN_HOLD_DURATION_MS
          ? { ...note, durationMs: trimmed }
          : { id: note.id, kind: "tap", timeMs: note.timeMs, lane: note.lane, strength: note.strength };
    }
    accepted.push(repaired);
    laneReady[note.lane] =
      repaired.kind === "hold" ? repaired.timeMs + repaired.durationMs + 80 : repaired.timeMs + 55;
  }
  return accepted.map((note, index) =>
    Object.freeze({ ...note, id: `note-${index}-${note.timeMs}-${note.lane}` }),
  );
}
