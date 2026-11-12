import { BEAT_MODEL } from "./beat-model-weights.ts";

/** Band order the model was trained on. */
export const BEAT_MODEL_BANDS = ["broadband", "bass", "midrange", "highFrequency", "harmonic", "percussive"] as const;
export type BeatModelBand = (typeof BEAT_MODEL_BANDS)[number];

/**
 * Learned beat and downbeat activation per analysis frame, from Aurora's band envelopes.
 *
 * A small two-layer network (weights in beat-model-weights.ts, trained offline on songs with
 * annotated beats and bars) reads each band around the frame, about +-2 s with dense
 * samples near the frame, so it sees the bar's kick/snare pattern rather than one attack.
 * Features must match the training script exactly: log1p(envelope / song mean) per band at each
 * offset (zero outside the song), then each band's contrast against a zero-padded box mean.
 */
export function beatActivation(envelopes: Readonly<Record<BeatModelBand, Float32Array>>): {
  beat: Float32Array;
  downbeat: Float32Array;
} {
  const length = envelopes.percussive.length;
  const bands = BEAT_MODEL_BANDS.length;
  const x = BEAT_MODEL_BANDS.map((name) => {
    const env = envelopes[name];
    let mean = 0;
    for (let index = 0; index < length; index += 1) mean += env[index] ?? 0;
    mean = mean / Math.max(1, length) + 1e-9;
    return Float32Array.from({ length }, (_, index) => Math.log1p((env[index] ?? 0) / mean));
  });
  // Contrast: value minus a zero-padded box mean (numpy convolve mode="same").
  const half = BEAT_MODEL.contrastHalfWindow;
  const width = 2 * half + 1;
  const contrast = x.map((row) => {
    const prefix = new Float64Array(length + 1);
    for (let index = 0; index < length; index += 1) prefix[index + 1] = prefix[index]! + row[index]!;
    return Float32Array.from({ length }, (_, index) => {
      const lo = Math.max(0, index - half);
      const hi = Math.min(length, index + half + 1);
      return row[index]! - (prefix[hi]! - prefix[lo]!) / width;
    });
  });

  const { offsets, inputs, hidden, w1, b1, w2, b2 } = BEAT_MODEL;
  const features = new Float32Array(inputs);
  const activation = new Float32Array(hidden);
  const beat = new Float32Array(length);
  const downbeat = new Float32Array(length);
  for (let frame = 0; frame < length; frame += 1) {
    let feature = 0;
    for (const offset of offsets) {
      const at = frame + offset;
      for (let band = 0; band < bands; band += 1)
        features[feature++] = at >= 0 && at < length ? x[band]![at]! : 0;
    }
    for (let band = 0; band < bands; band += 1) features[feature++] = contrast[band]![frame]!;
    for (let unit = 0; unit < hidden; unit += 1) activation[unit] = b1[unit]!;
    for (let input = 0; input < inputs; input += 1) {
      const value = features[input]!;
      if (value === 0) continue;
      const row = input * hidden;
      for (let unit = 0; unit < hidden; unit += 1) activation[unit]! += value * w1[row + unit]!;
    }
    let zBeat = b2[0]!;
    let zDown = b2[1]!;
    for (let unit = 0; unit < hidden; unit += 1) {
      const h = Math.max(0, activation[unit]!);
      zBeat += h * w2[unit * 2]!;
      zDown += h * w2[unit * 2 + 1]!;
    }
    beat[frame] = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, zBeat))));
    downbeat[frame] = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, zDown))));
  }
  return { beat, downbeat };
}
