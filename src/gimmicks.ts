import { createDeterministicRandom } from "./prng.ts";
import type { ChartGimmick, ChartSettings, GimmickKind } from "./chart.ts";

import type { BeatMarker, SectionLabel, SongSection } from "./types.ts";

/** Bars at the start and end of a song that never carry a gimmick. */
const LEAD_IN_BARS = 8;
const LEAD_OUT_BARS = 4;
/** Clean bars required between two gimmicks. */
const REST_BARS = 2;
/** At most one gimmick starts in any window this long. */
const MIN_START_SPACING_MS = 30_000;

const LENGTH_BARS: Readonly<Record<GimmickKind, readonly [number, number]>> = {
  flip: [4, 16],
  hidden: [4, 8],
  shuffle: [4, 8],
};

/** Gimmicks that suit each kind of section, best fit first. */
const PREFERENCES: Partial<Record<SectionLabel, readonly GimmickKind[]>> = {
  chorus: ["flip", "shuffle", "hidden"],
  drop: ["flip", "shuffle", "hidden"],
  build: ["shuffle", "flip", "hidden"],
  verse: ["hidden", "shuffle", "flip"],
  break: ["hidden", "flip", "shuffle"],
};

/** Best fit for the section, but never the same gimmick twice in a row and the least used of the top two. */
function kindFor(
  label: SectionLabel | undefined,
  previous: GimmickKind | undefined,
  used: Readonly<Record<GimmickKind, number>>,
): GimmickKind | undefined {
  const options = label ? PREFERENCES[label]?.filter((kind) => kind !== previous) : undefined;
  if (!options || options.length === 0) return undefined;
  const [first, second] = options;
  return second !== undefined && used[second] < used[first!] ? second : first;
}

/** Mirror, neighbour swaps, or swapped hands: readable reorderings rather than a full scramble. */
function shuffleOrder(laneCount: number, random: () => number): number[] {
  const lanes = Array.from({ length: laneCount }, (_, lane) => lane);
  const style = Math.floor(random() * 3);
  if (style === 0) return lanes.map((lane) => laneCount - 1 - lane);
  if (style === 1)
    return lanes.map((lane) => (lane % 2 === 0 ? Math.min(laneCount - 1, lane + 1) : lane - 1));
  const half = Math.floor(laneCount / 2);
  const middle = laneCount % 2 === 1 ? half : -1;
  return lanes.map((lane) =>
    lane === middle ? lane : lane < half ? lane + laneCount - half : lane - (laneCount - half),
  );
}

/**
 * Places Extreme gimmicks on musical section changes. Deterministic for a given analysis,
 * chart, and seed; returns an empty list for every other difficulty.
 */
export function placeGimmicks(
  sections: readonly SongSection[],
  beats: readonly BeatMarker[],
  settings: ChartSettings,
  seed: string,
  durationMs: number,
): ChartGimmick[] {
  if (settings.difficulty !== "extreme") return [];
  const bars = beats.filter((beat) => beat.isDownbeat).map((beat) => Math.round(beat.timeMs));
  if (bars.length < LEAD_IN_BARS + LEAD_OUT_BARS + 4) return [];
  const random = createDeterministicRandom(`${seed}:gimmicks`);
  const firstAllowed = bars[LEAD_IN_BARS]!;
  const lastAllowed = bars[bars.length - 1 - LEAD_OUT_BARS]!;
  const gimmicks: ChartGimmick[] = [];
  let previousEnd = -Infinity;
  let previousStart = -Infinity;
  const used: Record<GimmickKind, number> = { flip: 0, hidden: 0, shuffle: 0 };
  for (const section of sections) {
    const kind = kindFor(section.label, gimmicks.at(-1)?.kind, used);
    if (!kind) continue;
    const [minimumBars, maximumBars] = LENGTH_BARS[kind];
    const earliest = Math.max(section.startMs, firstAllowed);
    let startBar = bars.findIndex((time) => time >= earliest);
    if (startBar < 0) continue;
    // Respect rest bars after the previous gimmick and the start spacing.
    while (
      startBar < bars.length &&
      (bars[startBar]! < previousStart + MIN_START_SPACING_MS ||
        bars.slice(0, startBar).filter((time) => time >= previousEnd).length < REST_BARS)
    )
      startBar += 1;
    const sectionEnd = Math.min(section.endMs, lastAllowed);
    let endBar = Math.min(startBar + maximumBars, bars.length - 1);
    while (endBar > startBar && bars[endBar]! > sectionEnd) endBar -= 1;
    if (startBar >= bars.length || endBar - startBar < minimumBars) continue;
    const startMs = bars[startBar]!;
    const endMs = Math.min(bars[endBar]!, durationMs);
    const id = `g${gimmicks.length}-${kind}-${startMs}`;
    gimmicks.push(
      kind === "flip"
        ? { id, kind, startMs, endMs }
        : kind === "hidden"
          ? { id, kind, startMs, endMs, fadeFromMilli: 450 }
          : { id, kind, startMs, endMs, order: shuffleOrder(settings.laneCount, random) },
    );
    used[kind] += 1;
    previousStart = startMs;
    previousEnd = endMs;
  }
  return gimmicks;
}
