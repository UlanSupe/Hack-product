import { expect, test, type Page } from "@playwright/test";

import { acceptButton, csrfToken, openFixtureTask, post, signIn } from "./helpers";

/** Browser refresh during a transaction, double submits, a lost session and stale links. */

type Detail = {
  negotiation: {
    status: string;
    agreements: { status: string }[];
    sellers: { offers: unknown[] }[];
  };
};
const detailOf = async (page: Page, id: string): Promise<Detail["negotiation"]> => {
  const res = await page.request.get(`/api/negotiations/${id}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as Detail).negotiation;
};

test("reloading at every step of a transaction returns to the same transaction in the same state", async ({
  page,
}) => {
  await signIn(page);
  const id = await openFixtureTask(page);

  await page.reload(); // right after opening the task
  await expect(page).toHaveURL(new RegExp(`n=${id}`));
  await expect(
    page.getByText("80 GPU-hours of compute for a model fine-tuning run").first(),
  ).toBeVisible();
  await expect(page.locator(".journey-bar__line")).toContainText("3 of 8 steps done");

  await page.getByRole("button", { name: "Run the demo agents" }).click();
  await expect(page.getByText("recorded by agent").first()).toBeVisible();
  await page.reload(); // after the agents ran
  await expect(page.getByText("recorded by agent").first()).toBeVisible();
  await expect(page.locator(".journey-bar__line")).toContainText("5 of 8 steps done");

  await acceptButton(page).click();
  await expect(page.getByRole("heading", { name: "Current agreement" })).toBeVisible();
  await page.reload(); // after the agreement exists
  await expect(page.getByRole("heading", { name: "Current agreement" })).toBeVisible();
  await expect(page.locator(".journey-bar__line")).toContainText("6 of 8 steps done");
  await expect(page.getByText("Payment cannot start on this server.")).toBeVisible();

  // and from another page and back, the bar still finds the transaction
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Cockpit" })
    .click();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Current agreement" })).toBeVisible();
  const d = await detailOf(page, id);
  expect(d.agreements.filter((a) => a.status === "ACTIVE")).toHaveLength(1);
});

test("a double click on Accept creates one agreement", async ({ page }) => {
  await signIn(page);
  const id = await openFixtureTask(page);
  await page.getByRole("button", { name: "Run the demo agents" }).click();
  await expect(page.getByText("recorded by agent").first()).toBeVisible();
  await acceptButton(page).dblclick();
  await expect(page.getByRole("heading", { name: "Current agreement" })).toBeVisible();
  const d = await detailOf(page, id);
  expect(d.agreements).toHaveLength(1);
  expect(d.agreements[0]?.status).toBe("ACTIVE");
});

test("reloading in the middle of an Accept never leaves two agreements or a half state", async ({
  page,
}) => {
  await signIn(page);
  const id = await openFixtureTask(page);
  await page.getByRole("button", { name: "Run the demo agents" }).click();
  await expect(page.getByText("recorded by agent").first()).toBeVisible();
  await acceptButton(page).click();
  await page.reload(); // while the request may still be in flight
  const afterReload = await detailOf(page, id);
  expect(afterReload.agreements.length).toBeLessThanOrEqual(1);
  // whatever happened, the page shows the server's truth and the operator can finish the step
  await page.waitForLoadState("networkidle");
  if ((await page.getByRole("heading", { name: "Current agreement" }).count()) === 0)
    await acceptButton(page).click();
  await expect(page.getByRole("heading", { name: "Current agreement" })).toBeVisible();
  const final = await detailOf(page, id);
  expect(final.agreements.filter((a) => a.status === "ACTIVE")).toHaveLength(1);
  expect(final.agreements).toHaveLength(1);
});

test("a lost session mid-flow shows the sign-in again and changes nothing; signing back in resumes the same transaction", async ({
  page,
  context,
}) => {
  await signIn(page);
  const id = await openFixtureTask(page);
  await context.clearCookies(); // the session cookie is gone (expiry, another tab signing out)
  await page.getByRole("button", { name: "Run the demo agents" }).click();
  await expect(page.getByRole("heading", { name: "Operator sign-in" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`n=${id}`)); // the address still names the transaction
  await signIn(page);
  await page.goto(`/negotiations?n=${id}`);
  await expect(
    page.getByText("80 GPU-hours of compute for a model fine-tuning run").first(),
  ).toBeVisible();
  const d = await detailOf(page, id);
  expect(d.sellers.reduce((n, s) => n + s.offers.length, 0)).toBe(0); // the click that lost its session recorded nothing
});

test("a stale or mistyped transaction link recovers with a message instead of breaking", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/negotiations?n=neg_doesnotexist");
  await expect(page.getByText("That negotiation was not found.")).toBeVisible();
  await expect(page).not.toHaveURL(/neg_doesnotexist/);
  await expect(page.getByRole("button", { name: "New negotiation" })).toBeVisible();
  // a hostile id is never trusted as markup or as a query
  await page.goto("/negotiations?n=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  await expect(page.getByRole("button", { name: "New negotiation" })).toBeVisible();
});

test("hostile or malformed API input from the page's own session is a handled refusal, never a crash", async ({
  page,
}) => {
  await signIn(page);
  const csrf = await csrfToken(page);
  expect(csrf).toMatch(/^[0-9a-f]{64}$/);
  const bad = await post(page, "/api/negotiations", {
    mandateId: "M1",
    category: "COMPUTE",
    quantity: -5,
    summary: "x".repeat(10_000),
  });
  expect(bad.status()).toBe(422);
  const wrongType = await page.request.post("/api/negotiations", {
    data: "not json",
    headers: {
      "content-type": "text/plain",
      "x-csrf-token": csrf,
      origin: new URL(page.url()).origin,
    },
  });
  expect(wrongType.status()).toBe(415);
});
