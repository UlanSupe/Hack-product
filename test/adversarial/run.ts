import { createHash } from "node:crypto";

import { DEMO_SELLER_CONFIG, createBuyerAgent, createSellerAgent, runNegotiation } from "@/agents";
import { createHostileSellerModel, type HostileScript } from "@/agents/hostile-seller";
import { createMockBuyerModel, createMockSellerModel } from "@/agents/mock-models";
import { readAuditEvents, verifyChain } from "@/adapters/sqlite/audit";
import { transitionTransaction } from "@/adapters/sqlite/store";
import type { NegotiationActor } from "@/domain/negotiation";
import { canonicalJson } from "@/domain/canonical";
import { ConflictError, ForbiddenError, NotFoundError } from "@/domain/errors";
import { evaluatePolicy } from "@/domain/policy";

import {
  FAST,
  MANDATE,
  REQUEST,
  compareInput,
  manualClock,
  scripted,
  text,
  view,
} from "../agents/helpers";
import { policyInputFor } from "../agents/policy-bridge";
import { reseal, valid } from "../policy/fixtures";
import { buildWorld, type AdversarialWorld } from "./world";
import type { ActorKind, AuditExpect, Expect, Patch, Scenario, Step } from "./types";

/** What one step did, in plain data. `good` means "it did what its author wanted" (used to check setup steps). */
export type Outcome = { kind: string; good: boolean } & Record<string, unknown>;

export type Result = {
  id: string;
  pass: boolean;
  /** Human-readable mismatches. Empty when the scenario passed. */
  failures: string[];
  /** Everything observable, in a stable form: two runs of the same scenario must produce the same transcript. */
  transcript: {
    outcomes: Outcome[];
    txStates: string[];
    capturedMinor: number;
    paypalCalls: string[];
    audit: {
      type: string;
      actor: string;
      provenance: string | null;
      payload: string;
      hash: string;
    }[];
  };
  transcriptHash: string;
};

const ids = { OPERATOR: "op1", AGENT: "agent1", SYSTEM: "sys1" } as const;
const actorOf = (k: ActorKind = "OPERATOR"): NegotiationActor =>
  k === "ANONYMOUS" ? { kind: "ANONYMOUS" } : { kind: k, id: ids[k] };

const MONEY_OPS = new Set([
  "createOrder",
  "authorizeOrder",
  "captureAuthorization",
  "voidAuthorization",
]);

/* ------------------------------------------------------------------ helpers */

function classify(e: unknown): Record<string, unknown> {
  const message = e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240);
  if (e instanceof ForbiddenError) return { ok: false, error: "FORBIDDEN", message };
  if (e instanceof ConflictError) return { ok: false, error: "CONFLICT", message };
  if (e instanceof NotFoundError) return { ok: false, error: "NOT_FOUND", message };
  return { ok: false, error: "REFUSED_BY_DATABASE_OR_CODE", message };
}

type Parsed<T> =
  { ok: true; value: T } | { ok: false; errors: { field: string; message: string }[] };
function fromResult<T>(
  r: Parsed<T>,
  map: (v: T) => Record<string, unknown>,
): Record<string, unknown> {
  if (!r.ok) return { ok: false, error: "VALIDATION", fields: r.errors.map((e) => e.field).sort() };
  return { ok: true, ...map(r.value) };
}

function setPath(target: unknown, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = target as Record<string, unknown>;
  for (const [i, p] of parts.entries()) {
    if (i === parts.length - 1) {
      if (value === undefined) delete cur[p];
      else cur[p] = value;
      return;
    }
    const next = cur[p];
    if (next === null || typeof next !== "object")
      throw new Error(`patch path ${path}: ${p} is not an object`);
    cur = next as Record<string, unknown>;
  }
}

const txRows = (w: AdversarialWorld) =>
  w.w.db.prepare("SELECT id, state FROM transactions ORDER BY rowid").all() as {
    id: string;
    state: string;
  }[];

/* ------------------------------------------------------------------ step executor */

type Refs = { negs: Map<string, string>; proposals: Map<string, string> };

async function executeStep(world: AdversarialWorld, refs: Refs, step: Step): Promise<Outcome> {
  const { w, fake, fv, payments, webhooks, mandates } = world;
  const negId = (name = "main"): string => {
    const id = refs.negs.get(name);
    if (!id) throw new Error(`scenario error: no negotiation named "${name}" has been opened`);
    return id;
  };
  const propId = (name: string): string => {
    const id = refs.proposals.get(name);
    if (!id) throw new Error(`scenario error: no proposal named "${name}"`);
    return id;
  };
  const wrap = async (
    kind: string,
    run: () => Promise<Record<string, unknown>> | Record<string, unknown>,
  ): Promise<Outcome> => {
    try {
      const r = await run();
      return {
        kind,
        good: r.good === true || (r.good === undefined && r.ok === true),
        ...r,
      };
    } catch (e) {
      return { kind, good: false, ...classify(e) };
    }
  };

  switch (step.do) {
    case "open":
      return wrap("open", () =>
        fromResult(
          w.svc.open(actorOf(step.actor), {
            mandateId: "M1",
            category: "COMPUTE",
            quantity: 1,
            summary: "One GPU pack for model training",
            maxTotal: null,
            neededWithinDays: null,
            requiredDeliverables: [],
            invitedSellerIds: ["seller_acme", "seller_other"],
            timeoutMinutes: 120,
            ...step.over,
          }),
          (v) => {
            refs.negs.set(step.neg ?? "main", v.id);
            return { good: true };
          },
        ),
      );

    case "offer":
      return wrap("offer", () => {
        const priced =
          step.unit !== undefined ? w.priced(step.unit, step.qty ?? 1, step.sku ?? "GPU-PACK") : {};
        return fromResult(
          w.svc.submitOffer(
            actorOf(step.actor ?? "AGENT"),
            w.offerInput(
              negId(step.neg),
              step.seller ?? "seller_acme",
              { ...priced, ...step.offer },
              step.top,
            ),
          ),
          (v) => {
            refs.proposals.set(step.as, v.id);
            return { good: true, proposalStatus: v.status };
          },
        );
      });

    case "counter":
      return wrap("counter", () =>
        fromResult(
          w.svc.submitCounter(actorOf(step.actor ?? "AGENT"), {
            negotiationId: negId(step.neg),
            sellerId: step.seller ?? "seller_acme",
            currency: "USD",
            category: "COMPUTE",
            targetTotalMinor: 7000,
            deliverables: ["80 GPU-hours", "Usage report"],
            deliveryDays: 3,
            note: "Can you do this price?",
            validForMinutes: 60,
            ...step.over,
          }),
          (v) => {
            refs.proposals.set(step.as, v.id);
            return { good: true };
          },
        ),
      );

    case "accept":
      return wrap("accept", () =>
        fromResult(
          w.svc.accept(actorOf(step.actor), {
            negotiationId: negId(step.neg),
            proposalId: propId(step.proposal),
            ...step.raw,
          }),
          (v) => ({
            good: v.accepted,
            accepted: v.accepted,
            verdict: v.accepted ? "ALLOW" : "DENY",
            reasonCodes: [...v.policy.reasonCodes].sort(),
            retired: v.retired !== null,
            approvalRequirement: v.policy.approvalRequirement,
          }),
        ),
      );

    case "approve":
    case "disapprove":
    case "eligibility":
      return wrap(step.do, () => {
        const actor = actorOf(step.actor);
        const arg = { negotiationId: negId(step.neg) };
        if (step.do === "disapprove") {
          return fromResult(w.svc.disapprove(actor, arg), () => ({ good: true }));
        }
        const r =
          step.do === "approve" ? w.svc.approve(actor, arg) : w.svc.checkEligibility(actor, arg);
        return fromResult(r, (v) => ({
          good: v.state === "ELIGIBLE" || v.state === "AWAITING_APPROVAL",
          eligibility: v.state,
          verdict: v.policy?.verdict ?? null,
          reasonCodes: v.policy ? [...v.policy.reasonCodes].sort() : [],
        }));
      });

    case "pay":
      return wrap("pay", async () => {
        const actor = actorOf(step.actor);
        const n = negId(step.neg);
        const fn = {
          start: () => payments.start(actor, n),
          refresh: () => payments.refresh(actor, n),
          authorize: () => payments.authorize(actor, n),
          capture: () => payments.capture(actor, n),
          void: () => payments.voidHold(actor, n),
        }[step.op];
        const r = await fn();
        return {
          ok: true,
          good: r.performed && r.policy?.verdict !== "DENY",
          performed: r.performed,
          verdict: r.policy?.verdict ?? null,
          reasonCodes: r.policy ? [...r.policy.reasonCodes].sort() : [],
          paymentState: r.view.state,
        };
      });

    case "paypal":
      return wrap("paypal", () => {
        if (step.set) Object.assign(fake.behaviour, step.set);
        if (step.buyerApproves) fake.approve(fake.only().id);
        if (step.addCapture) fake.addCapture(fake.only().id, step.addCapture);
        return { ok: true, good: true };
      });

    case "clock":
      return wrap("clock", () => {
        w.clock.advance(step.minutes);
        return { ok: true, good: true };
      });

    case "webhook":
      return wrap("webhook", async () => {
        fv.state.verdict = step.verdict ?? "VERIFIED";
        const order = [...fake.orders.values()][0];
        const orderId = order?.id ?? "ORDER-NONE";
        const type = {
          ORDER_APPROVED: "CHECKOUT.ORDER.APPROVED",
          AUTHORIZATION_CREATED: "PAYMENT.AUTHORIZATION.CREATED",
          CAPTURE_COMPLETED: "PAYMENT.CAPTURE.COMPLETED",
          CAPTURE_DENIED: "PAYMENT.CAPTURE.DENIED",
          UNKNOWN_TYPE: "BILLING.SUBSCRIPTION.CREATED",
        }[step.event];
        const related = (rid: string) => ({
          id: rid,
          supplementary_data: { related_ids: { order_id: orderId } },
        });
        const resource =
          step.resource ??
          (step.event === "ORDER_APPROVED" || step.event === "UNKNOWN_TYPE"
            ? { id: orderId }
            : step.event === "AUTHORIZATION_CREATED"
              ? related(order?.authorization?.id ?? "AUTH-NONE")
              : related(order?.captures.at(-1)?.id ?? "CAP-NONE"));
        const body = JSON.stringify({
          id: step.id,
          event_type: type,
          resource_type: type.split(".")[1]?.toLowerCase() ?? "unknown",
          create_time: w.clock.iso(),
          resource,
        });
        const headers: Record<string, string | null> = {
          "paypal-transmission-id": `tr-${step.id}`,
          "paypal-transmission-time": w.clock.iso(),
          "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST",
          "paypal-transmission-sig": "c2lnbmF0dXJlLXRlc3Q=",
          "paypal-auth-algo": "SHA256withRSA",
          ...step.headers,
        };
        let r = { http: 0, status: "", reason: "" };
        for (let i = 0; i < (step.times ?? 1); i++) {
          r = await webhooks.handle({
            header: (name) => headers[name.toLowerCase()] ?? null,
            rawBody: step.rawBody ?? body,
          });
        }
        return { ok: true, good: r.http < 300, http: r.http, status: r.status, reason: r.reason };
      });

    case "policy":
      return wrap("policy", () => {
        const input = valid(step.subject);
        for (const [path, value] of step.patch ?? ([] as readonly Patch[]))
          setPath(input, path, value);
        if (step.resealMandate) reseal(input);
        const d = evaluatePolicy(input);
        return {
          ok: true,
          good: d.verdict === "ALLOW",
          verdict: d.verdict,
          subject: d.subject,
          reasonCodes: [...d.reasonCodes],
          approvalRequirement: d.approvalRequirement,
        };
      });

    case "transition":
      return wrap("transition", () => {
        const row = w.db
          .prepare(
            "SELECT t.id AS id, t.version AS version FROM negotiation_agreements l JOIN transactions t ON t.id = l.transaction_id WHERE l.negotiation_id = ? ORDER BY l.version DESC LIMIT 1",
          )
          .get(negId(step.neg)) as { id: string; version: number } | undefined;
        if (!row) throw new Error("scenario error: no transaction to transition");
        transitionTransaction(w.db, {
          id: row.id,
          expectedVersion: row.version,
          to: step.to,
          now: w.clock.iso(),
          actor: "SYSTEM",
        });
        return { ok: true, good: true };
      });

    case "sql":
      return wrap("sql", () => {
        const r = w.db.prepare(step.sql).run(...(step.params ?? []));
        return { ok: true, good: true, changes: Number(r.changes) };
      });

    case "mandate":
      return wrap("mandate", () => {
        const actor = actorOf(step.actor);
        if (step.op === "revoke") {
          return fromResult(
            mandates.revoke(actor as never, { mandateId: "M1", expectedVersion: 1 }),
            () => ({ good: true }),
          );
        }
        const fields = {
          currency: "USD",
          totalBudget: "150.00",
          maxTransactionAmount: step.capAmount ?? "100.00",
          approvalThreshold: step.capAmount ?? "50.00",
          allowedCategories: ["COMPUTE"],
          allowedSellerIds: ["seller_acme", "seller_other"],
          requireReviewBeforeExecution: false,
          validDays: 30,
        };
        if (step.op === "approveDraft") {
          return fromResult(
            mandates.approveDraft(actor as never, { draftId: "drf_adv_1", revision: 1 }),
            () => ({ good: true }),
          );
        }
        const draft = mandates.createDraft(actor as never, {
          fields,
          basedOn: { mandateId: "M1", version: 1 },
        });
        if (step.op === "createDraft" || !draft.ok)
          return fromResult(draft, () => ({ good: true }));
        return fromResult(
          mandates.approveDraft(actor as never, {
            draftId: draft.value.id,
            revision: draft.value.revision,
          }),
          (v) => ({ good: true, newMandateVersion: v.version }),
        );
      });

    case "agentRun":
      return wrap("agentRun", async () => {
        const seller = createSellerAgent({
          model:
            step.script === "HONEST"
              ? createMockSellerModel(DEMO_SELLER_CONFIG)
              : createHostileSellerModel(DEMO_SELLER_CONFIG, step.script as HostileScript),
          config: DEMO_SELLER_CONFIG,
          enforceConstraints: false,
          runtime: FAST,
          clock: manualClock(),
        });
        const buyer = createBuyerAgent({
          model: createMockBuyerModel(),
          runtime: FAST,
          clock: manualClock(),
        });
        const catalog = DEMO_SELLER_CONFIG.catalog.map((i) => ({
          sku: i.sku,
          category: i.category,
          unitPriceMinor: i.listPriceMinor,
        }));
        const out = await runNegotiation({
          userRequest: step.request ?? REQUEST.summary,
          mandate: MANDATE,
          buyer,
          sellers: [
            { sellerId: DEMO_SELLER_CONFIG.sellerId, agent: seller, sellerAllowed: true, catalog },
          ],
        });
        const offer = out.offers[0];
        const decision = offer ? evaluatePolicy(policyInputFor(offer, DEMO_SELLER_CONFIG)) : null;
        return {
          ok: true,
          good: true,
          agentStatus: out.status,
          authority: out.authority,
          riskSignals: [...(out.derived?.riskSignals ?? [])].sort(),
          verdict: decision?.verdict ?? null,
          reasonCodes: decision ? [...decision.reasonCodes] : [],
          approvalRequirement: decision?.approvalRequirement ?? null,
          question: out.question !== null,
        };
      });

    case "modelReply":
      return wrap("modelReply", async () => {
        const model = scripted(text(step.reply));
        const buyer = createBuyerAgent({ model, runtime: FAST, clock: manualClock() });
        const r = await buyer.compare(compareInput([view("offer-1"), view("offer-2")]));
        return {
          ok: r.ok,
          good: r.ok,
          failureKind: r.ok ? null : r.failure.kind,
          attempts: r.ok ? r.attempts : r.failure.attempts,
          outputKind: r.output.kind,
          authority: "ADVISORY_ONLY",
        };
      });
  }
}

/* ------------------------------------------------------------------ matching */

function subsetMismatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  where: string,
): string[] {
  const out: string[] = [];
  for (const [k, want] of Object.entries(expected)) {
    if (k === "messageIncludes") {
      const msg = typeof actual.message === "string" ? actual.message : "";
      if (!msg.includes(String(want)))
        out.push(
          `${where}: message should include ${JSON.stringify(want)} but was ${JSON.stringify(msg)}`,
        );
      continue;
    }
    const got = actual[k];
    if (canonicalJson(got ?? null) !== canonicalJson(want ?? null))
      out.push(
        `${where}.${k}: expected ${JSON.stringify(want)} but got ${JSON.stringify(got ?? null)}`,
      );
  }
  return out;
}

function auditMismatches(
  events: ReturnType<typeof readAuditEvents>,
  want: readonly AuditExpect[],
  forbid: readonly string[],
): string[] {
  const out: string[] = [];
  let from = 0;
  for (const [i, w] of want.entries()) {
    let found = -1;
    for (let j = from; j < events.length; j++) {
      const e = events[j];
      if (!e || e.type !== w.type) continue;
      if (w.actor && e.actor !== w.actor) continue;
      if (w.provenance && e.provenance !== w.provenance) continue;
      if (w.payload) {
        const payload = JSON.parse(e.payload) as Record<string, unknown>;
        if (
          Object.entries(w.payload).some(
            ([k, v]) => canonicalJson(payload[k] ?? null) !== canonicalJson(v ?? null),
          )
        )
          continue;
      }
      found = j;
      break;
    }
    if (found < 0) {
      out.push(
        `audit[${i}]: expected an event ${JSON.stringify(w)} after position ${from}; the trail has ${events.length} events: ${events.map((e) => e.type).join(", ") || "(none)"}`,
      );
      break; // later expectations depend on this one's position
    }
    from = found + 1;
  }
  for (const f of forbid) {
    if (events.some((e) => e.type === f))
      out.push(`audit: event type ${f} must not appear but does`);
  }
  return out;
}

/* ------------------------------------------------------------------ the oracle (every scenario) */

/**
 * Invariants that must hold after ANY scenario, whatever it expected: these are the product's promises, checked
 * independently of what the fixture author wrote.
 */
function universalViolations(world: AdversarialWorld): string[] {
  const { w, fake } = world;
  const out: string[] = [];

  const chain = verifyChain(w.db);
  if (chain.status !== "VERIFIED")
    out.push(`audit chain failed: seq ${chain.firstBadSeq} ${chain.code}`);

  // What WE asked PayPal to capture must be exactly the agreed amount and never above the cap. (What PayPal then
  // records is PayPal's behaviour; scenarios that make it misbehave check the consequence via txStates/audit.)
  const cap = w.cell<number>("SELECT MAX(per_tx_cap_minor) FROM mandates WHERE id = 'M1'");
  for (const call of fake.calls) {
    if (call.op !== "captureAuthorization") continue;
    const asked = call.amountMinor ?? 0;
    if (asked > cap) out.push(`a capture of ${asked} was requested, above the mandate cap ${cap}`);
    const agreed = w.db
      .prepare(
        "SELECT a.total_minor AS total, a.currency AS cur FROM transactions t JOIN agreements a ON a.id = t.agreement_id WHERE t.paypal_authorization_id = ?",
      )
      .get(call.authorizationId ?? "") as { total: number; cur: string } | undefined;
    if (!agreed)
      out.push(
        `a capture was requested for authorization ${call.authorizationId ?? "?"}, which no agreement owns`,
      );
    else if (agreed.total !== asked || agreed.cur !== call.currency)
      out.push(
        `a capture of ${asked} ${call.currency ?? "?"} was requested but the agreement is ${agreed.total} ${agreed.cur}`,
      );
  }

  const unconfirmed = w.db
    .prepare(
      "SELECT id FROM transactions WHERE state = 'CAPTURED' AND (paypal_capture_id IS NULL OR captured_minor IS NULL)",
    )
    .all();
  if (unconfirmed.length > 0)
    out.push("a transaction is CAPTURED without a recorded PayPal capture");

  const total = w.cell<number>(
    "SELECT COALESCE(SUM(a.total_minor), 0) FROM transactions t JOIN agreements a ON a.id = t.agreement_id WHERE t.state IN ('CAPTURED')",
  );
  const budget = w.cell<number>("SELECT MAX(total_budget_minor) FROM mandates WHERE id = 'M1'");
  if (total > budget) out.push(`captured total ${total} exceeds the budget ${budget}`);
  return out;
}

/* ------------------------------------------------------------------ run one scenario */

export async function runScenario(s: Scenario): Promise<Result> {
  const world = buildWorld(s.initial);
  const refs: Refs = { negs: new Map(), proposals: new Map() };
  const failures: string[] = [];
  const outcomes: Outcome[] = [];

  for (const [i, step] of s.initial.steps.entries()) {
    const o = await executeStep(world, refs, step);
    outcomes.push(o);
    if (!o.good)
      failures.push(
        `setup step ${i} (${step.do}) did not do what it was meant to: ${JSON.stringify(o)}`,
      );
  }
  const floor = readAuditEvents(world.w.db).length; // audit expectations are about what the ATTACK caused
  const callFloor = world.fake.calls.length; // ...and so are the money-moving PayPal calls
  if (failures.length === 0) {
    for (const step of s.attack) outcomes.push(await executeStep(world, refs, step));
  }

  const { w, fake } = world;
  const last = outcomes.at(-1);
  const events = readAuditEvents(w.db);
  const txStates = txRows(world).map((t) => t.state);
  const capturedMinor = [...fake.orders.values()]
    .flatMap((o) => o.captures)
    .filter((c) => c.status === "COMPLETED")
    .reduce((a, c) => a + c.amountMinor, 0);
  const paypalCalls = fake.calls
    .slice(callFloor)
    .map((c) => c.op)
    .filter((op) => MONEY_OPS.has(op));

  if (failures.length === 0 && last) {
    const ex: Expect = s.expect;
    failures.push(...subsetMismatch(last, ex.outcome, "outcome"));
    if (canonicalJson(txStates) !== canonicalJson(ex.txStates))
      failures.push(
        `txStates: expected ${JSON.stringify(ex.txStates)} but got ${JSON.stringify(txStates)}`,
      );
    if (capturedMinor !== (ex.capturedMinor ?? 0))
      failures.push(`capturedMinor: expected ${ex.capturedMinor ?? 0} but got ${capturedMinor}`);
    if (canonicalJson(paypalCalls) !== canonicalJson(ex.paypalCalls ?? []))
      failures.push(
        `paypalCalls: expected ${JSON.stringify(ex.paypalCalls ?? [])} but got ${JSON.stringify(paypalCalls)}`,
      );
    const caused = events.slice(floor);
    // an empty list is a claim too: the attack must have left NO audit events (a refusal that wrote nothing)
    if (ex.audit.length === 0 && caused.length > 0)
      failures.push(
        `audit: expected no audit events from the attack but found ${caused.map((e) => e.type).join(", ")}`,
      );
    failures.push(...auditMismatches(caused, ex.audit, ex.forbidAudit ?? []));
    for (const r of ex.rows ?? []) {
      if (!/^\s*select\b/i.test(r.sql)) {
        failures.push(`rows: only SELECT is allowed (${r.sql})`);
        continue;
      }
      const got = w.cell<string | number | null>(r.sql, ...(r.params ?? []));
      if (got !== r.equals)
        failures.push(
          `rows: ${r.sql} expected ${JSON.stringify(r.equals)} but got ${JSON.stringify(got ?? null)}`,
        );
    }
    failures.push(...universalViolations(world).map((v) => `invariant: ${v}`));
  }

  const transcript = {
    outcomes: outcomes.map((o) => JSON.parse(canonicalJson(o)) as Outcome),
    txStates,
    capturedMinor,
    paypalCalls,
    audit: events.map((e) => ({
      type: e.type,
      actor: e.actor,
      provenance: e.provenance,
      payload: e.payload,
      hash: e.hash,
    })),
  };
  return {
    id: s.id,
    pass: failures.length === 0,
    failures,
    transcript,
    transcriptHash: createHash("sha256").update(canonicalJson(transcript)).digest("hex"),
  };
}
