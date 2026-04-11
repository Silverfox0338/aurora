import type { ChartDefinition } from "./chart.ts";

export function chartSeed(audioFingerprint: string, algorithmVersion: string, settings: unknown): string {
  return `${audioFingerprint}:${algorithmVersion}:${JSON.stringify(settings)}`;
}

export function withGeneratorMetadata<Id extends string>(
  chart: ChartDefinition,
  algorithmId: Id,
  algorithmVersion: string,
): ChartDefinition<Id> {
  return Object.freeze({
    ...chart,
    generator: Object.freeze({
      algorithmId,
      algorithmVersion,
      seed: chartSeed(chart.audioFingerprint, algorithmVersion, chart.settings),
    }),
  });
}
