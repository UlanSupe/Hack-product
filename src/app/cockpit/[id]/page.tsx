import type { Metadata } from "next";
import { headers } from "next/headers";

import { findDetail } from "@/application/cockpit";
import { loadCockpitInput } from "@/server/cockpit";
import { DetailNotFound, DetailView } from "../detail-view";

export const metadata: Metadata = { title: "Cockpit row - PactPay Arena" };
export const dynamic = "force-dynamic";

export default async function CockpitRowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return <DetailNotFound id={raw} reason="That address is not a valid row id." />;
  }
  const input = loadCockpitInput(new Headers(await headers()));
  const detail = findDetail(input, id);
  if (detail) return <DetailView detail={detail} />;

  const reason =
    id.startsWith("bench:") && input.benchmark.state !== "OK"
      ? input.benchmark.message
      : !id.startsWith("bench:") && input.live.state !== "OK"
        ? input.live.message
        : "No row has this id in the sources as they are now.";
  return <DetailNotFound id={id} reason={reason} />;
}
