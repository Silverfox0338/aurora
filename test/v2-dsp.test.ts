import { describe, expect, it } from "vitest";

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
