import { V2_FEATURE_FLAGS } from "./config.ts";

/** Gameplay currently has no slide note type, so the builder remains explicitly disabled. */
export function slidesAreEnabled(): boolean {
  return V2_FEATURE_FLAGS.slides;
}
