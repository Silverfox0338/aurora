// Synthetic audio for tests: drums, click tracks and melodies with known timing.

const HAT_PARTIALS = [5_870, 6_930, 7_810, 8_420, 9_370, 10_150];

/** Kick on beats 1 and 3, snare on 2 and 4, closed hats on every eighth note. */
export function drumLoop(bpm: number, seconds: number, sampleRate = 22_050): Float32Array {
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

/** A kick-like thump at each beat time (seconds). */
export function beatTrack(beatTimes: readonly number[], seconds: number, sampleRate = 22_050): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (const time of beatTimes) {
    const start = Math.round(time * sampleRate);
    for (let i = 0; i < 0.15 * sampleRate && start + i < out.length; i += 1) {
      const t = i / sampleRate;
      out[start + i]! += Math.sin(2 * Math.PI * (60 + 100 * Math.exp(-t * 35)) * t) * 0.8 * Math.exp(-t * 20);
    }
  }
  return out;
}

/**
 * Share of true beats (ignoring the first and last two seconds) with a detected beat within
 * `tolerance` seconds, after removing the detector's constant latency.
 */
export function beatHitRate(detected: readonly number[], truth: readonly number[], tolerance: number): number {
  const end = truth[truth.length - 1]!;
  const inner = truth.filter((time) => time > 2 && time < end - 2);
  const nearest = (time: number) =>
    detected.reduce((best, candidate) => (Math.abs(candidate - time) < Math.abs(best - time) ? candidate : best), Infinity);
  const offsets = inner.map((time) => nearest(time) - time).sort((left, right) => left - right);
  const latency = offsets[Math.floor(offsets.length / 2)]!;
  return inner.filter((time) => Math.abs(nearest(time) - time - latency) <= tolerance).length / inner.length;
}

export type SynthNote = Readonly<{ startSec: number; durationSec: number; midi: number }>;

/**
 * A bright sustained voice (six harmonics, gentle vibrato, short attack and release), like a
 * synth lead or a held sung vowel. Notes are added into `out` in place.
 */
export function addMelody(out: Float32Array, notes: readonly SynthNote[], gain = 0.35, sampleRate = 22_050): Float32Array {
  for (const note of notes) {
    const frequency = 440 * 2 ** ((note.midi - 69) / 12);
    const start = Math.round(note.startSec * sampleRate);
    const length = Math.round(note.durationSec * sampleRate);
    const release = Math.round(0.04 * sampleRate);
    let phase = 0;
    for (let i = 0; i < length + release && start + i < out.length; i += 1) {
      const t = i / sampleRate;
      const vibrato = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.25);
      phase += (2 * Math.PI * frequency * vibrato) / sampleRate;
      let tone = 0;
      for (let harmonic = 1; harmonic <= 6; harmonic += 1) tone += Math.sin(phase * harmonic) / harmonic;
      const attack = Math.min(1, t / 0.012);
      const tail = i < length ? 1 : 1 - (i - length) / release;
      out[start + i]! += tone * gain * attack * tail;
    }
  }
  return out;
}

/**
 * Eight bars of melody at 120 BPM over the drum loop: long held notes mixed with quick ones,
 * each note ending a little before the next starts. Durations are in beats.
 */
export function heldMelodyMix(accompaniment = false): { audio: Float32Array; notes: SynthNote[]; beatSec: number } {
  const bpm = 120;
  const beatSec = 60 / bpm;
  const pattern: Array<[beats: number, midi: number, rest?: boolean]> = [
    [1, 67], [0.5, 69], [0.5, 71], [2, 72], [1, 71], [3, 69], [0.5, 67], [0.5, 64], [1.5, 67], [0.5, 0, true],
    [4, 72], [1, 74], [0.5, 72], [0.5, 71], [2, 69], [2.5, 67], [0.5, 0, true], [1, 64], [1, 67], [2, 69], [2, 71],
  ];
  const notes: SynthNote[] = [];
  let beat = 4; // one bar of drums alone first
  for (const [beats, midi, rest] of pattern) {
    if (!rest) notes.push({ startSec: beat * beatSec, durationSec: beats * beatSec - 0.06, midi });
    beat += beats;
  }
  const seconds = (beat + 4) * beatSec;
  const drums = drumLoop(bpm, seconds);
  for (let i = 0; i < drums.length; i += 1) drums[i]! *= 0.7;
  if (accompaniment) {
    // Sustained pad triads (one per bar) and a plucked bass on every beat, quieter than the
    // lead: the realistic case where a pitch tracker flickers between chord tones.
    const chords = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]];
    const pad: SynthNote[] = [];
    const bassLine: SynthNote[] = [];
    for (let bar = 0; bar * 4 * beatSec < seconds; bar += 1) {
      const chord = chords[bar % chords.length]!;
      for (const midi of chord) pad.push({ startSec: bar * 4 * beatSec, durationSec: 4 * beatSec - 0.02, midi });
      for (let b = 0; b < 4; b += 1)
        bassLine.push({ startSec: (bar * 4 + b) * beatSec, durationSec: beatSec * 0.45, midi: chord[0]! - 12 });
    }
    addMelody(drums, pad, 0.08);
    addMelody(drums, bassLine, 0.18);
  }
  return { audio: addMelody(drums, notes), notes, beatSec };
}
