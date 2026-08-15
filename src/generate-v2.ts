import { chartSeed, withGeneratorMetadata } from "./metadata.ts";
import type { ChartDefinition, ChartSettings } from "./chart.ts";

import { V2_VERSION } from "./config.ts";
import { placeGimmicks } from "./gimmicks.ts";
import { planLanes } from "./lane-planner.ts";
import { repairHardConflicts, validateChartQuality } from "./quality.ts";
import type { V2Analysis } from "./types.ts";

const GAP_REASONS = new Set(["off-grid", "density-budget", "hold-rest", "low-confidence"]);

export function generateV2Chart(
  audioFingerprint: string,
  analysis: V2Analysis,
  requestedSettings: ChartSettings,
): ChartDefinition<"v2"> {
  if (requestedSettings.laneCount < 4 || requestedSettings.laneCount > 8)
    throw new Error("Lane count must be between 4 and 8");
  // The seed must be derived from the settings that are recorded on the chart.
  const settings: ChartSettings = Object.freeze({ ...requestedSettings, algorithmVersion: V2_VERSION });
  const seed = chartSeed(audioFingerprint, V2_VERSION, settings);
  const plan = planLanes(
    analysis.events,
    analysis.beats,
    analysis.sections,
    settings,
    seed,
    analysis.durationMs,
  );
  const notes = Object.freeze(repairHardConflicts(plan.notes, settings.laneCount, analysis.durationMs));
  const gimmicks = placeGimmicks(analysis.sections, analysis.beats, settings, seed, analysis.durationMs);
  const quality = validateChartQuality(
    notes,
    analysis.durationMs,
    settings.laneCount,
    analysis.beats,
    analysis.events,
    {
      difficulty: settings.difficulty,
      patternCounts: plan.patternCounts,
      repeatedBars: plan.repeatedBars,
    },
  );
  const chart: ChartDefinition = Object.freeze({
    audioFingerprint,
    durationMs: analysis.durationMs,
    settings,
    tempo: Object.freeze({
      bpmMilli: analysis.estimatedBpm === null ? null : Math.round(analysis.estimatedBpm * 1000),
      confidenceBasisPoints: Math.round(Math.max(0, Math.min(1, analysis.tempoConfidence)) * 10_000),
      map: Object.freeze(
        analysis.tempoMap.map((entry) => Object.freeze({ startMs: entry.startMs, bpmMilli: Math.round(entry.bpm * 1000) })),
      ),
      alternatives: Object.freeze(
        analysis.tempoAlternatives.slice(1).map((alternative) =>
          Object.freeze({
            bpmMilli: Math.round(alternative.bpm * 1000),
            scoreBasisPoints: Math.round(alternative.score * 10_000),
          }),
        ),
      ),
    }),
    notes,
    ...(gimmicks.length > 0 ? { gimmicks: Object.freeze(gimmicks) } : {}),
    diagnostics: Object.freeze({
      candidates: analysis.events.length,
      accepted: notes.length,
      removedForGap: plan.removed.filter((item) => GAP_REASONS.has(item.reason)).length,
      movedForConflict: plan.removed.filter((item) => item.reason === "lane-conflict").length,
      reducedChords: plan.reducedChords,
    }),
    quality,
  });
  return withGeneratorMetadata(chart, "v2", V2_VERSION);
}
