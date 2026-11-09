import type {
  BuyerCompareInput,
  BuyerInterpretInput,
  CompareOutput,
  InterpretOutput,
  OfferView,
} from "../domain/agent-contract.ts";
import { hardFailures, type HardFailure } from "../domain/offer-view.ts";
import { formatMinor, parseDecimalAmount, type ServiceCategory } from "../domain/mandate.ts";

/**
 * The deterministic buyer used when no model provider is configured, and in every test. Pure: same
 * input, same output, no clock, no randomness, no I/O. It reads only the `trusted` facts and the
 * buyer's own request; it never repeats seller text, and nothing a seller wrote can change a number it
 * uses. It is an ordinary rule-follower, not a policy: the policy engine still decides.
 */

const CATEGORY_RULES: readonly (readonly [ServiceCategory, RegExp])[] = [
  ["COMPUTE", /\b(gpu|compute|cpu|inference|training|cluster)\b/],
  ["STORAGE", /\b(storage|backup|bucket|archive)\b/],
  ["DATA", /\b(dataset|data feed|data service|database|analytics)\b/],
  ["SOFTWARE", /\b(software|subscription|licen[cs]e|saas)\b/],
  ["DESIGN", /\b(design|logo|branding|illustration|mockup)\b/],
  ["CONSULTING", /\b(consulting|consultant|advisory|workshop)\b/],
];

const ask = (question: string): InterpretOutput => ({ kind: "ASK_USER", question });

export function mockBuyerInterpret(input: BuyerInterpretInput): InterpretOutput {
  const text = input.userRequest.toLowerCase();
  const { mandate } = input;

  const found = CATEGORY_RULES.filter(([, re]) => re.test(text)).map(([c]) => c);
  if (found.length === 0) {
    return ask(
      "Which kind of service do you need: compute, storage, data, software, design or consulting?",
    );
  }
  if (found.length > 1) {
    return ask(
      `Your request mentions several kinds of service (${found.join(", ")}). Which one should I buy?`,
    );
  }
  const category = found[0] as ServiceCategory;
  if (!mandate.allowedCategories.includes(category)) {
    return ask(
      `That is ${category}, which your mandate does not allow. Do you want something else?`,
    );
  }

  const qty =
    /\b(\d{1,4})\s*(?:x|units?|packs?|licen[cs]es|seats)\b/.exec(text) ??
    /\bx\s*(\d{1,4})\b/.exec(text);
  const quantity = Math.min(1000, Math.max(1, qty ? Number(qty[1]) : 1));

  let maxTotalMinor: number | null = null;
  let limited = false;
  const budget =
    /\b(?:under|below|max(?:imum)?|up to|at most|budget(?: of)?|no more than|less than)\s*(?:of\s*)?(?:\$|usd|eur|gbp|£|€|¥)?\s*(\d{1,12}(?:\.\d{1,2})?)/.exec(
      text,
    );
  if (budget) {
    const parsed = parseDecimalAmount(budget[1], mandate.currency);
    if (!parsed.ok) {
      return ask(
        `I could not read the budget (${parsed.reason}). What is the most you want to spend?`,
      );
    }
    if (parsed.minor === 0)
      return ask("What is the most you want to spend? It must be more than zero.");
    const ceiling = Math.min(mandate.maxTransactionMinor, mandate.remainingBudgetMinor);
    limited = parsed.minor > ceiling;
    maxTotalMinor = Math.min(parsed.minor, ceiling);
  }

  const days =
    /\bwithin\s+(\d{1,3})\s*days?\b|\bby\s+(\d{1,3})\s*days?\b|\b(\d{1,3})[- ]day\b/.exec(text);
  const dayValue = days ? Number(days[1] ?? days[2] ?? days[3]) : null;

  const wanted = /deliverables?\s*[:-]\s*([^\n]+)/.exec(text);
  const requiredDeliverables = wanted
    ? (wanted[1] as string)
        .split(/[,;]| and /)
        .map((s) => s.trim().slice(0, 200))
        .filter((s) => s.length > 0)
        .slice(0, 10)
    : [];

  const base = input.userRequest.replace(/\s+/g, " ").trim().slice(0, 260);
  return {
    kind: "INTERPRETED",
    request: {
      category,
      quantity,
      summary: limited ? `${base} (budget limited to what the mandate allows)` : base,
      maxTotalMinor,
      neededWithinDays: dayValue !== null && dayValue <= 365 ? dayValue : null,
      requiredDeliverables,
    },
  };
}

/* ------------------------------------------------------------------ comparing offers */

type Scored = {
  view: OfferView;
  total: number;
  deadlineOk: boolean;
  missing: string[];
  targetOk: boolean;
};

function score(view: OfferView, input: BuyerCompareInput): Scored {
  const { request } = input;
  const total = view.trusted.computedTotalMinor ?? Number.MAX_SAFE_INTEGER;
  const have = view.untrusted.deliverables.map((d) => d.toLowerCase());
  return {
    view,
    total,
    deadlineOk:
      request.neededWithinDays === null || view.untrusted.deliveryDays <= request.neededWithinDays,
    missing: request.requiredDeliverables.filter(
      (r) => !have.some((d) => d.includes(r.toLowerCase())),
    ),
    targetOk: request.maxTotalMinor === null || total <= request.maxTotalMinor,
  };
}

const byPreference = (a: Scored, b: Scored): number =>
  Number(b.deadlineOk) - Number(a.deadlineOk) ||
  Number(a.missing.length === 0 ? 0 : 1) - Number(b.missing.length === 0 ? 0 : 1) ||
  Number(b.targetOk) - Number(a.targetOk) ||
  a.total - b.total ||
  a.view.untrusted.deliveryDays - b.view.untrusted.deliveryDays ||
  a.view.offerId.localeCompare(b.view.offerId);

export function mockBuyerCompare(input: BuyerCompareInput): CompareOutput {
  const { offers, mandate, request } = input;
  const money = (n: number) => `${formatMinor(n, mandate.currency)} ${mandate.currency}`;
  const roundsLeft = input.round < input.maxRounds;

  if (offers.length === 0) return { kind: "NONE", reason: "There are no offers to compare yet." };

  const failures = new Map<string, HardFailure[]>(offers.map((o) => [o.offerId, hardFailures(o)]));
  const eligible = offers
    .filter((o) => (failures.get(o.offerId) ?? []).length === 0)
    .map((o) => score(o, input))
    .sort(byPreference);

  if (eligible.length === 0) {
    // Offers that fail only on price can still be worth a counter-proposal.
    const priceOnly = offers
      .filter((o) => {
        const f = failures.get(o.offerId) ?? [];
        return (
          f.length > 0 &&
          f.every((x) => x === "OVER_CAP" || x === "OVER_BUDGET") &&
          o.trusted.computedTotalMinor !== null
        );
      })
      .sort(
        (a, b) =>
          (a.trusted.computedTotalMinor ?? 0) - (b.trusted.computedTotalMinor ?? 0) ||
          a.offerId.localeCompare(b.offerId),
      );
    const target = Math.min(
      mandate.maxTransactionMinor,
      mandate.remainingBudgetMinor,
      request.maxTotalMinor ?? Number.MAX_SAFE_INTEGER,
    );
    const best = priceOnly[0];
    if (best && roundsLeft && target > 0 && target < (best.trusted.computedTotalMinor ?? 0)) {
      return {
        kind: "COUNTER",
        offerId: best.offerId,
        targetTotalMinor: target,
        note: `The total must come down to ${money(target)} or less.`,
      };
    }
    const all = [...new Set([...failures.values()].flat())].sort();
    return {
      kind: "REJECT_ALL",
      reason: `No offer is acceptable. Failed checks: ${all.join(", ") || "none recorded"}.`,
    };
  }

  const best = eligible[0] as Scored;
  const ranking = eligible.map((s) => s.view.offerId);
  const answered = input.answers.some((a) => a.offerId === best.view.offerId);

  if (roundsLeft && !answered && best.missing.length > 0) {
    return {
      kind: "ASK_SELLER",
      offerId: best.view.offerId,
      question: `Does the offer include: ${best.missing.join(", ")}?`.slice(0, 300),
    };
  }
  if (roundsLeft && !answered && !best.deadlineOk && request.neededWithinDays !== null) {
    return {
      kind: "ASK_SELLER",
      offerId: best.view.offerId,
      question: `Can you deliver within ${request.neededWithinDays} days?`,
    };
  }
  if (roundsLeft && !best.targetOk && request.maxTotalMinor !== null) {
    return {
      kind: "COUNTER",
      offerId: best.view.offerId,
      targetTotalMinor: request.maxTotalMinor,
      note: `My target is ${money(request.maxTotalMinor)} in total.`,
    };
  }

  const reasons: ("ABOVE_THRESHOLD" | "REVIEW_REQUIRED" | "RISK_SIGNALS" | "OTHER")[] = [];
  if (best.view.trusted.approval === "ABOVE_THRESHOLD") reasons.push("ABOVE_THRESHOLD");
  if (best.view.trusted.approval === "REVIEW_REQUIRED") reasons.push("REVIEW_REQUIRED");
  if (best.view.trusted.riskSignals.length > 0) reasons.push("RISK_SIGNALS");
  if (best.missing.length > 0 || !best.deadlineOk || !best.targetOk) reasons.push("OTHER");

  if (reasons.length > 0) {
    return {
      kind: "REQUEST_HUMAN_APPROVAL",
      offerId: best.view.offerId,
      reasons,
      note: `Best verified total is ${money(best.total)}. A person should decide: ${reasons.join(", ")}.`.slice(
        0,
        300,
      ),
    };
  }
  return {
    kind: "RECOMMEND",
    offerId: best.view.offerId,
    ranking,
    rationale: `Lowest verified total that meets the request: ${money(best.total)}.`,
  };
}
