import { describe, expect, it } from "vitest";

import { analyzeV2 } from "../src/analyze-v2.ts";
import { resampleAudio } from "../src/audio-prep.ts";
import { scoreTempoCandidates, trackBeats } from "../src/beat-tracking.ts";
import { applyWindow, binForFrequency, createHannWindow, frequencyForBin, Radix2Fft } from "../src/fft.ts";
import { adaptiveThreshold, detectOnsets } from "../src/onset-detection.ts";
import { buildMelodySegments, frequencyToMidi, stabilizePitchTrack } from "../src/pitch-tracking.ts";
import { analyzeSpectrum } from "../src/spectrum.ts";

describe("V2 DSP foundations", () => {
  it("resamples by integration instead of nearest-neighbor aliasing", () => {
    const alternating = Float32Array.from({ length: 200 }, (_, index) => (index % 2 === 0 ? 1 : -1));
    const result = resampleAudio(alternating, 44_100, 22_050);
    expect(result).toHaveLength(100);
    expect(Math.max(...result.map(Math.abs))).toBeLessThan(0.01);
  });

  it("maps FFT bins and applies a Hann window", () => {
    const size = 2048;
    const sampleRate = 22_050;
    const bin = binForFrequency(440, sampleRate, size);
    expect(frequencyForBin(bin, sampleRate, size)).toBeCloseTo(440, -1);
    const window = createHannWindow(size);
    expect(window[0]).toBeCloseTo(0, 6);
    expect(window[size - 1]).toBeCloseTo(0, 6);
    expect(window[Math.floor(size / 2)]).toBeCloseTo(1, 4);
    const sine = Float32Array.from({ length: size }, (_, index) =>
      Math.sin((2 * Math.PI * 440 * index) / sampleRate),
    );
    const magnitudes = new Radix2Fft(size).magnitudes(applyWindow(sine, window));
    const peak = magnitudes.indexOf(Math.max(...magnitudes));
    expect(frequencyForBin(peak, sampleRate, size)).toBeCloseTo(440, -1);
  });

  it("builds positive spectral flux and adaptive local thresholds", () => {
    const sampleRate = 22_050;
    const mono = new Float32Array(sampleRate);
    for (let index = 6000; index < 6400; index += 1) mono[index] = Math.sin(index * 0.37);
    const result = analyzeSpectrum(mono, sampleRate, 1024, 256, { minimumHz: 65, maximumHz: 1200 });
    expect(Math.max(...result.envelopes.broadband)).toBeGreaterThan(0);
    const threshold = adaptiveThreshold(result.envelopes.broadband, 8, 1.5);
    expect(threshold).toHaveLength(result.envelopes.broadband.length);
    const onsets = detectOnsets(result.envelopes, sampleRate, 256, {
      localWindowFrames: 8,
      thresholdMultiplier: 1.5,
      minimumGapMs: 60,
    });
    expect(onsets.length).toBeGreaterThan(0);
  });

  it("scores a 120 BPM pulse grid and returns timestamped beats", () => {
    const frameRate = 100;
    const envelope = new Float32Array(800);
    for (let index = 0; index < envelope.length; index += 50) envelope[index] = 1;
    const candidates = scoreTempoCandidates(envelope, frameRate, 60, 200);
    expect(candidates.some((candidate) => Math.abs(candidate.bpm - 120) < 1)).toBe(true);
    const onsets = Array.from({ length: 16 }, (_, index) => ({
      timeMs: index * 500,
      strength: 1,
      confidence: 1,
      band: "broadband" as const,
    }));
    const result = trackBeats(envelope, onsets, 8000, frameRate * 256, 256, 60, 200);
    expect(result.bpm).toBeCloseTo(120, 0);
    expect(result.beats.length).toBeGreaterThan(12);
    expect(result.beats[1]!.timeMs - result.beats[0]!.timeMs).toBeCloseTo(500, 0);
  });

  it.each([
    { bpm: 86, label: "half-time groove with eighth-note hats" },
    { bpm: 172, label: "fast backbeat with eighth-note hats" },
  ])("resolves the tempo octave of a $bpm BPM $label", ({ bpm }) => {
    const audio = drumLoop(bpm, 24);
    const analysis = analyzeV2({ channels: [audio], sampleRate: 22_050 });
    expect(analysis.estimatedBpm).not.toBeNull();
    expect(Math.abs(analysis.estimatedBpm! - bpm)).toBeLessThan(bpm * 0.03);
    expect(analysis.tempoAlternatives[0]!.bpm).toBeCloseTo(analysis.estimatedBpm!, -1);
    expect(analysis.tempoAlternatives.length).toBeGreaterThan(1);
  });

  it("separates clicks into the percussive envelope and a sustained pad into the harmonic one", () => {
    const sampleRate = 22_050;
    const hop = 256;
    const mono = Float32Array.from(
      { length: sampleRate * 6 },
      (_, index) => 0.3 * Math.sin((2 * Math.PI * 220 * index) / sampleRate) + 0.2 * Math.sin((2 * Math.PI * 330 * index) / sampleRate),
    );
    const clickFrames: number[] = [];
    for (let start = sampleRate; start < mono.length - 200; start += sampleRate / 2) {
      for (let offset = 0; offset < 40; offset += 1) mono[start + offset]! += (offset % 2 === 0 ? 0.8 : -0.8) * (1 - offset / 40);
      clickFrames.push(start / hop);
    }
    const pitchRange = { minimumHz: 65, maximumHz: 1200 };
    const { envelopes } = analyzeSpectrum(mono, sampleRate, 2048, hop, pitchRange);
    // A click excites every frame whose 2048-sample window covers it, i.e. up to 8 hops earlier.
    let percussiveAtClicks = 0;
    let harmonicAtClicks = 0;
    for (let frame = Math.ceil(sampleRate / hop); frame < envelopes.percussive.length; frame += 1)
      if (clickFrames.some((click) => frame <= click + 2 && frame >= click - 10)) {
        percussiveAtClicks += envelopes.percussive[frame]!;
        harmonicAtClicks += envelopes.harmonic[frame]!;
      }
    expect(percussiveAtClicks).toBeGreaterThan(harmonicAtClicks * 2);

    // A pad fading in is all harmonic change.
    const swell = new Float32Array(sampleRate * 6);
    for (let index = sampleRate * 3; index < swell.length; index += 1)
      swell[index] =
        0.3 * Math.sin((2 * Math.PI * 220 * index) / sampleRate) * Math.min(1, (index - sampleRate * 3) / 4000);
    const swellEnvelopes = analyzeSpectrum(swell, sampleRate, 2048, hop, pitchRange).envelopes;
    const sum = (values: Float32Array) => values.reduce((total, value) => total + value, 0);
    expect(sum(swellEnvelopes.harmonic)).toBeGreaterThan(sum(swellEnvelopes.percussive) * 5);
  });

  it("tracks pitch near MIDI 69 and joins stable melody frames", () => {
    expect(frequencyToMidi(440)).toBeCloseTo(69, 8);
    const raw = [0, 30, 60, 90].map((timeMs, index) => ({
      timeMs,
      frequencyHz: index === 2 ? 880 : 440,
      midi: index === 2 ? 81 : 69,
      confidence: index === 2 ? 0.3 : 0.9,
      salience: 4,
    }));
    const stable = stabilizePitchTrack(raw, 0.18, 0.22);
    expect(stable.every((point) => Math.abs(point.midi - 69) < 1)).toBe(true);
    const segments = buildMelodySegments(stable, 45, 85);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.midiPitch).toBeCloseTo(69, 0);
  });
});

const HAT_PARTIALS = [5_870, 6_930, 7_810, 8_420, 9_370, 10_150];

/** Kick on beats 1 and 3, snare on 2 and 4, closed hats on every eighth note. */
function drumLoop(bpm: number, seconds: number, sampleRate = 22_050): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  let seed = 12_345;
  const noise = () => {
    seed = (seed * 1_103_515_245 + 12_345) >>> 0;
    return (seed / 2 ** 32) * 2 - 1;
  };
  const beatSamples = (60 / bpm) * sampleRate;
  const add = (start: number, length: number, voice: (t: number) => number) => {
    for (let i = 0; i < length && start + i < out.length; i += 1) out[start + i]! += voice(i / sampleRate);
  };

  for (let eighth = 0; eighth * beatSamples * 0.5 < out.length; eighth += 1) {
    const start = Math.round(eighth * beatSamples * 0.5);
    // Closed hats live above 5 kHz: a cluster of inharmonic partials, like a real cymbal.
    add(start, Math.round(0.03 * sampleRate), (t) => {
      let hat = 0;
      for (const frequency of HAT_PARTIALS) hat += Math.sin(2 * Math.PI * frequency * t + frequency);
      return (hat / HAT_PARTIALS.length) * 0.25 * Math.exp(-t * 120);
    });
    if (eighth % 2 !== 0) continue;
    const beat = eighth / 2;
    if (beat % 2 === 0)
      add(
        start,
        Math.round(0.18 * sampleRate),
        (t) => Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-t * 30)) * t) * 0.9 * Math.exp(-t * 18),
      );
    else
      add(
        start,
        Math.round(0.15 * sampleRate),
        (t) => (noise() * 0.5 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * Math.exp(-t * 25),
      );
  }
  return out;
}
