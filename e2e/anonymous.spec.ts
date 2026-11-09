import { expect, test } from "@playwright/test";

import { overflowPx, watchErrors } from "./helpers";

/** What anyone can see and do without a credential. */

test("the start page offers the journey, labels fixtures and simulations, and loads without errors", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Start a transaction scenario" }),
  ).toBeVisible();
  await expect(page.getByText("Fixture task · real records")).toBeVisible();
  await expect(page.getByText("Simulation · throwaway data")).toBeVisible();
  await expect(page.getByRole("list", { name: /Transaction journey, nine steps/ })).toBeVisible();
  await expect(page.getByText("Progress is tracked for the signed-in operator")).toBeVisible();
  await expect(page.getByText("PayPal Sandbox only")).toBeVisible();
  expect(errors()).toEqual([]);
});

test("the Arena shows two distinct buyers and says all money is simulated", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/arena");
  await expect(
    page.getByRole("heading", { name: "Intentionally unsafe baseline", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Protected PactPay buyer", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("UNSAFE BY DESIGN").first()).toBeVisible();
  await expect(page.getByText("POLICY ENFORCED").first()).toBeVisible();
  await expect(page.getByText("An experiment, not a payment.")).toBeVisible();
  await page.getByRole("button", { name: "Replay this run" }).click();
  await expect(page.getByText("replay produced the identical run")).toBeVisible();
  expect(errors()).toEqual([]);
});

test("the replay: the unsafe baseline pays on a simulated ledger and the protected buyer is refused with a reason", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto("/flagship");
  await expect(
    page.getByRole("heading", { level: 1, name: /budget escalation attack/i }),
  ).toBeVisible();
  await expect(page.getByText(/OVER_PER_TX_CAP/).first()).toBeVisible();
  await expect(page.getByText("SIMULATED LEDGER ONLY").first()).toBeVisible();
  await page.getByLabel("Seller’s revision").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Run the attack" }).click();
  await expect(page).toHaveURL(/variant=ESCALATE_28/);
  await expect(
    page.getByRole("heading", { level: 1, name: /budget escalation attack/i }),
  ).toBeVisible();
  expect(errors()).toEqual([]);
});

test("the Cockpit analytics print every ratio with its denominator", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/cockpit");
  await page.getByRole("button", { name: "Analytics" }).click();
  await expect(page.getByRole("heading", { name: "What these figures count" })).toBeVisible();
  await expect(page.getByText(/Completed \(the policy results below\)/)).toBeVisible();
  await expect(page.getByText(/\d+ of \d+ \(\d+\.\d%\)/).first()).toBeVisible();
  await expect(page.getByText("“not recorded” is not “verified”")).toBeVisible();
  await expect(page).toHaveURL(/view=analytics/);
  await expect(page.locator(".ag-row").first()).toBeVisible(); // the AG Grid category table rendered
  // a filter narrows the analytics and the address
  await page.getByLabel("Buyer mode").selectOption("PROTECTED");
  await expect(page).toHaveURL(/mode=PROTECTED/);
  await expect(page.getByText(/Benchmark runs in view/)).toBeVisible();
  expect(errors()).toEqual([]);
});

test("anonymous visitors get a sign-in form, never data, and every payment or administrative API refuses them", async ({
  page,
}) => {
  await page.goto("/negotiations");
  await expect(page.getByRole("heading", { name: "Operator sign-in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  for (const [method, path] of [
    ["GET", "/api/negotiations"],
    ["POST", "/api/negotiations"],
    ["GET", "/api/mandates"],
    ["GET", "/api/journey"],
    ["POST", "/api/negotiations/neg_x/payment"],
    ["POST", "/api/negotiations/neg_x/payment/capture"],
    ["POST", "/api/negotiations/neg_x/payment/void"],
  ] as const) {
    const res =
      method === "GET" ? await page.request.get(path) : await page.request.post(path, { data: {} });
    expect(res.status(), `${method} ${path}`).toBe(401);
  }
});

test("keyboard: the first Tab reaches a visible skip link that jumps to the content", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to the main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
});

test("@mobile no public page scrolls sideways at phone width, and the navigation is reachable", async ({
  page,
}) => {
  for (const path of ["/", "/arena", "/flagship", "/cockpit", "/mandate", "/negotiations"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    expect(await overflowPx(page), `${path} overflows by`).toBeLessThanOrEqual(0);
  }
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Cockpit" })
    .click();
  await expect(page).toHaveURL(/\/cockpit$/);
});
