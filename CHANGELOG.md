# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org/).

## 3.1.0 — 2026-11-12

### Changed

- `MIN_HOLD_DURATION_MS` is now 180 ms (was 350). Hard and Extreme charts can contain short holds, so hosts must accept and render holds that short.
- The algorithm version is now `aurora-v3.1.0`. Charts and cached analyses keyed on `aurora.version` are regenerated.
- Analysis takes about one second longer per song (the learned beat model).

### Added

- **Learned beat model.** A small built-in network reads the band envelopes over about ±2 s and outputs beat and downbeat probabilities. The beat tracker follows a blend of it and the percussive envelope, and bar positions come from its downbeat output. No new dependencies; inference is deterministic. Behind the new `learnedBeats` feature flag.
- **Downbeat decoding.** Each beat's position in the bar is decoded with a Viterbi path over chord change, kick and snare evidence (`decodeBarPositions`, `barFeatures`), and may re-sync where the beat tracker slipped a beat. Used when the learned model is off; enabled by `advancedDownbeats`.
- **Chords on Hard and Extreme** by rhythmic weight (beat position, downbeat, how many bands the hit spans): 28% of moments on Hard, 38% on Extreme, with triples on the strongest downbeats. Chords are trimmed wherever they would exceed the density limits.
- **Short holds on Hard and Extreme**: pitched sustains of at least 0.6 beats (and 180 ms) may become holds, with their own allowance so they do not crowd out long holds.

### Improved

- **Beat tracking** holds its phase through sparse sections instead of drifting onto off-beat hi-hats, and songs that locked onto the off-beat now track on the beat. On held-out annotated songs, downbeat accuracy (F-measure) rose from 0.54 to 0.58 and beat accuracy from 0.61 to 0.65 on the harder test set.
- Easy and Normal charts are otherwise unchanged in style.

## 3.0.0 — 2026-11-09

### Breaking changes

- `ChartDefinition.tempo` (`TempoMetadata`) is now `{ bpmMilli, confidenceBasisPoints, map, alternatives }`. The `halfTimeBpmMilli` / `doubleTimeBpmMilli` fields are gone; read the half/double readings from `alternatives` instead.
- The public API drops its internal `V2` names:

  | Before | After |
  | --- | --- |
  | `analyzeV2` / `generateV2Chart` | `analyzeAudio` / `generateChart` (or `aurora.analyze` / `aurora.generateChart`) |
  | `V2Analysis`, `V2AnalysisConfig`, `V2DebugExport`, `isV2Analysis` | `AuroraAnalysis`, `AuroraAnalysisConfig`, `AuroraDebugExport`, `isAuroraAnalysis` |
  | `V2_CONFIG`, `V2_VERSION`, `V2_DIFFICULTY`, `V2_FEATURE_FLAGS` | `AURORA_CONFIG`, `AURORA_VERSION`, `AURORA_DIFFICULTY`, `AURORA_FEATURE_FLAGS` |

- Charts now carry `generator.algorithmId: "aurora"` (was `"v2"`), analyses `kind: "aurora-analysis"` (was `"v2-analysis"`), and note ids start with `note-`.
- The algorithm version is now `aurora-v3.0.0`. Charts and cached analyses keyed on `aurora.version` are regenerated.

### Added

- **Tempo map.** `analysis.tempoMap` follows tempo changes (a Viterbi path over a local tempogram), and beat tracking uses the local tempo at every beat.
- **Tempo alternatives.** `analysis.tempoAlternatives` ranks the half/double readings so apps can offer a speed override.
- **Real harmonic/percussive separation.** Streaming median-filter HPSS replaces the old approximation, giving cleaner drum onsets for beat tracking and a drum-free spectrum for pitch and holds.

### Improved

- **Tempo accuracy.** Half/double errors are resolved from kick and snare placement, and triple-feel grooves (dembow, afrobeats, half-time trap) from beat-grid sharpness. On a 94-song, ~50-genre reference set: 66 → 81 exact tempos.
- **Hold notes.** Held notes are detected from the drum-free spectrum, survive drum hits that land on them, and end when the note's own pitch class fades, not when the mix gets quiet. Holds can also sit on two-note chords.
