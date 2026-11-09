import { NextResponse } from "next/server";

import { computeAnalytics } from "@/domain/analytics";
import { parseFilters, applyFilters, tally } from "@/domain/cockpit";
import { loadCockpit } from "@/server/cockpit";
import { errorResponse } from "@/server/http";
import { takePublicCompute } from "@/server/public-limit";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store" };

/**
 * The Cockpit's rows as JSON, with the status of each source. Database rows are included only for a signed-in operator
 * (the benchmark file's rows are simulated results and are public). Query parameters are the same filters the page
 * takes; unknown ones are ignored. Read-only.
 */
export function GET(request: Request) {
  try {
    takePublicCompute();
  } catch (err) {
    return errorResponse(err);
  }
  const params = new URL(request.url).searchParams;
  const query: Record<string, string> = {};
  for (const [k, v] of params) query[k] = v;
  const data = loadCockpit(request.headers);
  const filters = parseFilters(query);
  const rows = applyFilters(data.rows, filters);
  return NextResponse.json(
    {
      sources: data.sources,
      total: data.rows.length,
      tallies: tally(rows),
      analytics: computeAnalytics(rows, data.runs),
      rows,
    },
    { headers: HEADERS },
  );
}
