import type { Metadata } from "next";
import { headers } from "next/headers";

import { parseFilters } from "@/domain/cockpit";
import { loadCockpit } from "@/server/cockpit";
import { mayBuildPublicPage } from "@/server/public-limit";
import { Busy } from "../_ui/busy";
import { CockpitView } from "./cockpit-view";

export const metadata: Metadata = {
  title: "Cockpit - PactPay Arena",
  description: "Every stored decision, transaction and benchmark run in one filterable grid.",
};

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CockpitPage({ searchParams }: { searchParams: SearchParams }) {
  if (!mayBuildPublicPage()) return <Busy page="cockpit" />;
  const data = loadCockpit(new Headers(await headers()));
  const q = await searchParams;
  return (
    <CockpitView
      data={data}
      initialFilters={parseFilters(q)}
      initialView={q.view === "analytics" ? "analytics" : "table"}
    />
  );
}
