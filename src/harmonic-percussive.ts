/** Lightweight spectral-persistence approximation; this is not neural stem separation. */
export function separateSpectralFlux(
  broadbandFlux: number,
  harmonicity: number,
): Readonly<{ harmonicFlux: number; percussiveFlux: number; confidence: number }> {
  const boundedHarmonicity = Math.max(0, Math.min(1, harmonicity));
  return {
    harmonicFlux: broadbandFlux * boundedHarmonicity,
    percussiveFlux: broadbandFlux * (1 - boundedHarmonicity * 0.65),
    confidence: Math.abs(boundedHarmonicity - 0.5) * 2,
  };
}
