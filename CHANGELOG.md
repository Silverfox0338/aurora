# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org/).

## 3.0.0 — 2026-11-09

### Breaking changes

- `ChartDefinition.tempo` (`TempoMetadata`) is now `{ bpmMilli, confidenceBasisPoints, map, alternatives }`. The `halfTimeBpmMilli` / `doubleTimeBpmMilli` fields are gone; read the half/double readings from `alternatives` instead.
- The algorithm version is now `aurora-v3.0.0`. Charts and cached analyses keyed on `aurora.version` are regenerated.

### Added

- **Tempo map.** `analysis.tempoMap` follows tempo changes (a Viterbi path over a local tempogram), and beat tracking uses the local tempo at every beat.
- **Tempo alternatives.** `analysis.tempoAlternatives` ranks the half/double readings so apps can offer a speed override.
- **Real harmonic/percussive separation.** Streaming median-filter HPSS replaces the old approximation, giving cleaner drum onsets for beat tracking and a drum-free spectrum for pitch and holds.

### Improved

- **Tempo accuracy.** Half/double errors are resolved from kick and snare placement, and triple-feel grooves (dembow, afrobeats, half-time trap) from beat-grid sharpness. On a 94-song, ~50-genre reference set: 66 → 81 exact tempos.
- **Hold notes.** Held notes are detected from the drum-free spectrum, survive drum hits that land on them, and end when the note's own pitch class fades, not when the mix gets quiet. Holds can also sit on two-note chords.
