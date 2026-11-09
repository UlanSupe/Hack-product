import "server-only";

import { join } from "node:path";

import { readBenchmarkFile } from "@/adapters/benchmark/file";
import { parseLiveModel, type LiveModelParse } from "@/domain/live-model";

export type LiveModelRead =
  LiveModelParse | { kind: "MISSING" } | { kind: "ERROR"; message: string };

/** The committed measurement file (docs/live-model-attack.json). Read-only; a missing file is a normal state. */
export function readLiveModel(): LiveModelRead {
  const file = readBenchmarkFile(join(process.cwd(), "docs", "live-model-attack.json"));
  if (file.kind === "MISSING") return { kind: "MISSING" };
  if (file.kind === "ERROR")
    return { kind: "ERROR", message: "The measurement file could not be read." };
  return parseLiveModel(file.text);
}
