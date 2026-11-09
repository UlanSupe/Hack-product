import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConsoleView, type Actions, type Confirming } from "@/app/negotiations/views";
import type { PaymentView } from "@/application/payment-views";

import { OP } from "../negotiation/world";
import { setup, type Harness } from "./harness";

const noop = () => {};
const actions: Actions = {
  startPayment: noop,
  checkPayment: noop,
  authorizePayment: noop,
  capturePayment: noop,
  voidPayment: noop,
  retry: noop,
  login: noop,
  signOut: noop,
  select: noop,
  refresh: noop,
  toggleOpen: noop,
  changeForm: noop,
  submitOpen: noop,
  runDemo: noop,
  accept: noop,
  reject: noop,
  check: noop,
  confirm: noop,
  approve: noop,
  disapprove: noop,
  close: noop,
};

function render(
  h: Harness,
  payment: PaymentView | null,
  busy: string | null = null,
  confirming: Confirming = null,
): string {
  const detail = h.w.detail(h.negotiationId);
  return renderToStaticMarkup(
    <ConsoleView
      phase={{ kind: "ready", overview: h.w.svc.overview(OP) }}
      loginError={null}
      loginBusy={false}
      selectedId={detail.id}
      detail={detail}
      detailLoading={false}
      form={null}
      formErrors={[]}
      notice={null}
      busy={busy}
      confirming={confirming}
      payment={payment}
      actions={actions}
    />,
  );
}
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("the payment panel shows only the server's verified state", () => {
  it("before the payment starts: a start button, the agreed amount, and no claim that anything was paid", () => {
    const h = setup();
    const html = render(h, h.service.view(OP, h.negotiationId));
    const t = text(html);
    expect(t).toContain("PayPal sandbox payment");
    expect(t).toContain("PayPal Sandbox (test money)");
    expect(t).toContain("Start PayPal sandbox payment");
    expect(t).toContain("80.00 USD");
    expect(t).toMatch(/Paid \(captured\) No/);
    expect(t).not.toMatch(/payment (successful|complete|confirmed)|you (have )?paid|paid in full/i);
  });

  it("while the buyer must approve: the approval link opens in a new tab with noopener, and there is no authorize button yet", async () => {
    const h = setup();
    const started = await h.start();
    const html = render(h, started.view);
    expect(html).toContain(`href="${started.view.approveUrl}"`);
    expect(html).toMatch(
      /target="_blank"[^>]*rel="noopener noreferrer"|rel="noopener noreferrer"[^>]*target="_blank"/,
    );
    const t = text(html);
    expect(t).toContain("Waiting for the buyer to approve at PayPal");
    expect(t).toContain("Check status with PayPal");
    expect(t).not.toContain("Place the hold");
  });

  it("after PayPal confirms approval: an authorize button, still not charged", async () => {
    const h = setup();
    await h.startAndApprove();
    const view = (await h.refresh()).view;
    const t = text(render(h, view));
    expect(t).toContain("PayPal says the buyer approved");
    expect(t).toContain("Place the hold (authorize)");
    expect(t).not.toContain("Open the PayPal approval page");
  });

  it("when authorized: says it is a hold and not a charge, shows the hold amount, offers capture and release but not authorize", async () => {
    const h = setup();
    await h.startAndApprove();
    const view = (await h.authorize()).view;
    const t = text(render(h, view));
    expect(t).toContain("Funds are on hold (authorized), not charged");
    expect(t).toMatch(/Hold 80\.00 USD, held until/);
    expect(t).toMatch(/Paid \(captured\) No/);
    expect(t).toContain("Capture 80.00 USD (charge the buyer)");
    expect(t).toContain("Release the hold (void)");
    expect(t).toContain("not escrow");
    expect(t).not.toContain("Place the hold");
    expect(t).not.toContain("Start PayPal sandbox payment");
    expect(t).not.toMatch(/payment (successful|complete|confirmed)|you (have )?paid|paid in full/i);
  });

  it("asking to capture or release shows a confirmation first, naming what will happen", async () => {
    const h = setup();
    await h.startAndApprove();
    const view = (await h.authorize()).view;
    const cap = text(render(h, view, null, "pay-capture"));
    expect(cap).toContain("Capture 80.00 USD? This charges the buyer's PayPal sandbox account");
    expect(cap).toContain("Yes, capture");
    expect(cap).not.toContain("Yes, release the hold");
    const rel = text(render(h, view, null, "pay-void"));
    expect(rel).toContain("Nothing will be charged");
    expect(rel).toContain("Yes, release the hold");
  });

  it("captured: PayPal's completed capture is shown as paid, still not escrow or a refund promise, and no payout", async () => {
    const h = setup();
    await h.startAndApprove();
    await h.authorize();
    const view = (await h.capture()).view;
    const html = render(h, view);
    const t = text(html);
    expect(t).toContain("Captured: PayPal reports the payment completed");
    expect(t).toMatch(/Paid \(captured\) Yes: PayPal reports the capture completed/);
    expect(t).toMatch(/Capture 80\.00 USD/);
    expect(t).toContain("not escrow");
    expect(t).toContain("nothing here promises a refund");
    expect(t).toContain("payouts are separate and not built");
    expect(t).not.toContain("Release the hold (void)");
    expect(t).not.toMatch(/escrow (protection|guarantee)|refund guarantee|guaranteed refund/i);
  });

  it("a pending capture is not shown as paid", async () => {
    const h = setup();
    await h.startAndApprove();
    await h.authorize();
    h.fake.behaviour.captureStatus = "PENDING";
    const view = (await h.capture()).view;
    const t = text(render(h, view));
    expect(t).toContain("PayPal has not completed the capture: not paid yet");
    expect(t).toMatch(/Paid \(captured\) No/);
    expect(t).not.toContain("Captured: PayPal reports");
    expect(t).toContain("Check status with PayPal");
  });

  it("a released hold says nothing was charged", async () => {
    const h = setup();
    await h.startAndApprove();
    await h.authorize();
    const view = (await h.voidHold()).view;
    const t = text(render(h, view));
    expect(t).toContain("The hold was released");
    expect(t).toMatch(/Paid \(captured\) No/);
    expect(t).not.toContain("Capture 80.00 USD (charge the buyer)");
  });

  it("an unknown outcome is shown as unknown, with a status check, and never as a hold", async () => {
    const h = setup();
    h.fake.behaviour.createAmountDelta = 1;
    const view = (await h.start()).view;
    const t = text(render(h, view));
    expect(t).toContain("The outcome is unknown: needs a status check");
    expect(t).toContain("Check status with PayPal");
    expect(t).toContain("AMOUNT_MISMATCH");
    expect(t).not.toContain("on hold");
    expect(t).not.toContain("Open the PayPal approval page");
  });

  it("a failed payment says nothing was charged and offers no retry button", async () => {
    const h = setup();
    await h.startAndApprove();
    h.fake.behaviour.authorizationStatus = "DENIED";
    const view = (await h.authorize()).view;
    const t = text(render(h, view));
    expect(t).toContain("The payment failed; nothing was charged");
    expect(t).not.toContain("Start PayPal sandbox payment");
  });

  it("buttons are disabled while another action is running", () => {
    const h = setup();
    const html = render(h, h.service.view(OP, h.negotiationId), "pay:start");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Starting…/);
  });

  it("the attempts list shows PayPal's reference ids but nothing else", async () => {
    const h = setup();
    const view = (await h.start()).view;
    const t = text(render(h, view));
    expect(t).toContain("create order #1: succeeded (HTTP 201)");
    expect(t).toContain("PayPal reference dbg_create_ok");
  });

  it("no PayPal host, credential name or client code is hard-coded in the page", () => {
    const h = setup();
    const html = render(h, h.service.view(OP, h.negotiationId));
    expect(html).not.toMatch(
      /api-m\.sandbox\.paypal\.com|client_secret|PAYPAL_CLIENT|access_token/i,
    );
  });
});
