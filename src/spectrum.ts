import { throwIfAborted } from "./audio.ts";

import { applyWindow, binForFrequency, createHannWindow, frequencyForBin, Radix2Fft } from "./fft.ts";
import { HPSS_TIME_KERNEL, StreamingHpss, type HpssFlux } from "./harmonic-percussive.ts";
import type { PitchPoint, SpectralFrame } from "./types.ts";

export type OnsetEnvelopes = Readonly<{
  broadband: Float32Array;
  bass: Float32Array;
  midrange: Float32Array;
  highFrequency: Float32Array;
  harmonic: Float32Array;
  percussive: Float32Array;
}>;

export type SpectrumAnalysis = Readonly<{
  frames: readonly SpectralFrame[];
  envelopes: OnsetEnvelopes;
  rawPitch: readonly PitchPoint[];
  /** Twelve pitch-class energies per frame, row-major; consumed by section analysis only. */
  chroma: Float32Array;
  /** The same twelve pitch-class energies from the drum-free (harmonic) spectrum. */
  harmonicChroma: Float32Array;
}>;

const BAND_RANGES = {
  sub: [20, 60],
  bass: [60, 250],
  lowMid: [250, 500],
  mid: [500, 2_000],
  upperMid: [2_000, 6_000],
  high: [6_000, 11_025],
} as const;

function normalizedEnergy(
  magnitudes: Float32Array,
  sampleRate: number,
  frameSize: number,
  from: number,
  to: number,
): number {
  const first = Math.max(1, binForFrequency(from, sampleRate, frameSize));
  const last = Math.min(magnitudes.length - 1, binForFrequency(to, sampleRate, frameSize));
  let total = 0;
  for (let bin = first; bin <= last; bin += 1) total += (magnitudes[bin] ?? 0) ** 2;
  return total / Math.max(1, last - first + 1);
}

function pitchFromSpectrum(
  magnitudes: Float32Array,
  timeMs: number,
  sampleRate: number,
  frameSize: number,
  minimumHz: number,
  maximumHz: number,
): PitchPoint | undefined {
  const minimumBin = Math.max(2, binForFrequency(minimumHz, sampleRate, frameSize));
  const maximumBin = Math.min(magnitudes.length - 2, binForFrequency(maximumHz, sampleRate, frameSize));
  let average = 0;
  for (let bin = minimumBin; bin <= maximumBin; bin += 1) average += magnitudes[bin] ?? 0;
  average /= Math.max(1, maximumBin - minimumBin + 1);
  let bestBin = 0;
  let bestScore = 0;
  for (let bin = minimumBin; bin <= maximumBin; bin += 1) {
    const fundamental = magnitudes[bin] ?? 0;
    const score =
      fundamental +
      (magnitudes[bin * 2] ?? 0) * 0.52 +
      (magnitudes[bin * 3] ?? 0) * 0.3 +
      (magnitudes[bin * 4] ?? 0) * 0.18;
    if (score > bestScore) {
      bestScore = score;
      bestBin = bin;
    }
  }
  const salience = bestScore / Math.max(average * 6, Number.EPSILON);
  if (bestBin === 0 || salience < 1.1) return undefined;
  // Parabolic interpolation recovers sub-bin frequency; raw bins are ~3 semitones wide near 65 Hz.
  const left = magnitudes[bestBin - 1] ?? 0;
  const center = magnitudes[bestBin] ?? 0;
  const right = magnitudes[bestBin + 1] ?? 0;
  const curvature = left - 2 * center + right;
  const offset = curvature < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / curvature)) : 0;
  const frequencyHz = frequencyForBin(bestBin + offset, sampleRate, frameSize);
  const midi = 69 + 12 * Math.log2(frequencyHz / 440);
  return {
    timeMs,
    frequencyHz,
    midi,
    confidence: Math.min(1, (salience - 1) / 5),
    salience,
  };
}

export function analyzeSpectrum(
  mono: Float32Array,
  sampleRate: number,
  frameSize: number,
  hopSize: number,
  pitchRange: Readonly<{ minimumHz: number; maximumHz: number }>,
  signal?: AbortSignal,
  onsetLatencyMs = 0,
): SpectrumAnalysis {
  const frameCount = Math.max(0, Math.floor((mono.length - frameSize) / hopSize) + 1);
  const frames: SpectralFrame[] = [];
  const broadband = new Float32Array(frameCount);
  const bass = new Float32Array(frameCount);
  const midrange = new Float32Array(frameCount);
  const highFrequency = new Float32Array(frameCount);
  const harmonic = new Float32Array(frameCount);
  const percussive = new Float32Array(frameCount);
  const rawPitch: PitchPoint[] = [];
  const window = createHannWindow(frameSize);
  const fft = new Radix2Fft(frameSize);
  const input = new Float32Array(frameSize);
  const windowed = new Float32Array(frameSize);
  const magnitudes = new Float32Array(frameSize / 2 + 1);
  const previous = new Float32Array(magnitudes.length);
  const chroma = new Float32Array(frameCount * 12);
  const pitchClassForBin = new Int8Array(magnitudes.length).fill(-1);
  for (let bin = 1; bin < magnitudes.length; bin += 1) {
    const frequency = frequencyForBin(bin, sampleRate, frameSize);
    if (frequency >= 65 && frequency <= 2_100)
      pitchClassForBin[bin] = ((Math.round(69 + 12 * Math.log2(frequency / 440)) % 12) + 12) % 12;
  }
  // Frame timestamps describe where an attack sits inside the analysis window, not the window start.
  const centerOffsetMs = (frameSize * 500) / sampleRate;
  // Drums and tones separate well below 6 kHz; the high band keeps its own plain flux for hats.
  const hpss = new StreamingHpss(Math.min(magnitudes.length, binForFrequency(6_000, sampleRate, frameSize) + 1));
  // Separation reports a frame a few hops late, so keep recent full-resolution spectra to mask.
  const recent = new Float32Array(HPSS_TIME_KERNEL * magnitudes.length);
  const harmonicMagnitudes = new Float32Array(magnitudes.length);
  const harmonicChroma = new Float32Array(frameCount * 12);
  const storeSeparated = (separated: HpssFlux | undefined) => {
    if (!separated) return;
    const frame = separated.frame;
    harmonic[frame] = separated.harmonicFlux;
    percussive[frame] = separated.percussiveFlux;
    // Pitch and tonal sustain come from the drum-free spectrum: a kick or snare under a held
    // note no longer breaks its pitch track or inflates its loudness.
    const offset = (frame % HPSS_TIME_KERNEL) * magnitudes.length;
    const { harmonicMask } = separated;
    for (let bin = 0; bin < magnitudes.length; bin += 1)
      harmonicMagnitudes[bin] =
        bin < hpss.sourceBins ? recent[offset + bin]! * harmonicMask[Math.floor(bin / hpss.pool)]! : 0;
    for (let bin = 1; bin < magnitudes.length; bin += 1) {
      const pitchClass = pitchClassForBin[bin]!;
      if (pitchClass >= 0) harmonicChroma[frame * 12 + pitchClass]! += harmonicMagnitudes[bin]! ** 2;
    }
    if ((frame & 1) === 0) {
      const pitch = pitchFromSpectrum(
        harmonicMagnitudes,
        (frame * hopSize * 1000) / sampleRate + centerOffsetMs,
        sampleRate,
        frameSize,
        pitchRange.minimumHz,
        pitchRange.maximumHz,
      );
      if (pitch) rawPitch.push(pitch);
    }
  };

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    if ((frameIndex & 63) === 0) throwIfAborted(signal);
    input.set(mono.subarray(frameIndex * hopSize, frameIndex * hopSize + frameSize));
    fft.magnitudes(applyWindow(input, window, windowed), magnitudes);
    let energy = 0;
    let weightedFrequency = 0;
    let positiveFlux = 0;
    let bassFlux = 0;
    let midFlux = 0;
    let highFlux = 0;
    let peakEnergy = 0;
    for (let bin = 1; bin < magnitudes.length; bin += 1) {
      const magnitude = magnitudes[bin] ?? 0;
      const squared = magnitude * magnitude;
      const frequency = frequencyForBin(bin, sampleRate, frameSize);
      energy += squared;
      weightedFrequency += frequency * squared;
      peakEnergy = Math.max(peakEnergy, squared);
      // SuperFlux-style maximum filter: vibrato and slight detuning should not register as new attacks.
      const reference = Math.max(previous[bin - 1] ?? 0, previous[bin] ?? 0, previous[bin + 1] ?? 0);
      const difference = Math.max(0, Math.log1p(magnitude * 100) - Math.log1p(reference * 100));
      const pitchClass = pitchClassForBin[bin] ?? -1;
      if (pitchClass >= 0)
        chroma[frameIndex * 12 + pitchClass] = (chroma[frameIndex * 12 + pitchClass] ?? 0) + squared;
      positiveFlux += difference;
      if (frequency < 250) bassFlux += difference;
      else if (frequency < 2_000) midFlux += difference;
      else highFlux += difference;
    }
    const frameStartMs = (frameIndex * hopSize * 1000) / sampleRate;
    const timeMs = frameStartMs + onsetLatencyMs;
    const bandEnergy = {
      sub: normalizedEnergy(magnitudes, sampleRate, frameSize, ...BAND_RANGES.sub),
      bass: normalizedEnergy(magnitudes, sampleRate, frameSize, ...BAND_RANGES.bass),
      lowMid: normalizedEnergy(magnitudes, sampleRate, frameSize, ...BAND_RANGES.lowMid),
      mid: normalizedEnergy(magnitudes, sampleRate, frameSize, ...BAND_RANGES.mid),
      upperMid: normalizedEnergy(magnitudes, sampleRate, frameSize, ...BAND_RANGES.upperMid),
      high: normalizedEnergy(magnitudes, sampleRate, frameSize, ...BAND_RANGES.high),
    };
    const harmonicity = Math.min(1, peakEnergy / Math.max(energy * 0.12, Number.EPSILON));
    frames.push({
      timeMs,
      totalEnergy: energy / magnitudes.length,
      spectralCentroidHz: energy > 0 ? weightedFrequency / energy : 0,
      spectralFlux: positiveFlux / magnitudes.length,
      harmonicity,
      bandEnergy,
    });
    broadband[frameIndex] = positiveFlux / magnitudes.length;
    bass[frameIndex] = bassFlux / Math.max(1, binForFrequency(250, sampleRate, frameSize));
    midrange[frameIndex] = midFlux / Math.max(1, binForFrequency(2_000, sampleRate, frameSize));
    highFrequency[frameIndex] =
      highFlux / Math.max(1, magnitudes.length - binForFrequency(2_000, sampleRate, frameSize));
    recent.set(magnitudes, (frameIndex % HPSS_TIME_KERNEL) * magnitudes.length);
    storeSeparated(hpss.push(magnitudes));
    previous.set(magnitudes);
  }
  for (const separated of hpss.flush()) storeSeparated(separated);
  return {
    frames,
    envelopes: { broadband, bass, midrange, highFrequency, harmonic, percussive },
    rawPitch,
    chroma,
    harmonicChroma,
  };
}
