import "server-only";

import { RateWindow } from "@/application/rate-window";
import { HttpError } from "./http";

/**
 * A cap on the public pages that cost real CPU on every request and need no sign-in: the replay (it builds an
 * in-memory database each time, about 40 ms) and the Cockpit (it parses and hashes the benchmark file). It is global,
 * in-process and generous for people (240 a minute); it exists so that one script cannot keep a small demo
 * instance busy. It does not touch the operator's routes. Real flood protection belongs at the platform's edge.
 */
export const PUBLIC_COMPUTE_PER_MINUTE = 240;
export const publicCompute = new RateWindow(PUBLIC_COMPUTE_PER_MINUTE, 60_000);

/** Throws a 429 with Retry-After when the public cap is reached. */
export function takePublicCompute(nowMs: number = Date.now()): void {
  if (!publicCompute.take(nowMs))
    throw new HttpError(429, "BUSY", "This public page is busy. Try again in a few seconds.", {
      "Retry-After": "30",
    });
}

/** True when the page may be built now. For server components, which show a busy note instead of throwing. */
export function mayBuildPublicPage(nowMs: number = Date.now()): boolean {
  return publicCompute.take(nowMs);
}
