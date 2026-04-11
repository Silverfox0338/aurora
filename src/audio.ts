export type AnalysisProgress = Readonly<{
  stage: string;
  progress: number;
}>;

/** PCM audio, one Float32Array per channel, e.g. from `AudioBuffer.getChannelData`. */
export type DecodedAudio = Readonly<{
  channels: readonly Float32Array[];
  sampleRate: number;
}>;

export type AnalysisContext = Readonly<{
  signal?: AbortSignal;
  debug?: boolean;
  report?: (progress: AnalysisProgress) => void;
}>;

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Analysis was cancelled.", "AbortError");
}
