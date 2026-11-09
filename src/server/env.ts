import "server-only";

import { parseEnv, type Env, type EnvIssue } from "@/config/env.schema";

/** Thrown when configuration is invalid. Carries variable names and messages, never values. */
export class EnvError extends Error {
  readonly issues: EnvIssue[];
  constructor(issues: EnvIssue[]) {
    super(`Invalid environment: ${issues.map((i) => i.path).join(", ")}`);
    this.name = "EnvError";
    this.issues = issues;
  }
}

/**
 * The single reader of `process.env`. `server-only` makes the build fail if any client
 * component (directly or transitively) imports this module, so secrets cannot reach the browser.
 */
export function getEnv(raw: Record<string, string | undefined> = process.env): Env {
  const result = parseEnv(raw);
  if (!result.ok) throw new EnvError(result.issues);
  return result.env;
}
