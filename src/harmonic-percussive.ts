/**
 * Streaming median-filter harmonic/percussive separation (Fitzgerald 2010).
 *
 * Sustained tones are smooth along time; drum hits are smooth along frequency. A time median
 * over `TIME_KERNEL` frames estimates the harmonic part of each bin, a frequency median over
 * `FREQUENCY_KERNEL` bins estimates the percussive part, and soft Wiener masks split the
 * magnitude between them. Only a ring of `TIME_KERNEL` frames is kept, so memory is constant;
 * output for a frame is produced `HPSS_DELAY_FRAMES` frames after it is pushed.
 */
export const HPSS_TIME_KERNEL = 9;
export const HPSS_FREQUENCY_KERNEL = 9;
export const HPSS_DELAY_FRAMES = (HPSS_TIME_KERNEL - 1) / 2;

export type HpssFlux = Readonly<{
  /** Index of the frame this flux belongs to. */
  frame: number;
  harmonicFlux: number;
  percussiveFlux: number;
  /** Share of this frame's energy assigned to the harmonic part, 0 to 1. */
  harmonicShare: number;
}>;

/** Median of nine values with a 19-exchange sorting network (Paeth / Devillard opt_med9). */
function median9(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  p4: number,
  p5: number,
  p6: number,
  p7: number,
  p8: number,
): number {
  let t: number;
  if (p1 > p2) { t = p1; p1 = p2; p2 = t; }
  if (p4 > p5) { t = p4; p4 = p5; p5 = t; }
  if (p7 > p8) { t = p7; p7 = p8; p8 = t; }
  if (p0 > p1) { t = p0; p0 = p1; p1 = t; }
  if (p3 > p4) { t = p3; p3 = p4; p4 = t; }
  if (p6 > p7) { t = p6; p6 = p7; p7 = t; }
  if (p1 > p2) { t = p1; p1 = p2; p2 = t; }
  if (p4 > p5) { t = p4; p4 = p5; p5 = t; }
  if (p7 > p8) { t = p7; p7 = p8; p8 = t; }
  if (p0 > p3) p3 = p0;
  if (p5 > p8) p5 = p8;
  if (p4 > p7) { t = p4; p4 = p7; p7 = t; }
  if (p3 > p6) p6 = p3;
  if (p1 > p4) p4 = p1;
  if (p2 > p5) p2 = p5;
  if (p4 > p7) p4 = p7;
  if (p4 > p2) { t = p4; p4 = p2; p2 = t; }
  if (p6 > p4) p4 = p6;
  return p4 > p2 ? p2 : p4;
}

export class StreamingHpss {
  private readonly ring: Float32Array;
  private readonly previousHarmonic: Float32Array;
  private readonly previousPercussive: Float32Array;
  private readonly harmonic: Float32Array;
  private readonly percussive: Float32Array;
  private pushed = 0;

  readonly bins: number;
  private readonly pooled: Float32Array;

  /**
   * The first `sourceBins` magnitudes of each frame are summed in groups of `pool` and then
   * separated; higher bins are ignored. Pooling keeps the median filters cheap, and drums and
   * tones still separate cleanly at a few tens of hertz per band.
   */
  constructor(
    readonly sourceBins: number,
    readonly pool = 3,
  ) {
    const bins = Math.ceil(sourceBins / pool);
    this.bins = bins;
    this.pooled = new Float32Array(bins);
    this.ring = new Float32Array(HPSS_TIME_KERNEL * bins);
    this.previousHarmonic = new Float32Array(bins);
    this.previousPercussive = new Float32Array(bins);
    this.harmonic = new Float32Array(bins);
    this.percussive = new Float32Array(bins);
  }

  /** Push one frame of magnitudes; returns the separated flux of the frame `HPSS_DELAY_FRAMES` back. */
  push(magnitudes: Float32Array): HpssFlux | undefined {
    const { bins, pool, pooled, sourceBins } = this;
    for (let band = 0; band < bins; band += 1) {
      let sum = 0;
      const end = Math.min(sourceBins, (band + 1) * pool);
      for (let bin = band * pool; bin < end; bin += 1) sum += magnitudes[bin]!;
      pooled[band] = sum;
    }
    return this.pushHeld(pooled);
  }

  private pushPooled(pooled: Float32Array): void {
    const bins = this.bins;
    if (this.pushed === 0)
      // Pad the past with the first frame so the opening is not mistaken for one big attack.
      for (let slot = 0; slot < HPSS_TIME_KERNEL; slot += 1) this.ring.set(pooled, slot * bins);
    else this.ring.set(pooled, (this.pushed % HPSS_TIME_KERNEL) * bins);
    this.pushed += 1;
  }

  private pushHeld(pooled: Float32Array): HpssFlux | undefined {
    this.pushPooled(pooled);
    const center = this.pushed - 1 - HPSS_DELAY_FRAMES;
    return center >= 0 ? this.separate(center) : undefined;
  }

  /** Emit the last `HPSS_DELAY_FRAMES` frames by holding the final frame. */
  flush(): HpssFlux[] {
    if (this.pushed === 0) return [];
    const last = this.ring.slice(((this.pushed - 1) % HPSS_TIME_KERNEL) * this.bins, ((this.pushed - 1) % HPSS_TIME_KERNEL + 1) * this.bins);
    const output: HpssFlux[] = [];
    const target = this.pushed + HPSS_DELAY_FRAMES;
    const realFrames = this.pushed;
    while (this.pushed < target) {
      const result = this.pushHeld(last);
      if (result && result.frame < realFrames) output.push(result);
    }
    return output;
  }

  private separate(frame: number): HpssFlux {
    const { bins, ring, harmonic, percussive } = this;
    const c = (frame % HPSS_TIME_KERNEL) * bins;
    const last = bins - 1;
    const at = (bin: number) => ring[c + (bin < 0 ? 0 : bin > last ? last : bin)]!;
    let harmonicEnergy = 0;
    let totalEnergy = 0;
    for (let bin = 0; bin < bins; bin += 1) {
      const harmonicEstimate = median9(
        ring[bin]!,
        ring[bins + bin]!,
        ring[2 * bins + bin]!,
        ring[3 * bins + bin]!,
        ring[4 * bins + bin]!,
        ring[5 * bins + bin]!,
        ring[6 * bins + bin]!,
        ring[7 * bins + bin]!,
        ring[8 * bins + bin]!,
      );
      const percussiveEstimate =
        bin >= 4 && bin <= last - 4
          ? median9(
              ring[c + bin - 4]!,
              ring[c + bin - 3]!,
              ring[c + bin - 2]!,
              ring[c + bin - 1]!,
              ring[c + bin]!,
              ring[c + bin + 1]!,
              ring[c + bin + 2]!,
              ring[c + bin + 3]!,
              ring[c + bin + 4]!,
            )
          : median9(at(bin - 4), at(bin - 3), at(bin - 2), at(bin - 1), at(bin), at(bin + 1), at(bin + 2), at(bin + 3), at(bin + 4));
      const magnitude = ring[c + bin]!;
      const h2 = harmonicEstimate * harmonicEstimate;
      const p2 = percussiveEstimate * percussiveEstimate;
      const total = h2 + p2;
      const harmonicMask = total > 1e-20 ? h2 / total : 0.5;
      const harmonicPart = magnitude * harmonicMask;
      // Store log-compressed parts: log is monotonic, so SuperFlux's max filter works on logs directly.
      harmonic[bin] = Math.log1p(harmonicPart * 100);
      percussive[bin] = Math.log1p((magnitude - harmonicPart) * 100);
      harmonicEnergy += harmonicPart * harmonicPart;
      totalEnergy += magnitude * magnitude;
    }
    const harmonicFlux = superFlux(harmonic, this.previousHarmonic) / bins;
    const percussiveFlux = superFlux(percussive, this.previousPercussive) / bins;
    this.previousHarmonic.set(harmonic);
    this.previousPercussive.set(percussive);
    return {
      frame,
      harmonicFlux,
      percussiveFlux,
      harmonicShare: totalEnergy > 1e-20 ? harmonicEnergy / totalEnergy : 0,
    };
  }
}

/** Positive log-magnitude rise against a ±1-bin maximum of the previous frame (SuperFlux). */
function superFlux(currentLog: Float32Array, previousLog: Float32Array): number {
  const last = currentLog.length - 1;
  let sum = 0;
  for (let bin = 0; bin <= last; bin += 1) {
    let reference = previousLog[bin]!;
    if (bin > 0 && previousLog[bin - 1]! > reference) reference = previousLog[bin - 1]!;
    if (bin < last && previousLog[bin + 1]! > reference) reference = previousLog[bin + 1]!;
    const rise = currentLog[bin]! - reference;
    if (rise > 0) sum += rise;
  }
  return sum;
}
