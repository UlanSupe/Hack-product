import { z } from "zod";

/**
 * The live-model measurement (docs/LIVE_MODEL_ATTACK.md): a real model as the buyer against the ten hostile-seller
 * scripts. The file is written by `npm run agents:attack`; this module only reads it. Nothing here is a guarantee: the
 * page that shows it repeats the limits.
 */
const Summary = z.object({
  model: z.string().min(1).max(120),
  trialsPerScript: z.number().int().min(1).max(100),
  negotiations: z.number().int().min(1).max(10_000),
  recommendedAnOfferTheServerRejects: z.number().int().min(0),
  askedHumanToApproveAnOfferTheServerRejects: z.number().int().min(0),
  askedHumanToApproveAnOfferThatPassedHardChecks: z.number().int().min(0),
  recommendedAnOfferThatPassedHardChecks: z.number().int().min(0),
  declinedOrAskedForClarification: z.number().int().min(0),
  agentFailure: z.number().int().min(0),
});

const Row = z.object({
  script: z.string().min(1).max(60),
  trial: z.number().int().min(1),
  status: z.string().min(1).max(60),
  serverRejects: z.array(z.string().max(60)).max(20),
});

const FileSchema = z.object({ summary: Summary, rows: z.array(Row).max(10_000) });

export type LiveModelSummary = z.infer<typeof Summary>;
export type LiveModelScriptRow = {
  script: string;
  runs: number;
  /** Negotiations where the server's own checks reject the offer the model pointed at. */
  serverRejected: number;
  recommendedRejected: number;
  askedHuman: number;
  declinedOrClarified: number;
};
export type LiveModelView = { summary: LiveModelSummary; perScript: LiveModelScriptRow[] };

export type LiveModelParse =
  { kind: "OK"; view: LiveModelView } | { kind: "INVALID"; message: string };

/** Reads the measurement file's text. The counts shown are recomputed from the rows and must agree with the summary. */
export function parseLiveModel(text: string): LiveModelParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "INVALID", message: "The measurement file is not valid JSON." };
  }
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success)
    return { kind: "INVALID", message: "The measurement file does not have the expected shape." };
  const { summary, rows } = parsed.data;
  if (rows.length !== summary.negotiations)
    return { kind: "INVALID", message: "The measurement file's rows do not match its summary." };
  const recount = rows.filter((r) => r.status === "UNSAFE_RECOMMENDATION").length;
  if (recount !== summary.recommendedAnOfferTheServerRejects)
    return { kind: "INVALID", message: "The measurement file's rows do not match its summary." };

  const by = new Map<string, LiveModelScriptRow>();
  for (const r of rows) {
    const row = by.get(r.script) ?? {
      script: r.script,
      runs: 0,
      serverRejected: 0,
      recommendedRejected: 0,
      askedHuman: 0,
      declinedOrClarified: 0,
    };
    row.runs += 1;
    if (r.serverRejects.length > 0) row.serverRejected += 1;
    if (r.status === "UNSAFE_RECOMMENDATION") row.recommendedRejected += 1;
    else if (r.status === "APPROVAL_REQUESTED") row.askedHuman += 1;
    else if (["NO_DEAL", "CLARIFICATION_NEEDED", "MAX_ROUNDS"].includes(r.status))
      row.declinedOrClarified += 1;
    by.set(r.script, row);
  }
  return { kind: "OK", view: { summary, perScript: [...by.values()] } };
}
