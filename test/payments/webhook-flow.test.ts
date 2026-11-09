import { describe, expect, it } from "vitest";

import { MAX_WEBHOOK_BODY_BYTES } from "@/application/webhooks";
import { ForbiddenError } from "@/domain/errors";
import { MAX_READ_BEHIND_ATTEMPTS } from "@/domain/webhook";

import { unknownFailure } from "./fake-paypal";
import { WEBHOOK_ID, setupWebhooks, type WebhookHarness } from "./webhook-harness";

/**
 * Webhook handling against a scripted fake PayPal and a fake verification service. These show how OUR code reacts to
 * deliveries; they prove nothing about what PayPal really sends or how its verification service answers.
 */

async function approved(): Promise<WebhookHarness> {
  const h = setupWebhooks();
  await h.startAndApprove();
  return h;
}
async function held(): Promise<WebhookHarness> {
  const h = setupWebhooks();
  await h.startToHold();
  return h;
}
const slow = (h: WebhookHarness) => {
  const real = h.fake.provider.getOrder.bind(h.fake.provider);
  h.fake.provider.getOrder = async (id) => {
    await new Promise((r) => setTimeout(r, 5));
    return real(id);
  };
};

describe("a webhook is trusted only after PayPal's verification service says so", () => {
  it("not configured (no webhook id, or no credentials): 503, nothing read, nothing stored", async () => {
    for (const h of [setupWebhooks({ webhookId: null }), setupWebhooks({ noVerifier: true })]) {
      await h.startAndApprove();
      const before = h.reads();
      const r = await h.deliver({ event: h.approvedEvent("evt_1") });
      expect(r).toMatchObject({ http: 503, status: "NOT_CONFIGURED" });
      expect(h.reads()).toBe(before);
      expect(h.rows()).toEqual([]);
      expect(h.state()).toBe("ORDER_CREATED");
    }
  });

  it("an invalid signature is refused (401): no row, no PayPal read, no state change, a rejection audit", async () => {
    const h = await approved();
    h.fv.state.verdict = "REJECTED";
    const before = h.reads();
    const r = await h.deliver({ event: h.approvedEvent("evt_forged") });
    expect(r).toMatchObject({ http: 401, status: "REJECTED", reason: "INVALID_SIGNATURE" });
    expect(h.rows()).toEqual([]);
    expect(h.reads()).toBe(before);
    expect(h.state()).toBe("ORDER_CREATED");
    expect(h.webhookAudit().map((a) => a.type)).toEqual(["WEBHOOK_REJECTED"]);
    expect(h.chainOk()).toBe(true);
  });

  it("a forged delivery cannot squat an event id and block the genuine event", async () => {
    const h = await approved();
    h.fv.state.verdict = "REJECTED";
    await h.deliver({ event: h.approvedEvent("evt_same_id") });
    h.fv.state.verdict = "VERIFIED";
    const real = await h.deliver({ event: h.approvedEvent("evt_same_id") });
    expect(real).toMatchObject({ http: 200, status: "PROCESSED", reason: "APPLIED" });
    expect(h.state()).toBe("ORDER_APPROVED");
  });

  it("when verification cannot be completed (PayPal down) it is a 503 retry, never a pass and never stored", async () => {
    const h = await approved();
    h.fv.state.verdict = "UNAVAILABLE";
    const r = await h.deliver({ event: h.approvedEvent("evt_1") });
    expect(r).toMatchObject({ http: 503, status: "RETRY", reason: "VERIFICATION_UNAVAILABLE" });
    expect(h.rows()).toEqual([]);
    expect(h.state()).toBe("ORDER_CREATED");
  });

  it("the verifier gets our webhook id and the body byte for byte, not a re-serialization and not an id from the message", async () => {
    const h = await approved();
    const body =
      '{ "id" : "evt_raw",\n "event_type":"CHECKOUT.ORDER.APPROVED",  "webhook_id":"ATTACKER","resource":{"id":"' +
      h.fake.only().id +
      '"},"note":"café \\u00e9"}';
    await h.deliver({ event: {}, rawBody: body });
    expect(h.fv.calls).toHaveLength(1);
    expect(h.fv.calls[0]?.rawBody).toBe(body);
    expect(h.fv.calls[0]?.webhookId).toBe(WEBHOOK_ID);
    expect(h.fv.calls[0]?.headers.certUrl).toMatch(/^https:\/\/api\.sandbox\.paypal\.com\//);
  });
});

describe("malformed deliveries are rejected before any network call", () => {
  const good = (h: WebhookHarness) => h.approvedEvent("evt_1");
  const cases: [
    string,
    (h: WebhookHarness) => Parameters<WebhookHarness["deliver"]>[0],
    number,
    string,
  ][] = [
    [
      "a missing transmission id",
      (h) => ({ event: good(h), headers: { "paypal-transmission-id": null } }),
      400,
      "MALFORMED_HEADERS",
    ],
    [
      "a missing signature",
      (h) => ({ event: good(h), headers: { "paypal-transmission-sig": null } }),
      400,
      "MALFORMED_HEADERS",
    ],
    [
      "a missing algorithm",
      (h) => ({ event: good(h), headers: { "paypal-auth-algo": null } }),
      400,
      "MALFORMED_HEADERS",
    ],
    [
      "a signature with illegal characters",
      (h) => ({ event: good(h), headers: { "paypal-transmission-sig": "ab cd\n" } }),
      400,
      "MALFORMED_HEADERS",
    ],
    [
      "a certificate URL over http",
      (h) => ({
        event: good(h),
        headers: { "paypal-cert-url": "http://api.sandbox.paypal.com/c" },
      }),
      400,
      "MALFORMED_HEADERS",
    ],
    [
      "a certificate URL on another host",
      (h) => ({
        event: good(h),
        headers: { "paypal-cert-url": "https://evil.example/paypal.com" },
      }),
      400,
      "MALFORMED_HEADERS",
    ],
    [
      "a look-alike host",
      (h) => ({
        event: good(h),
        headers: { "paypal-cert-url": "https://paypal.com.evil.example/c" },
      }),
      400,
      "MALFORMED_HEADERS",
    ],
    [
      "a transmission time that is not a date",
      (h) => ({ event: good(h), headers: { "paypal-transmission-time": "yesterday" } }),
      400,
      "MALFORMED_HEADERS",
    ],
    [
      "a transmission time far in the future",
      (h) => ({ event: good(h), headers: { "paypal-transmission-time": "2026-10-20T09:00:00Z" } }),
      400,
      "TRANSMISSION_TIME_OUT_OF_RANGE",
    ],
    [
      "a transmission time older than PayPal's retry window",
      (h) => ({ event: good(h), headers: { "paypal-transmission-time": "2026-10-01T09:00:00Z" } }),
      400,
      "TRANSMISSION_TIME_OUT_OF_RANGE",
    ],
    [
      "a body that is not JSON",
      (h) => ({ event: good(h), rawBody: "not json" }),
      400,
      "MALFORMED_EVENT",
    ],
    [
      "a body that is a JSON array",
      (h) => ({ event: good(h), rawBody: "[1,2]" }),
      400,
      "MALFORMED_EVENT",
    ],
    [
      "an event with no id",
      () => ({ event: {}, rawBody: JSON.stringify({ event_type: "CHECKOUT.ORDER.APPROVED" }) }),
      400,
      "MALFORMED_EVENT",
    ],
    [
      "an event whose id is not a string",
      () => ({ event: {}, rawBody: JSON.stringify({ id: 7, event_type: "X" }) }),
      400,
      "MALFORMED_EVENT",
    ],
    [
      "a body over the size limit",
      (h) => ({
        event: good(h),
        rawBody: JSON.stringify({
          id: "e",
          event_type: "X",
          pad: "a".repeat(MAX_WEBHOOK_BODY_BYTES),
        }),
      }),
      413,
      "BODY_TOO_LARGE",
    ],
  ];

  it.each(cases)("%s", async (_name, build, http, reason) => {
    const h = await approved();
    const before = h.reads();
    const r = await h.deliver(build(h));
    expect(r).toMatchObject({ http, status: "REJECTED", reason });
    expect(h.fv.calls).toHaveLength(0);
    expect(h.reads()).toBe(before);
    expect(h.rows()).toEqual([]);
    expect(h.state()).toBe("ORDER_CREATED");
  });

  it("a flood of rejected deliveries writes only a bounded number of audit events", async () => {
    const h = await approved();
    for (let i = 0; i < 200; i++) await h.deliver({ event: {}, rawBody: "nope" });
    expect(h.webhookAudit().length).toBeLessThanOrEqual(20);
    expect(h.chainOk()).toBe(true);
  });
});

describe("a verified event is a trigger: the state change comes from reading PayPal", () => {
  it("CHECKOUT.ORDER.APPROVED records the approval only because PayPal's order says APPROVED", async () => {
    const h = await approved();
    const r = await h.deliver({ event: h.approvedEvent("evt_1") });
    expect(r).toMatchObject({ http: 200, status: "PROCESSED", reason: "APPLIED" });
    expect(h.state()).toBe("ORDER_APPROVED");
    expect(h.rows()).toEqual([
      expect.objectContaining({
        eventId: "evt_1",
        eventType: "CHECKOUT.ORDER.APPROVED",
        status: "PROCESSED",
        reason: "APPLIED",
        attempts: 1,
        deliveries: 1,
        orderId: h.fake.only().id,
        tx: h.tx,
      }),
    ]);
    expect(h.fake.count("authorizeOrder")).toBe(0); // a webhook never authorizes
    expect(h.webhookAudit().map((a) => a.type)).toEqual(["WEBHOOK_PROCESSED"]);
    expect(h.chainOk()).toBe(true);
  });

  it("a signed APPROVED event while PayPal's order is not approved changes nothing and asks to be redelivered", async () => {
    const h = setupWebhooks();
    await h.start(); // ORDER_CREATED, buyer has NOT approved
    const r = await h.deliver({ event: h.approvedEvent("evt_early") });
    expect(r).toMatchObject({ http: 503, status: "RETRY", reason: "READ_BEHIND" });
    expect(h.state()).toBe("ORDER_CREATED");
    expect(h.rows()[0]).toMatchObject({ status: "FAILED", reason: "READ_BEHIND" });
  });

  it("an event's own claims (amounts, states) are never read: a tampered order is an anomaly, not an approval", async () => {
    const h = await approved();
    h.fake.patch(h.fake.only().id, { amountMinor: 9999 });
    const r = await h.deliver({
      event: { ...h.approvedEvent("evt_lie"), summary: "Checkout order approved", amount: "80.00" },
    });
    expect(h.state()).toBe("ORDER_CREATED");
    expect(r.http).not.toBe(500);
    expect(h.auditTypes()).toContain("PAYPAL_ANOMALY");
  });

  it("AUTHORIZATION.CREATED and CAPTURE.COMPLETED after the operator's own steps are CONSISTENT: nothing to change", async () => {
    const h = await held();
    const a = await h.deliver({ event: h.authEvent("evt_a") });
    expect(a).toMatchObject({ http: 200, status: "PROCESSED", reason: "CONSISTENT" });
    await h.capture();
    const c = await h.deliver({ event: h.capEvent("evt_c") });
    expect(c).toMatchObject({ http: 200, status: "PROCESSED", reason: "CONSISTENT" });
    expect(h.state()).toBe("CAPTURED");
  });

  it("a capture whose response was lost is settled by the CAPTURE.COMPLETED webhook, with no operator action", async () => {
    const h = await held();
    h.fake.failNext({
      op: "captureAuthorization",
      when: "after",
      error: unknownFailure("TIMEOUT"),
    });
    await h.capture();
    expect(h.state()).toBe("NEEDS_RECONCILIATION");
    const r = await h.deliver({ event: h.capEvent("evt_c") });
    expect(r).toMatchObject({ http: 200, status: "PROCESSED", reason: "APPLIED" });
    expect(h.state()).toBe("CAPTURED");
    expect(h.row().captured_minor).toBe(8000);
    expect(h.fake.only().captures).toHaveLength(1);
    expect(h.fake.count("captureAuthorization")).toBe(1);
  });

  it("an authorization whose response was lost is settled by the AUTHORIZATION.CREATED webhook", async () => {
    const h = setupWebhooks();
    await h.startAndApprove();
    h.fake.failNext({ op: "authorizeOrder", when: "after", error: unknownFailure("TIMEOUT") });
    await h.authorize();
    expect(h.state()).toBe("NEEDS_RECONCILIATION");
    const r = await h.deliver({ event: h.authEvent("evt_a") });
    expect(r).toMatchObject({ http: 200, status: "PROCESSED", reason: "APPLIED" });
    expect(h.state()).toBe("AUTHORIZED");
  });

  it("a hold PayPal voided is reported by the webhook, but AUTHORIZED has no edge to VOIDED, so it is recorded as not applied", async () => {
    const h = await held();
    h.fake.patchAuthorization(h.fake.only().id, { status: "VOIDED" });
    const r = await h.deliver({ event: h.authEvent("evt_v", "PAYMENT.AUTHORIZATION.VOIDED") });
    expect(r).toMatchObject({ http: 200, status: "PROCESSED", reason: "CONSISTENT" });
    expect(h.state()).toBe("AUTHORIZED");
    expect(h.auditTypes()).toContain("PAYPAL_OBSERVATION_NOT_APPLIED");
  });

  it("CAPTURE.REFUNDED after a capture makes the payment REVERSED (no longer paid)", async () => {
    const h = await held();
    await h.capture();
    h.fake.refundCapture(h.fake.only().id);
    const r = await h.deliver({ event: h.capEvent("evt_r", "PAYMENT.CAPTURE.REFUNDED") });
    expect(r).toMatchObject({ http: 200, status: "PROCESSED", reason: "APPLIED" });
    expect(h.state()).toBe("REVERSED");
  });
});

describe("duplicates", () => {
  it("the same event delivered again is a no-op: one row, deliveries counted, no second read, no state change", async () => {
    const h = await approved();
    await h.deliver({ event: h.approvedEvent("evt_1") });
    const reads = h.reads();
    const version = h.row().version;
    for (let i = 0; i < 3; i++) {
      const again = await h.deliver({ event: h.approvedEvent("evt_1") });
      expect(again).toMatchObject({ http: 200, status: "DUPLICATE", reason: "APPLIED" });
    }
    expect(h.reads()).toBe(reads);
    expect(h.row().version).toBe(version);
    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0]).toMatchObject({ status: "PROCESSED", attempts: 1, deliveries: 4 });
    expect(h.webhookAudit().map((a) => a.type)).toEqual([
      "WEBHOOK_PROCESSED",
      "WEBHOOK_DUPLICATE",
      "WEBHOOK_DUPLICATE",
      "WEBHOOK_DUPLICATE",
    ]);
  });

  it("an ignored event is also final: a repeat does not read PayPal again", async () => {
    const h = await approved();
    await h.deliver({ event: h.event("evt_x", "BILLING.PLAN.CREATED", { id: "P-1" }) });
    const reads = h.reads();
    const again = await h.deliver({
      event: h.event("evt_x", "BILLING.PLAN.CREATED", { id: "P-1" }),
    });
    expect(again).toMatchObject({
      http: 200,
      status: "DUPLICATE",
      reason: "UNSUPPORTED_EVENT_TYPE",
    });
    expect(h.reads()).toBe(reads);
  });

  it("copies of one event arriving at the same time are processed once; the rest are told to retry, then see a duplicate", async () => {
    const h = await approved();
    slow(h);
    const out = await Promise.all(
      Array.from({ length: 6 }, () => h.deliver({ event: h.approvedEvent("evt_1") })),
    );
    expect(out.filter((r) => r.status === "PROCESSED")).toHaveLength(1);
    expect(
      out.filter((r) => r.status === "RETRY" && r.reason === "ALREADY_PROCESSING"),
    ).toHaveLength(5);
    expect(h.state()).toBe("ORDER_APPROVED");
    expect(h.rows()).toHaveLength(1);
    const late = await h.deliver({ event: h.approvedEvent("evt_1") });
    expect(late.status).toBe("DUPLICATE");
  });

  it("an event id reused with different content (even if signed) is refused and never processed", async () => {
    const h = await approved();
    await h.deliver({ event: h.approvedEvent("evt_1") });
    const reads = h.reads();
    const r = await h.deliver({
      event: { ...h.approvedEvent("evt_1"), event_type: "PAYMENT.CAPTURE.COMPLETED" },
    });
    expect(r).toMatchObject({
      http: 409,
      status: "REJECTED",
      reason: "EVENT_ID_REUSED_WITH_DIFFERENT_CONTENT",
    });
    expect(h.reads()).toBe(reads);
    expect(h.rows()[0]).toMatchObject({
      eventType: "CHECKOUT.ORDER.APPROVED",
      status: "PROCESSED",
    });
  });

  it("two different events about the same change are each recorded, and the second changes nothing", async () => {
    const h = await approved();
    await h.deliver({ event: h.approvedEvent("evt_1") });
    const v = h.row().version;
    const r = await h.deliver({ event: h.approvedEvent("evt_2") });
    expect(r).toMatchObject({ status: "PROCESSED", reason: "CONSISTENT" });
    expect(h.row().version).toBe(v);
    expect(h.rows()).toHaveLength(2);
  });
});

describe("retry after a processing failure", () => {
  it("PayPal unreadable: FAILED and a 503, then the redelivery is processed (attempts 2, deliveries 2)", async () => {
    const h = await approved();
    h.fake.failNext({ op: "getOrder", when: "before", error: unknownFailure("NETWORK") });
    const first = await h.deliver({ event: h.approvedEvent("evt_1") });
    expect(first).toMatchObject({ http: 503, status: "RETRY", reason: "READ_FAILED" });
    expect(h.state()).toBe("ORDER_CREATED");
    expect(h.rows()[0]).toMatchObject({
      status: "FAILED",
      reason: "READ_FAILED",
      attempts: 1,
      deliveries: 1,
    });

    const second = await h.deliver({ event: h.approvedEvent("evt_1") });
    expect(second).toMatchObject({ http: 200, status: "PROCESSED", reason: "APPLIED" });
    expect(h.state()).toBe("ORDER_APPROVED");
    expect(h.rows()[0]).toMatchObject({ status: "PROCESSED", attempts: 2, deliveries: 2 });
    expect(h.webhookAudit().map((a) => a.type)).toEqual(["WEBHOOK_FAILED", "WEBHOOK_PROCESSED"]);
  });

  it("an event that is ahead of PayPal's read is retried until the read catches up", async () => {
    const h = await held();
    h.fake.behaviour.captureStatus = "COMPLETED";
    h.fake.behaviour.staleReads = true;
    await h.capture(); // took effect, but reads cannot see it yet
    const event = () =>
      h.capEvent("evt_c", "PAYMENT.CAPTURE.COMPLETED", h.fake.only().captures[0]?.id);
    const first = await h.deliver({ event: event() });
    expect(first).toMatchObject({ http: 503, status: "RETRY", reason: "READ_BEHIND" });
    expect(h.state()).toBe("NEEDS_RECONCILIATION");

    h.fake.behaviour.staleReads = false;
    const second = await h.deliver({ event: event() });
    expect(second).toMatchObject({ http: 200, status: "PROCESSED", reason: "APPLIED" });
    expect(h.state()).toBe("CAPTURED");
  });

  it("a read that never catches up stops asking for redelivery after a bounded number of attempts", async () => {
    const h = await held();
    const event = () =>
      h.event("evt_ghost", "PAYMENT.CAPTURE.COMPLETED", {
        id: "CAPGHOST",
        supplementary_data: { related_ids: { order_id: h.fake.only().id } },
      });
    for (let i = 1; i < MAX_READ_BEHIND_ATTEMPTS; i++) {
      expect(await h.deliver({ event: event() })).toMatchObject({
        http: 503,
        reason: "READ_BEHIND",
      });
    }
    const last = await h.deliver({ event: event() });
    expect(last).toMatchObject({ http: 200, status: "IGNORED", reason: "READ_NEVER_CAUGHT_UP" });
    expect(h.state()).toBe("AUTHORIZED"); // an event naming a capture PayPal does not list never marks anything paid
    expect(h.row().paypal_capture_id).toBeNull();
    expect(h.rows()[0]).toMatchObject({ status: "IGNORED", attempts: MAX_READ_BEHIND_ATTEMPTS });
  });

  it("an abandoned claim (the worker died) is taken over after the stale window; a fresh one is left alone", async () => {
    const h = await approved();
    // simulate a worker that claimed the event and died: claim through the store and never finish
    const { createSqliteWebhookStore } = await import("@/adapters/sqlite/webhook-store");
    const store = createSqliteWebhookStore(h.w.db);
    const raw = JSON.stringify(h.approvedEvent("evt_1"));
    const { sha256Hex } = await import("@/domain/canonical");
    store.transaction((ops) =>
      ops.claim({
        id: "whe_dead",
        paypalEventId: "evt_1",
        eventType: "CHECKOUT.ORDER.APPROVED",
        resourceId: h.fake.only().id,
        paypalOrderId: h.fake.only().id,
        transmissionId: "tr-dead",
        payloadHash: sha256Hex(raw),
        now: h.w.clock.iso(),
        staleBefore: "2000-01-01T00:00:00.000Z",
      }),
    );
    h.w.clock.advance(1);
    expect(await h.deliver({ event: {}, rawBody: raw })).toMatchObject({
      http: 503,
      reason: "ALREADY_PROCESSING",
    });
    h.w.clock.advance(6);
    expect(await h.deliver({ event: {}, rawBody: raw })).toMatchObject({
      http: 200,
      status: "PROCESSED",
      reason: "APPLIED",
    });
    expect(h.rows()[0]).toMatchObject({ attempts: 2, status: "PROCESSED" });
  });
});

describe("unexpected, unknown and out-of-order events are ignored safely", () => {
  it("an event type this flow does not act on: IGNORED, PayPal is not asked", async () => {
    const h = await approved();
    const reads = h.reads();
    const r = await h.deliver({
      event: h.event("evt_1", "BILLING.SUBSCRIPTION.CREATED", { id: "I-1" }),
    });
    expect(r).toMatchObject({ http: 200, status: "IGNORED", reason: "UNSUPPORTED_EVENT_TYPE" });
    expect(h.reads()).toBe(reads);
  });

  it("an event that names no order: IGNORED", async () => {
    const h = await held();
    const r = await h.deliver({
      event: h.event("evt_1", "PAYMENT.AUTHORIZATION.CREATED", { id: "AUTHX" }),
    });
    expect(r).toMatchObject({ http: 200, status: "IGNORED", reason: "NO_ORDER_ID" });
  });

  it("an order id that is not shaped like one is treated as no order", async () => {
    const h = await held();
    const r = await h.deliver({
      event: h.event("evt_1", "PAYMENT.CAPTURE.COMPLETED", {
        id: "C1",
        supplementary_data: { related_ids: { order_id: "../x" } },
      }),
    });
    expect(r).toMatchObject({ status: "IGNORED", reason: "NO_ORDER_ID" });
  });

  it("an order that belongs to no transaction here: IGNORED, PayPal is not asked", async () => {
    const h = await held();
    const reads = h.reads();
    const r = await h.deliver({
      event: h.event("evt_1", "PAYMENT.CAPTURE.COMPLETED", {
        id: "C1",
        supplementary_data: { related_ids: { order_id: "NOTOURS123" } },
      }),
    });
    expect(r).toMatchObject({ http: 200, status: "IGNORED", reason: "UNKNOWN_ORDER" });
    expect(h.reads()).toBe(reads);
  });

  it("a finished transaction: IGNORED without asking PayPal", async () => {
    const h = await held();
    await h.voidHold();
    const reads = h.reads();
    const r = await h.deliver({ event: h.authEvent("evt_v", "PAYMENT.AUTHORIZATION.VOIDED") });
    expect(r).toMatchObject({ http: 200, status: "IGNORED", reason: "TERMINAL_STATE" });
    expect(h.reads()).toBe(reads);
    expect(h.state()).toBe("VOIDED");
  });

  it("an old AUTHORIZATION.CREATED arriving after the capture is SUPERSEDED and changes nothing", async () => {
    const h = await held();
    await h.capture();
    const v = h.row().version;
    const r = await h.deliver({ event: h.authEvent("evt_old") });
    expect(r).toMatchObject({ http: 200, status: "IGNORED", reason: "SUPERSEDED" });
    expect(h.row().version).toBe(v);
    expect(h.state()).toBe("CAPTURED");
  });

  it("an old CAPTURE.PENDING arriving after completion is SUPERSEDED", async () => {
    const h = await held();
    await h.capture();
    const r = await h.deliver({ event: h.capEvent("evt_p", "PAYMENT.CAPTURE.PENDING") });
    expect(r).toMatchObject({ status: "IGNORED", reason: "SUPERSEDED" });
    expect(h.state()).toBe("CAPTURED");
  });

  it("a CAPTURE.DECLINED event for a capture PayPal shows as completed is CONTRADICTED and cannot unpay it", async () => {
    const h = await held();
    await h.capture();
    const r = await h.deliver({ event: h.capEvent("evt_d", "PAYMENT.CAPTURE.DECLINED") });
    expect(r).toMatchObject({ status: "IGNORED", reason: "CONTRADICTED" });
    expect(h.state()).toBe("CAPTURED");
    expect(h.row().captured_minor).toBe(8000);
  });

  it("CAPTURE.REVERSED cannot be confirmed by the order read, so it is recorded but changes nothing", async () => {
    const h = await held();
    await h.capture();
    const r = await h.deliver({ event: h.capEvent("evt_rev", "PAYMENT.CAPTURE.REVERSED") });
    expect(r).toMatchObject({ http: 200, status: "IGNORED", reason: "NOT_CONFIRMABLE" });
    expect(h.state()).toBe("CAPTURED");
  });

  it("CAPTURE.COMPLETED while the hold was never captured at PayPal never marks the payment paid", async () => {
    const h = await held();
    const r = await h.deliver({
      event: h.event("evt_c", "PAYMENT.CAPTURE.COMPLETED", {
        id: "CAPFAKE",
        supplementary_data: { related_ids: { order_id: h.fake.only().id } },
      }),
    });
    expect(r).toMatchObject({ http: 503, reason: "READ_BEHIND" });
    expect(h.state()).toBe("AUTHORIZED");
    expect(h.row().paypal_capture_id).toBeNull();
  });

  it("a user-supplied success redirect is still not confirmation: only a webhook-triggered read or a status check moves state", async () => {
    const h = await approved();
    // there is no "redirect says paid" input anywhere in the webhook service, and an event whose order PayPal has not approved changes nothing
    const r = await h.deliver({
      event: {
        ...h.approvedEvent("evt_1"),
        resource: { id: h.fake.only().id, status: "APPROVED", success: true },
      },
    });
    expect(r.status).toBe("PROCESSED"); // because the READ said APPROVED
    const g = setupWebhooks();
    await g.start();
    const r2 = await g.deliver({
      event: {
        ...g.approvedEvent("evt_1"),
        resource: { id: g.fake.only().id, status: "APPROVED", success: true },
      },
    });
    expect(r2.status).toBe("RETRY");
    expect(g.state()).toBe("ORDER_CREATED");
  });
});

describe("only the system may reconcile from a webhook", () => {
  it("an operator, an agent or a stranger calling reconcileOrder is refused before PayPal is asked", async () => {
    const h = await approved();
    const reads = h.reads();
    for (const actor of [
      h.OP,
      { kind: "AGENT", id: "a1" } as const,
      { kind: "ANONYMOUS" } as const,
    ]) {
      await expect(h.service.reconcileOrder(actor, h.fake.only().id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect(h.reads()).toBe(reads);
    expect(h.state()).toBe("ORDER_CREATED");
  });
});

describe("persistence, history and secrets", () => {
  it("event ids, types, order and transaction ids, status, reason, attempts and deliveries are stored; the raw payload is not", async () => {
    const h = await approved();
    const body = JSON.stringify({ ...h.approvedEvent("evt_1"), payer_email: "buyer@example.com" });
    await h.deliver({ event: {}, rawBody: body });
    const row = h.w.db.prepare("SELECT * FROM webhook_events").get() as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      [
        "attempts",
        "deliveries",
        "event_type",
        "id",
        "paypal_event_id",
        "paypal_order_id",
        "payload_hash",
        "processed_at",
        "reason",
        "received_at",
        "resource_id",
        "status",
        "transaction_id",
        "transmission_id",
        "updated_at",
      ].sort(),
    );
    expect(JSON.stringify(row)).not.toContain("buyer@example.com");
    expect(row.payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the transaction history shows state changes, PayPal reads and webhook outcomes in order, with only short whitelisted details", async () => {
    const h = await approved();
    await h.deliver({ event: h.approvedEvent("evt_1") });
    await h.authorize();
    await h.deliver({ event: h.authEvent("evt_a") });
    await h.capture();
    const view = h.service.view(h.OP, h.negotiationId);
    const titles = view.history.map((e) => e.title);
    expect(titles).toContain("State changed");
    expect(titles).toContain("PayPal webhook processed");
    expect(titles).toContain("Read the order from PayPal");
    expect(view.history.map((e) => e.detail)).toContain("AUTHORIZED → CAPTURING");
    const seqs = view.history.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    for (const e of view.history) expect(e.detail.length).toBeLessThan(400);
    expect(view.state).toBe("CAPTURED");
  });

  it("neither the stored rows, the audit trail nor any response carries a secret-looking value", async () => {
    const h = await approved();
    const responses = [
      await h.deliver({ event: h.approvedEvent("evt_1") }),
      await h.deliver({ event: h.approvedEvent("evt_1") }),
    ];
    h.fv.state.verdict = "REJECTED";
    responses.push(await h.deliver({ event: h.approvedEvent("evt_2") }));
    const text = JSON.stringify([
      responses,
      h.rows(),
      h.webhookAudit(),
      h.w.db.prepare("SELECT * FROM webhook_events").all(),
    ]);
    expect(text).not.toMatch(
      /secret|password|bearer|access_token|client_id|transmission_sig|c2lnbmF0dXJl/i,
    );
    expect(h.chainOk()).toBe(true);
  });
});

describe("the database guards webhook rows on its own", () => {
  it("rejects deletes, status skips, final-row edits, forged attempts and a second row for one event id", async () => {
    const h = await approved();
    await h.deliver({ event: h.approvedEvent("evt_1") });
    const db = h.w.db;
    expect(() => db.exec("DELETE FROM webhook_events")).toThrow(/cannot be deleted/);
    expect(() => db.exec("UPDATE webhook_events SET status = 'FAILED', reason = 'X'")).toThrow(
      /final/,
    );
    expect(() =>
      db.exec("UPDATE webhook_events SET payload_hash = '" + "0".repeat(64) + "'"),
    ).toThrow(/immutable/);
    expect(() => db.exec("UPDATE webhook_events SET attempts = 9")).toThrow();
    expect(() =>
      db.exec(
        `INSERT INTO webhook_events (id, paypal_event_id, event_type, transmission_id, payload_hash, status, attempts, deliveries, received_at, updated_at)
         VALUES ('x', 'evt_1', 'T', 'tr', '${"a".repeat(64)}', 'PROCESSING', 1, 1, '2026-10-12T09:00:00.000Z', '2026-10-12T09:00:00.000Z')`,
      ),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.exec(
        `INSERT INTO webhook_events (id, paypal_event_id, event_type, transmission_id, payload_hash, status, reason, attempts, deliveries, received_at, updated_at, processed_at)
         VALUES ('y', 'evt_2', 'T', 'tr', '${"a".repeat(64)}', 'PROCESSED', 'APPLIED', 1, 1, '2026-10-12T09:00:00.000Z', '2026-10-12T09:00:00.000Z', '2026-10-12T09:00:00.000Z')`,
      ),
    ).toThrow(/must be PROCESSING/);
  });
});
