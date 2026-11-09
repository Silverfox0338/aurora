# @silverfox0338/aurora

Aurora is a rhythm-game chart engine. It turns decoded audio into a deterministic falling-note rhythm chart: FFT spectral analysis, multi-band onsets, tempo and downbeat tracking, pitch continuity, section detection, lane planning, holds, Extreme gimmicks, and a playability report.

- Zero runtime dependencies, pure TypeScript, ESM.
- Runs anywhere with `Float32Array`: browsers, Web Workers, Node 18+, Deno, Bun.
- Deterministic: the same audio, fingerprint, and settings always produce the same chart.

## Install

```sh
npm install @silverfox0338/aurora
```

To develop the engine alongside an app, run `npm run build` here and `npm install ../AURORA` in the app (rebuild to pick up changes), or `npm pack` and install the `.tgz` to pin an exact build.

## Usage

```ts
import { aurora } from "@silverfox0338/aurora";

// 1. Decode audio however your platform does it. In a browser:
const buffer = await new AudioContext().decodeAudioData(await file.arrayBuffer());
const audio = {
  channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
  sampleRate: buffer.sampleRate,
};

// 2. Analyse once (slow: run it in a Web Worker or worker thread for full songs).
const analysis = aurora.analyze(audio, {
  signal: abortController.signal,
  report: ({ stage, progress }) => console.log(stage, progress),
});

// 3. Generate as many charts as you like from the same analysis (fast).
const chart = aurora.generateChart(audioFingerprint, analysis, {
  difficulty: "hard", // "easy" | "normal" | "hard" | "extreme"
  laneCount: 6, // 4 to 8
  laneStyle: "balanced", // "balanced" | "frequency" | "alternating"
  density: 1, // multiplier on notes per second
  algorithmVersion: aurora.version, // overwritten with the engine version
});

chart.notes; // [{ id, kind: "tap" | "hold", timeMs, lane, strength, durationMs? }]
chart.gimmicks; // Extreme only: timed flip / hidden / shuffle effects
chart.quality; // playability, musicality, density, warnings
```

### Tempo

```ts
analysis.estimatedBpm; // the song's main tempo (median beat interval)
analysis.tempoMap; // [{ startMs, bpm }]: one entry for a steady song, more when the tempo changes
analysis.tempoAlternatives; // [{ bpm, score }]: the chosen tempo first, then its half/double readings
chart.tempo; // the same, in integers: { bpmMilli, confidenceBasisPoints, map, alternatives }
```

Use `tempoAlternatives` to offer a "half speed / double speed" override when the felt beat is ambiguous.

`audioFingerprint` is any stable string that identifies the song. The SHA-256 hex of the audio file works well. It seeds the lane choices, so keep it stable if you want repeatable charts.

`analysis` is plain, serializable data, so you can post it from a worker or cache it. Key the cache on `aurora.version` and `V2_CONFIG.sampleRate`, `frameSize`, and `hopSize`.

### Lower-level pieces

Everything the pipeline is built from is exported too: `analyzeSpectrum`, `detectOnsets`, `trackBeats`, `BeatGrid`, `analyzeSections`, `buildMusicalEvents`, `planLanes`, `validateChartQuality`, `placeGimmicks`, `createDeterministicRandom`, the tuning tables `V2_CONFIG` and `V2_DIFFICULTY`, and all the types (`ChartDefinition`, `ChartNote`, `V2Analysis`, and so on).

`ChartDefinition<Id>` takes the algorithm ids your app accepts, so `ChartDefinition<"v1" | "v2">` narrows `generator.algorithmId`. Aurora always writes `"v2"`.

## Versioning

`aurora.version` (`aurora-v3.0.0`) is recorded on every chart and is part of the seed. Any change that can alter output must bump `V2_VERSION` in `src/config.ts` and the package `version`, or saved charts and leaderboards stop matching.

## Development

Imports use `.ts` extensions; `tsc` rewrites them to `.js` in `dist/`.

```sh
npm run build      # dist/ with .js, .d.ts and source maps
npm run typecheck
npm test
```

## License

Copyright (C) 2026 Silverfox0338.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for details.
