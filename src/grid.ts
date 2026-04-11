import type { BeatMarker } from "./types.ts";

export type GridSnap = Readonly<{
  timeMs: number;
  /** Absolute distance between the requested time and the grid point. */
  distanceMs: number;
  beatIndex: number;
  /** Position within the beat as a fraction in [0, 1). */
  fraction: number;
  /** 0 = beat, 1 = half beat, 2 = third or quarter, 3 = finer. Lower is metrically stronger. */
  level: number;
  intervalMs: number;
}>;

function metricLevel(step: number, subdivision: number): number {
  if (step === 0) return 0;
  if (subdivision % 2 === 0 && step * 2 === subdivision) return 1;
  if (subdivision === 3 || subdivision === 4 || (subdivision === 6 && step % 2 === 0)) return 2;
  return 3;
}

/**
 * Beat-relative time lookups over a drifting beat list. Every interval is local to its
 * own beat pair so grids stay aligned when a performance speeds up or slows down.
 */
export class BeatGrid {
  readonly times: Float64Array;

  constructor(readonly beats: readonly BeatMarker[]) {
    this.times = Float64Array.from(beats, (beat) => beat.timeMs);
  }

  get isEmpty(): boolean {
    return this.times.length < 2;
  }

  /** Index of the last beat at or before `timeMs`, clamped to the valid range. */
  beatAt(timeMs: number): number {
    const times = this.times;
    if (times.length === 0) return -1;
    let low = 0;
    let high = times.length - 1;
    if (timeMs <= times[0]!) return 0;
    if (timeMs >= times[high]!) return high;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (times[middle]! <= timeMs) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  intervalAt(beatIndex: number): number {
    const times = this.times;
    if (times.length < 2) return 500;
    const index = Math.max(0, Math.min(times.length - 2, beatIndex));
    return times[index + 1]! - times[index]!;
  }

  intervalAtTime(timeMs: number): number {
    return this.intervalAt(this.beatAt(timeMs));
  }

  /** Snap to the nearest point of an n-per-beat grid. */
  snap(timeMs: number, subdivision: number): GridSnap | undefined {
    if (this.isEmpty) return undefined;
    const beatIndex = this.beatAt(timeMs);
    let best: GridSnap | undefined;
    for (let index = Math.max(0, beatIndex - 1); index <= beatIndex + 1; index += 1) {
      const start = this.times[Math.min(index, this.times.length - 1)]!;
      const interval = this.intervalAt(index);
      const base = index >= this.times.length ? start + interval * (index - this.times.length + 1) : start;
      const step = interval / subdivision;
      const rawStep = Math.round((timeMs - base) / step);
      const clampedStep = Math.max(0, Math.min(subdivision, rawStep));
      const gridTime = base + clampedStep * step;
      const distanceMs = Math.abs(gridTime - timeMs);
      if (!best || distanceMs < best.distanceMs) {
        const wraps = clampedStep === subdivision;
        const normalized = wraps ? 0 : clampedStep;
        best = {
          timeMs: gridTime,
          distanceMs,
          beatIndex: wraps ? index + 1 : index,
          fraction: normalized / subdivision,
          level: metricLevel(normalized, subdivision),
          intervalMs: interval,
        };
      }
    }
    return best;
  }

  /** Largest grid point at or before `timeMs`. */
  floor(timeMs: number, subdivision: number): number {
    if (this.isEmpty) return timeMs;
    const beatIndex = this.beatAt(timeMs);
    const start = this.times[beatIndex]!;
    const step = this.intervalAt(beatIndex) / subdivision;
    if (timeMs < start) return timeMs;
    return start + Math.floor((timeMs - start) / step + 1e-6) * step;
  }

  /** Continuous beat position, e.g. 12.5 is halfway between beats 12 and 13. */
  position(timeMs: number): number {
    if (this.isEmpty) return timeMs / 500;
    const beatIndex = this.beatAt(timeMs);
    return beatIndex + (timeMs - this.times[beatIndex]!) / this.intervalAt(beatIndex);
  }
}
