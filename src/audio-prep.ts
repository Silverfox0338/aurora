import { throwIfAborted } from "./audio.ts";

export type AnalysisChannels = Readonly<{
  mono: Float32Array;
}>;

function sampleLinear(input: Float32Array, position: number): number {
  const left = Math.floor(position);
  const fraction = position - left;
  const a = input[Math.min(input.length - 1, left)] ?? 0;
  const b = input[Math.min(input.length - 1, left + 1)] ?? a;
  return a + (b - a) * fraction;
}

/** Area averaging provides the anti-aliasing integration missing from nearest-neighbor reduction. */
export function resampleAudio(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
  signal?: AbortSignal,
): Float32Array {
  if (sourceRate <= 0 || targetRate <= 0) throw new Error("Audio sample rates must be positive.");
  if (sourceRate === targetRate) return new Float32Array(input);
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.max(0, Math.floor(input.length / ratio)));
  if (ratio < 1) {
    for (let index = 0; index < output.length; index += 1) {
      if ((index & 8191) === 0) throwIfAborted(signal);
      output[index] = sampleLinear(input, index * ratio);
    }
    return output;
  }
  for (let index = 0; index < output.length; index += 1) {
    if ((index & 8191) === 0) throwIfAborted(signal);
    const start = index * ratio;
    const end = Math.min(input.length, (index + 1) * ratio);
    const first = Math.floor(start);
    const last = Math.ceil(end);
    let weighted = 0;
    let weight = 0;
    for (let sourceIndex = first; sourceIndex < last; sourceIndex += 1) {
      const overlap = Math.max(0, Math.min(end, sourceIndex + 1) - Math.max(start, sourceIndex));
      weighted += (input[sourceIndex] ?? 0) * overlap;
      weight += overlap;
    }
    output[index] = weight > 0 ? weighted / weight : 0;
  }
  return output;
}

export function prepareAnalysisChannels(
  channels: readonly Float32Array[],
  sourceRate: number,
  targetRate: number,
  signal?: AbortSignal,
): AnalysisChannels {
  if (channels.length === 0 || (channels[0]?.length ?? 0) === 0) return { mono: new Float32Array() };
  const length = channels[0]!.length;
  const mono = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    if ((index & 8191) === 0) throwIfAborted(signal);
    let sum = 0;
    for (const channel of channels) sum += channel[index] ?? 0;
    mono[index] = sum / channels.length;
  }
  return { mono: resampleAudio(mono, sourceRate, targetRate, signal) };
}
