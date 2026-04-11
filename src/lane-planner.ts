import { DIFFICULTY_RULES, MAX_HOLD_DURATION_MS, MIN_HOLD_DURATION_MS } from "./chart.ts";
import { createDeterministicRandom } from "./prng.ts";
import type { ChartNote, ChartSettings } from "./chart.ts";

import { isAdvancedDifficulty, V2_CONFIG, V2_DIFFICULTY, type DifficultyProfile } from "./config.ts";
import { sectionAt } from "./event-builder.ts";
import { BeatGrid } from "./grid.ts";
import { sustainedHoldDuration } from "./holds.ts";
import type { BeatMarker, MusicalEvent, MusicalEventRole, SongSection } from "./types.ts";

export type PatternKind = "stream" | "trill" | "jack" | "free";

export type Removal = Readonly<{ eventId: string; reason: string }>;

export type LanePlan = Readonly<{
  notes: readonly ChartNote[];
  removed: readonly Removal[];
  /** Moments that no lane assignment could place without breaking spacing rules. */
  movedForConflict: number;
  reducedChords: number;
  patternCounts: Readonly<Record<PatternKind, number>>;
  repeatedBars: number;
  passes: number;
}>;

/** One playable instant: a single note or a chord, after grid quantisation. */
type Moment = {
  timeMs: number;
  events: MusicalEvent[];
  lead: MusicalEvent;
  size: number;
  priority: number;
  level: number;
  downbeat: boolean;
  beatIndex: number;
  pitch?: number;
  role: MusicalEventRole;
  holdMs?: number;
  pattern: PatternKind;
};

type BeamState = Readonly<{
  cost: number;
  lastLanes: readonly number[];
  previousLane: number;
  direction: number;
  lastTimeMs: number;
  /** Last lane and time per hand; wide layouts measure travel within the hand that plays. */
  handLanes: readonly [number, number];
  handTimes: readonly [number, number];
  previousPitch?: number;
  laneTimes: readonly number[];
  laneHoldEnds: readonly number[];
  laneLoad: readonly number[];
  parent?: BeamState;
  lanes?: readonly number[];
  momentIndex: number;
}>;

const BEAM_WIDTH = 12;
const BALANCE_HALF_LIFE_MS = 4_000;
const PRIORITY_FLOOR = 0.2;
const LEVEL_BONUS = [0.15, 0.08, 0.03, 0];

function eventPriority(event: MusicalEvent, difficulty: ChartSettings["difficulty"]): number {
  const sustained =
    event.endTimeMs !== undefined && event.endTimeMs - event.timeMs >= V2_CONFIG.holds.minimumDurationMs
      ? 0.1
      : 0;
  const role =
    difficulty === "easy"
      ? event.role === "hat"
        ? -0.08
        : event.role === "kick" || event.role === "snare" || event.role === "melody" || event.role === "bass"
          ? 0.05
          : 0
      : event.role === "melody" || event.role === "vocal"
        ? 0.04
        : 0;
  return (
    event.strength * 0.45 + event.confidence * 0.3 + (event.rhythmicConfidence ?? 0) * 0.1 + sustained + role
  );
}

type Quantized = Readonly<{
  event: MusicalEvent;
  timeMs: number;
  level: number;
  beatIndex: number;
  downbeat: boolean;
}>;

/**
 * Snap to the finest grid the difficulty allows. Easy and normal discard attacks that sit
 * between their grid points (they are finer rhythms than the chart should ask for); hard
 * keeps them, trying the alternate straight/triplet grid before falling back to raw time.
 */
function quantizeEvent(
  event: MusicalEvent,
  grid: BeatGrid,
  beats: readonly BeatMarker[],
  sections: readonly SongSection[],
  profile: DifficultyProfile,
  settings: ChartSettings,
): Quantized | undefined {
  if (grid.isEmpty)
    return { event, timeMs: Math.round(event.timeMs), level: 3, beatIndex: -1, downbeat: false };
  const interval = grid.intervalAtTime(event.timeMs);
  const base =
    interval >= profile.subdivision.slowBeatMs ? profile.subdivision.slow : profile.subdivision.fast;
  const triplet = sectionAt(sections, event.timeMs)?.feel === "triplet";
  const subdivision = triplet ? (base >= 2 ? 3 : 1) : base;
  const attempt = (division: number, windowFraction: number, cap: number): Quantized | undefined => {
    const snap = grid.snap(event.timeMs, division);
    if (!snap || snap.distanceMs > Math.min(cap, (snap.intervalMs / division) * windowFraction))
      return undefined;
    return {
      event,
      timeMs: Math.round(snap.timeMs),
      level: snap.level,
      beatIndex: snap.beatIndex,
      downbeat: snap.level === 0 && beats[snap.beatIndex]?.isDownbeat === true,
    };
  };
  const primary = attempt(subdivision, 0.4, 75);
  if (primary) return primary;
  if (!isAdvancedDifficulty(settings.difficulty)) return undefined;
  const alternate = attempt(triplet ? 4 : 3, 0.25, 40);
  if (alternate) return alternate;
  return {
    event,
    timeMs: Math.round(event.timeMs),
    level: 3,
    beatIndex: grid.beatAt(event.timeMs),
    downbeat: false,
  };
}

function buildMoments(quantized: readonly Quantized[], settings: ChartSettings, profile: DifficultyProfile) {
  const rules = DIFFICULTY_RULES[settings.difficulty];
  const sorted = [...quantized].sort(
    (left, right) => left.timeMs - right.timeMs || left.event.id.localeCompare(right.event.id),
  );
  const groups: Quantized[][] = [];
  for (const item of sorted) {
    const last = groups[groups.length - 1];
    const tolerance = item.level === 3 || last?.[0]?.level === 3 ? 45 : 1;
    if (last && item.timeMs - last[0]!.timeMs <= tolerance) last.push(item);
    else groups.push([item]);
  }
  let reducedChords = 0;
  const moments: Moment[] = groups.map((group) => {
    const anchor = group.reduce((best, item) => (item.level < best.level ? item : best), group[0]!);
    const events = group
      .map((item) => item.event)
      .sort(
        (left, right) =>
          eventPriority(right, settings.difficulty) - eventPriority(left, settings.difficulty) ||
          left.id.localeCompare(right.id),
      );
    const distinct: MusicalEvent[] = [];
    for (const event of events) if (!distinct.some((item) => item.role === event.role)) distinct.push(event);
    const lead = events[0]!;
    const strength = Math.max(...events.map((event) => event.strength * 0.6 + event.confidence * 0.4));
    let size = Math.min(rules.maximumChordSize, distinct.length);
    if (size >= 2 && (strength < profile.chordStrength || anchor.level > 1)) size = 1;
    if (size >= 3 && !(anchor.downbeat && strength >= 0.65)) size = 2;
    // Accent doubling: a strong, broadband downbeat earns a chord even from a single attack.
    if (
      size === 1 &&
      rules.maximumChordSize >= 2 &&
      anchor.downbeat &&
      lead.sourceBands.length >= 2 &&
      strength >= profile.chordStrength + 0.25
    )
      size = 2;
    reducedChords += Math.max(0, events.length - size);
    const priority =
      Math.max(...events.map((event) => eventPriority(event, settings.difficulty))) +
      (LEVEL_BONUS[anchor.level] ?? 0) +
      (anchor.downbeat ? 0.07 : 0);
    const pitch = events.find((event) => event.pitchMidi !== undefined)?.pitchMidi;
    return {
      timeMs: anchor.timeMs,
      events,
      lead,
      size,
      priority,
      level: anchor.level,
      downbeat: anchor.downbeat,
      beatIndex: anchor.beatIndex,
      ...(pitch !== undefined ? { pitch } : {}),
      role: lead.role,
      pattern: "free" as PatternKind,
    };
  });
  return { moments, reducedChords };
}

/** Keep the strongest moments in each two-bar window until its notes-per-second budget is spent. */
function applyDensityBudget(
  moments: readonly Moment[],
  grid: BeatGrid,
  sections: readonly SongSection[],
  profile: DifficultyProfile,
  settings: ChartSettings,
  removed: Removal[],
): Moment[] {
  const beatsPerWindow = 8;
  const windowOf = (moment: Moment) =>
    moment.beatIndex >= 0
      ? Math.floor(moment.beatIndex / beatsPerWindow)
      : 1e6 + Math.floor(moment.timeMs / 4000);
  const windows = new Map<number, Moment[]>();
  for (const moment of moments) {
    const key = windowOf(moment);
    windows.set(key, [...(windows.get(key) ?? []), moment]);
  }
  const kept: Moment[] = [];
  let carry = 0;
  for (const key of [...windows.keys()].sort((left, right) => left - right)) {
    const candidates = windows.get(key)!;
    const startMs =
      key < 1e6 ? (grid.times[key * beatsPerWindow] ?? candidates[0]!.timeMs) : (key - 1e6) * 4000;
    const seconds = key < 1e6 ? (grid.intervalAt(key * beatsPerWindow) * beatsPerWindow) / 1000 : 4;
    const intensity = sectionAt(sections, startMs + seconds * 500)?.intensity ?? 0.5;
    const [quiet, loud] = profile.notesPerSecond;
    const target =
      (quiet + (loud - quiet) * Math.max(0, Math.min(1, intensity))) * settings.density * seconds;
    const budget = target + carry;
    let used = 0;
    const ranked = [...candidates].sort(
      (left, right) => right.priority - left.priority || left.timeMs - right.timeMs,
    );
    for (const moment of ranked) {
      if (moment.priority < PRIORITY_FLOOR) {
        moment.events.forEach((event) => removed.push({ eventId: event.id, reason: "low-confidence" }));
        continue;
      }
      if (used + moment.size > budget + 0.5) {
        if (moment.size > 1 && used + 1 <= budget + 0.5) {
          moment.size = 1;
          used += 1;
          kept.push(moment);
          continue;
        }
        moment.events.forEach((event) => removed.push({ eventId: event.id, reason: "density-budget" }));
        continue;
      }
      used += moment.size;
      kept.push(moment);
    }
    carry = Math.max(-2, Math.min(target * 0.25, budget - used));
  }
  kept.sort((left, right) => left.timeMs - right.timeMs);
  return capPeakDensity(
    kept,
    Math.max(1, Math.round(profile.peakNotesPerSecond * settings.density)),
    removed,
  );
}

/** Two-bar budgets still allow bursts; drop the weakest moments from any one-second window over the cap. */
function capPeakDensity(moments: Moment[], cap: number, removed: Removal[]): Moment[] {
  const kept: Moment[] = [];
  let start = 0;
  let notes = 0;
  for (const moment of moments) {
    kept.push(moment);
    notes += moment.size;
    while (moment.timeMs - kept[start]!.timeMs >= 1000) notes -= kept[start++]!.size;
    while (notes > cap) {
      let weakest = start;
      for (let index = start + 1; index < kept.length; index += 1)
        if (kept[index]!.priority < kept[weakest]!.priority) weakest = index;
      const [dropped] = kept.splice(weakest, 1);
      notes -= dropped!.size;
      dropped!.events.forEach((event) => removed.push({ eventId: event.id, reason: "density-budget" }));
    }
  }
  return kept;
}

function findEventIndex(events: readonly MusicalEvent[], timeMs: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (events[middle]!.timeMs <= timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function assignHolds(
  moments: Moment[],
  allEvents: readonly MusicalEvent[],
  grid: BeatGrid,
  profile: DifficultyProfile,
  settings: ChartSettings,
  durationMs: number | undefined,
  removed: Removal[],
): Moment[] {
  const rules = DIFFICULTY_RULES[settings.difficulty];
  const candidates: Array<{ moment: Moment; durationMs: number; score: number }> = [];
  for (const moment of moments) {
    if (moment.size !== 1) continue;
    const event = moment.events.find((item) => item.endTimeMs !== undefined) ?? moment.lead;
    const start = findEventIndex(allEvents, event.timeMs);
    const end = findEventIndex(allEvents, event.endTimeMs ?? event.timeMs);
    const raw = sustainedHoldDuration(event, allEvents.slice(start, end + 1));
    if (raw === undefined) continue;
    let endMs = moment.timeMs + raw;
    if (!grid.isEmpty) {
      const step = grid.intervalAtTime(endMs) / profile.holdSubdivision;
      endMs = grid.floor(endMs + step * 0.15, profile.holdSubdivision);
    }
    if (durationMs !== undefined) endMs = Math.min(endMs, durationMs - 30);
    const length = Math.min(MAX_HOLD_DURATION_MS, Math.round(endMs - moment.timeMs));
    if (length < Math.max(MIN_HOLD_DURATION_MS, V2_CONFIG.holds.minimumDurationMs)) continue;
    candidates.push({
      moment,
      durationMs: length,
      score: (event.pitchConfidence ?? event.confidence) * Math.sqrt(length),
    });
  }
  const allowance = Math.max(1, Math.round(rules.holdFrequencyCap * moments.length));
  candidates
    .sort((left, right) => right.score - left.score || left.moment.timeMs - right.moment.timeMs)
    .slice(0, allowance)
    .forEach(({ moment, durationMs: length }) => (moment.holdMs = length));
  if (settings.difficulty !== "easy") return moments;
  // Easy charts rest while a hold is sustained instead of asking for a second hand.
  const kept: Moment[] = [];
  let restUntil = -Infinity;
  for (const moment of moments) {
    if (moment.timeMs < restUntil) {
      moment.events.forEach((event) => removed.push({ eventId: event.id, reason: "hold-rest" }));
      continue;
    }
    kept.push(moment);
    if (moment.holdMs !== undefined) restUntil = moment.timeMs + moment.holdMs + rules.minimumGapMs;
  }
  return kept;
}

/** Mark evenly spaced single-note runs so the planner can draw them as streams, trills, or jacks. */
function detectPatterns(
  moments: Moment[],
  grid: BeatGrid,
  profile: DifficultyProfile,
  settings: ChartSettings,
): void {
  const rules = DIFFICULTY_RULES[settings.difficulty];
  let start = 0;
  const classify = (from: number, to: number) => {
    const run = moments.slice(from, to + 1);
    if (run.length < 4) return;
    const gap = run[1]!.timeMs - run[0]!.timeMs;
    const pitches = run.map((moment) => moment.pitch);
    const allPitched = pitches.every((pitch) => pitch !== undefined);
    let alternations = 0;
    let repeats = 0;
    for (let index = 1; index < run.length; index += 1) {
      const current = pitches[index];
      const previous = pitches[index - 1];
      if (current !== undefined && previous !== undefined && Math.abs(current - previous) < 0.8) repeats += 1;
      const twoBack = pitches[index - 2];
      if (
        index >= 2 &&
        current !== undefined &&
        previous !== undefined &&
        twoBack !== undefined &&
        Math.abs(current - twoBack) < 0.8 &&
        Math.abs(current - previous) >= 0.8
      )
        alternations += 1;
    }
    let kind: PatternKind = "stream";
    if (allPitched && alternations >= (run.length - 2) * 0.75) kind = "trill";
    else if (
      profile.jackGapMultiplier !== null &&
      repeats >= (run.length - 1) * 0.8 &&
      gap >= rules.minimumGapMs * profile.jackGapMultiplier
    )
      kind = "jack";
    run.forEach((moment) => (moment.pattern = kind));
  };
  for (let index = 1; index <= moments.length; index += 1) {
    const current = moments[index];
    const previous = moments[index - 1]!;
    const first = moments[start]!;
    const second = moments[start + 1];
    const runGap = second ? second.timeMs - first.timeMs : undefined;
    const gap = current ? current.timeMs - previous.timeMs : Infinity;
    const halfBeat = grid.isEmpty ? 260 : grid.intervalAtTime(previous.timeMs) * 0.55;
    const continues =
      current !== undefined &&
      current.size === 1 &&
      previous.size === 1 &&
      gap <= halfBeat &&
      (runGap === undefined || index === start + 1 || Math.abs(gap - runGap) <= runGap * 0.1);
    if (!continues) {
      classify(start, index - 1);
      start = index;
    }
  }
}

type PlanOptions = Readonly<{ movementScale: number }>;

function laneSets(size: number, laneCount: number): number[][] {
  if (size === 1) return Array.from({ length: laneCount }, (_, lane) => [lane]);
  const sets: number[][] = [];
  const recurse = (from: number, current: number[]) => {
    if (current.length === size) {
      sets.push([...current]);
      return;
    }
    for (let lane = from; lane < laneCount; lane += 1) recurse(lane + 1, [...current, lane]);
  };
  recurse(0, []);
  return sets;
}

function roleAnchor(role: MusicalEventRole, laneCount: number, lastLane: number, size: number): number {
  const middle = (laneCount - 1) / 2;
  // Hats own the right edge, so on wide layouts the low end takes the left edge as its mirror.
  if (role === "kick" || role === "bass")
    return laneCount >= 6 ? Math.round((laneCount - 1) * 0.15) : Math.max(0, Math.floor(middle) - 1);
  if (role === "snare") return Math.min(laneCount - size, Math.ceil(middle) + 1);
  if (role === "hat") return laneCount - size;
  return lastLane <= middle
    ? Math.min(laneCount - size, Math.ceil(middle) + 1)
    : Math.max(0, Math.floor(middle) - 1);
}

function runBeam(
  moments: readonly Moment[],
  settings: ChartSettings,
  profile: DifficultyProfile,
  seed: string,
  options: PlanOptions,
): { lanes: Array<readonly number[] | undefined>; unplaced: number } {
  const rules = DIFFICULTY_RULES[settings.difficulty];
  const laneCount = settings.laneCount;
  const middle = (laneCount - 1) / 2;
  const random = createDeterministicRandom(seed);
  const setsBySize = new Map<number, number[][]>();
  const movementWeight = profile.movementWeight * options.movementScale;
  // Costs are tuned in four-key lane units; wider layouts spread the same reach over more lanes.
  const widthScale = 3 / (laneCount - 1);
  const splitHands = laneCount >= 6;
  const handOf = (lane: number) => (lane < middle ? 0 : 1);
  const anchorSlack = Math.max(0, (laneCount - 4) / 4);
  const coverageWeight = 0.5 * (laneCount / 4) ** 2;
  let beams: BeamState[] = [
    {
      cost: 0,
      lastLanes: [Math.floor(laneCount / 2)],
      previousLane: Math.floor(laneCount / 2),
      direction: 1,
      lastTimeMs: -Infinity,
      handLanes: [Math.max(0, Math.floor(middle) - 1), Math.min(laneCount - 1, Math.ceil(middle) + 1)],
      handTimes: [-Infinity, -Infinity],
      laneTimes: Array.from({ length: laneCount }, () => -Infinity),
      laneHoldEnds: Array.from({ length: laneCount }, () => -Infinity),
      laneLoad: Array.from({ length: laneCount }, () => 0),
      momentIndex: -1,
    },
  ];
  let unplaced = 0;
  for (const [momentIndex, moment] of moments.entries()) {
    const size = Math.min(moment.size, laneCount);
    if (!setsBySize.has(size)) setsBySize.set(size, laneSets(size, laneCount));
    const next: BeamState[] = [];
    for (const state of beams) {
      const lastLane = state.lastLanes[state.lastLanes.length - 1]!;
      const elapsed = moment.timeMs - state.lastTimeMs;
      const decay = Number.isFinite(elapsed) ? Math.pow(0.5, elapsed / BALANCE_HALF_LIFE_MS) : 0;
      const pitchMovement =
        moment.pitch !== undefined && state.previousPitch !== undefined
          ? moment.pitch - state.previousPitch
          : 0;
      const frequencyTarget = Math.round(
        (((moment.pitch ?? (moment.role === "kick" || moment.role === "bass" ? 45 : 72)) - 36) / 60) *
          (laneCount - 1),
      );
      const melodicTarget =
        lastLane + Math.sign(pitchMovement) * Math.min(2, Math.floor(Math.abs(pitchMovement) / 4) + 1);
      const target = Math.max(
        0,
        Math.min(
          laneCount - size,
          settings.laneStyle === "frequency"
            ? frequencyTarget
            : moment.pitch !== undefined && pitchMovement !== 0
              ? melodicTarget
              : roleAnchor(moment.role, laneCount, lastLane, size),
        ),
      );
      for (const lanes of setsBySize.get(size)!) {
        let valid = true;
        for (const lane of lanes) {
          if (
            moment.timeMs - state.laneTimes[lane]! < rules.minimumGapMs ||
            moment.timeMs < state.laneHoldEnds[lane]! + rules.minimumGapMs
          ) {
            valid = false;
            break;
          }
        }
        if (!valid) continue;
        const center = lanes.reduce((sum, lane) => sum + lane, 0) / lanes.length;
        const lead = lanes[0]!;
        const hand = handOf(lead);
        const travelFrom = splitHands && size === 1 ? state.handLanes[hand] : lastLane;
        const travelElapsed = splitHands && size === 1 ? moment.timeMs - state.handTimes[hand] : elapsed;
        const movement = Math.abs(center - travelFrom) * widthScale;
        const comfortable = Math.max(1, Math.floor(travelElapsed / profile.travelMsPerLane));
        const rapid = Math.max(0, movement - comfortable);
        let cost = state.cost + movement * movementWeight + rapid * rapid * 2.4;
        cost += Math.max(0, Math.abs(lead - target) - anchorSlack) * 0.35;
        // Two hands make wide alternation cheap, but a fast leap across most of the highway still reads badly.
        if (splitHands && elapsed < 110 && Math.abs(lead - lastLane) > Math.ceil(laneCount / 2)) cost += 4;

        const fast = Number.isFinite(elapsed) ? Math.max(0, (260 - elapsed) / 260) : 0;
        if (size === 1) {
          const repeated = lead === lastLane;
          if (moment.pattern === "jack") cost += repeated ? -0.6 : 0.5;
          else if (repeated) cost += (settings.laneStyle === "alternating" ? 3.2 : 1.7) * (1 + fast);
          if (moment.pattern === "stream" && state.lastLanes.length === 1) {
            const step = lead - lastLane;
            const atEdge = lastLane === 0 || lastLane === laneCount - 1;
            const desired = atEdge ? (lastLane === 0 ? 1 : -1) : state.direction;
            cost += step === desired ? -0.4 : Math.abs(step) === 1 ? 0.3 : 0.9;
          }
          if (moment.pattern === "trill")
            cost += lead === state.previousLane && lead !== lastLane ? -0.9 : 0.6;
          if (pitchMovement !== 0 && settings.laneStyle !== "frequency")
            cost += Math.sign(lead - lastLane) === Math.sign(pitchMovement) ? -1.1 : 1.2;
          if (settings.laneStyle === "alternating") {
            const sameHand = lead < middle === lastLane < middle && lead !== middle && lastLane !== middle;
            if (sameHand) cost += 1.4;
          }
        } else {
          const hands = new Set(lanes.map((lane) => (lane < middle ? "l" : lane > middle ? "r" : "c")));
          if (hands.size < 2) cost += 0.4;
          if (lanes.some((lane, index) => index > 0 && lane - lanes[index - 1]! === 1)) cost += 0.15;
        }

        const laneLoad = state.laneLoad.map((load) => load * decay);
        // Coverage: lanes already above the mean recent load cost more, starved lanes cost less.
        const meanLoad = laneLoad.reduce((sum, load) => sum + load, 0) / laneCount;
        if (meanLoad > 0.5)
          for (const lane of lanes) {
            cost += (laneLoad[lane]! / meanLoad - 1) * coverageWeight;
          }
        for (const lane of lanes) laneLoad[lane]! += 1;
        let left = 0;
        let right = 0;
        let total = 0;
        laneLoad.forEach((load, lane) => {
          total += load;
          if (lane < middle) left += load;
          else if (lane > middle) right += load;
        });
        cost += (Math.abs(left - right) / Math.max(1, left + right)) * 1.1;
        cost += (lanes.reduce((sum, lane) => sum + laneLoad[lane]!, 0) / Math.max(1, total)) * 1.4;
        cost += random() * 1e-6;

        const laneTimes = [...state.laneTimes];
        const laneHoldEnds = [...state.laneHoldEnds];
        for (const lane of lanes) {
          laneTimes[lane] = moment.timeMs;
          if (moment.holdMs !== undefined && lanes.length === 1)
            laneHoldEnds[lane] = moment.timeMs + moment.holdMs;
        }
        const handLanes: [number, number] = [...state.handLanes];
        const handTimes: [number, number] = [...state.handTimes];
        for (const lane of lanes) {
          handLanes[handOf(lane)] = lane;
          handTimes[handOf(lane)] = moment.timeMs;
        }
        const step = size === 1 ? Math.sign(lead - lastLane) : 0;
        next.push({
          cost,
          lastLanes: lanes,
          previousLane: size === 1 ? lastLane : state.previousLane,
          direction: step !== 0 ? step : state.direction,
          lastTimeMs: moment.timeMs,
          handLanes,
          handTimes,
          ...(moment.pitch !== undefined
            ? { previousPitch: moment.pitch }
            : state.previousPitch !== undefined
              ? { previousPitch: state.previousPitch }
              : {}),
          laneTimes,
          laneHoldEnds,
          laneLoad,
          parent: state,
          lanes,
          momentIndex,
        });
      }
    }
    if (next.length === 0) {
      unplaced += 1;
      continue;
    }
    beams = next.sort((left, right) => left.cost - right.cost).slice(0, BEAM_WIDTH);
  }
  const lanes: Array<readonly number[] | undefined> = Array.from({ length: moments.length }, () => undefined);
  for (let state: BeamState | undefined = beams[0]; state?.parent; state = state.parent)
    lanes[state.momentIndex] = state.lanes;
  return { lanes, unplaced };
}

function isPlayable(
  moments: readonly Moment[],
  lanes: ReadonlyArray<readonly number[] | undefined>,
  laneCount: number,
  minimumGapMs: number,
): boolean {
  const laneTimes = Array.from({ length: laneCount }, () => -Infinity);
  const holdEnds = Array.from({ length: laneCount }, () => -Infinity);
  for (const [index, moment] of moments.entries()) {
    const chosen = lanes[index];
    if (!chosen) continue;
    for (const lane of chosen) {
      if (moment.timeMs - laneTimes[lane]! < minimumGapMs || moment.timeMs < holdEnds[lane]! + minimumGapMs)
        return false;
      laneTimes[lane] = moment.timeMs;
      if (moment.holdMs !== undefined && chosen.length === 1) holdEnds[lane] = moment.timeMs + moment.holdMs;
    }
  }
  return true;
}

/**
 * Repeated musical bars should look repeated. Bars are fingerprinted by rhythm position,
 * chord size, and melodic contour; a recurrence reuses its first occurrence's lanes
 * (mirrored when it returns in a later section) whenever that stays playable.
 */
function repeatPhrases(
  moments: readonly Moment[],
  lanes: Array<readonly number[] | undefined>,
  beats: readonly BeatMarker[],
  grid: BeatGrid,
  sections: readonly SongSection[],
  settings: ChartSettings,
): number {
  if (grid.isEmpty || !beats.some((beat) => beat.barIndex !== undefined)) return 0;
  const barStart = new Map<number, number>();
  beats.forEach((beat, index) => {
    if (beat.barIndex !== undefined && !barStart.has(beat.barIndex)) barStart.set(beat.barIndex, index);
  });
  const bars = new Map<number, number[]>();
  moments.forEach((moment, index) => {
    if (!lanes[index]) return;
    const beat =
      beats[
        Math.max(
          0,
          Math.min(beats.length - 1, moment.beatIndex >= 0 ? moment.beatIndex : grid.beatAt(moment.timeMs)),
        )
      ];
    if (beat?.barIndex === undefined) return;
    bars.set(beat.barIndex, [...(bars.get(beat.barIndex) ?? []), index]);
  });
  const references = new Map<
    string,
    Readonly<{ indices: number[]; sectionStart: number; occurrences: number }>
  >();
  const rules = DIFFICULTY_RULES[settings.difficulty];
  let repeated = 0;
  for (const bar of [...bars.keys()].sort((left, right) => left - right)) {
    const indices = bars.get(bar)!;
    if (indices.length < 3) continue;
    const startBeat = barStart.get(bar) ?? 0;
    let previousPitch: number | undefined;
    const signature = indices
      .map((index) => {
        const moment = moments[index]!;
        const position = Math.round((grid.position(moment.timeMs) - startBeat) * 4);
        const contour =
          moment.pitch !== undefined && previousPitch !== undefined
            ? Math.sign(Math.round(moment.pitch - previousPitch))
            : moment.role.charAt(0);
        if (moment.pitch !== undefined) previousPitch = moment.pitch;
        return `${position}/${moment.size}/${contour}/${moment.holdMs !== undefined ? "h" : "t"}`;
      })
      .join(",");
    const sectionStart = sectionAt(sections, moments[indices[0]!]!.timeMs)?.startMs ?? -1;
    const reference = references.get(signature);
    if (!reference) {
      references.set(signature, { indices, sectionStart, occurrences: 0 });
      continue;
    }
    const occurrence = reference.occurrences + 1;
    references.set(signature, { ...reference, occurrences: occurrence });
    const mirror = reference.sectionStart !== sectionStart && occurrence % 2 === 1;
    const previous = indices.map((index) => lanes[index]);
    indices.forEach((index, position) => {
      const source = lanes[reference.indices[position]!];
      if (source)
        lanes[index] = mirror
          ? source.map((lane) => settings.laneCount - 1 - lane).sort((left, right) => left - right)
          : source;
    });
    if (isPlayable(moments, lanes, settings.laneCount, rules.minimumGapMs)) repeated += 1;
    else indices.forEach((index, position) => (lanes[index] = previous[position]));
  }
  return repeated;
}

function rapidJumpCount(
  moments: readonly Moment[],
  lanes: ReadonlyArray<readonly number[] | undefined>,
  laneCount: number,
) {
  let count = 0;
  let previous: { time: number; lane: number } | undefined;
  moments.forEach((moment, index) => {
    const chosen = lanes[index];
    if (!chosen) return;
    if (
      previous &&
      moment.timeMs - previous.time < 110 &&
      Math.abs(chosen[0]! - previous.lane) > Math.ceil(laneCount / 2)
    )
      count += 1;
    previous = { time: moment.timeMs, lane: chosen[chosen.length - 1]! };
  });
  return count;
}

function prepareMoments(
  events: readonly MusicalEvent[],
  beats: readonly BeatMarker[],
  sections: readonly SongSection[],
  settings: ChartSettings,
  durationMs: number | undefined,
) {
  const profile = V2_DIFFICULTY[settings.difficulty];
  const grid = new BeatGrid(beats);
  const removed: Removal[] = [];
  const quantized: Quantized[] = [];
  for (const event of events) {
    const result = quantizeEvent(event, grid, beats, sections, profile, settings);
    if (result && (durationMs === undefined || result.timeMs < durationMs)) quantized.push(result);
    else removed.push({ eventId: event.id, reason: "off-grid" });
  }
  const { moments: rawMoments, reducedChords } = buildMoments(quantized, settings, profile);
  const budgeted = applyDensityBudget(rawMoments, grid, sections, profile, settings, removed);
  const sortedEvents = [...events].sort((left, right) => left.timeMs - right.timeMs);
  const moments = assignHolds(budgeted, sortedEvents, grid, profile, settings, durationMs, removed);
  detectPatterns(moments, grid, profile, settings);
  return { moments, removed, reducedChords, grid, profile };
}

/** Debug helper: which detector events survive selection for these settings, and why others did not. */
export function selectEvents(
  events: readonly MusicalEvent[],
  settings: ChartSettings,
  sections: readonly SongSection[],
  beats: readonly BeatMarker[] = [],
): Readonly<{ selected: readonly MusicalEvent[]; removed: readonly Removal[] }> {
  const { moments, removed } = prepareMoments(events, beats, sections, settings, undefined);
  return { selected: moments.flatMap((moment) => moment.events), removed };
}

export function planLanes(
  events: readonly MusicalEvent[],
  beats: readonly BeatMarker[],
  sections: readonly SongSection[],
  settings: ChartSettings,
  seed: string,
  durationMs?: number,
): LanePlan {
  const { moments, removed, reducedChords, grid, profile } = prepareMoments(
    events,
    beats,
    sections,
    settings,
    durationMs,
  );
  let best = runBeam(moments, settings, profile, seed, { movementScale: 1 });
  let passes = 1;
  // Feedback loop: if the planner still produced rapid cross-highway jumps, re-plan with
  // stronger travel penalties and keep whichever pass is more comfortable.
  const jumpLimit = Math.max(2, moments.length * 0.04);
  for (const movementScale of [1.7, 2.6]) {
    if (rapidJumpCount(moments, best.lanes, settings.laneCount) <= jumpLimit) break;
    const retry = runBeam(moments, settings, profile, seed, { movementScale });
    passes += 1;
    if (
      rapidJumpCount(moments, retry.lanes, settings.laneCount) <
      rapidJumpCount(moments, best.lanes, settings.laneCount)
    )
      best = retry;
  }
  const lanes = best.lanes;
  const repeatedBars = repeatPhrases(moments, lanes, beats, grid, sections, settings);
  const patternCounts: Record<PatternKind, number> = { stream: 0, trill: 0, jack: 0, free: 0 };
  const notes: ChartNote[] = [];
  moments.forEach((moment, index) => {
    const chosen = lanes[index];
    if (!chosen) {
      moment.events.forEach((event) => removed.push({ eventId: event.id, reason: "lane-conflict" }));
      return;
    }
    patternCounts[moment.pattern] += chosen.length;
    for (const lane of chosen) {
      const strength = Math.max(0, Math.min(1, moment.lead.strength));
      const id = `v2-${notes.length}-${moment.timeMs}-${lane}`;
      notes.push(
        moment.holdMs !== undefined && chosen.length === 1
          ? Object.freeze({
              id,
              kind: "hold",
              timeMs: moment.timeMs,
              lane,
              durationMs: moment.holdMs,
              strength,
            })
          : Object.freeze({ id, kind: "tap", timeMs: moment.timeMs, lane, strength }),
      );
    }
  });
  notes.sort((left, right) => left.timeMs - right.timeMs || left.lane - right.lane);
  return {
    notes,
    removed,
    movedForConflict: best.unplaced,
    reducedChords,
    patternCounts,
    repeatedBars,
    passes,
  };
}
