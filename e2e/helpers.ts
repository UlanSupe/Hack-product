import { expect, type APIResponse, type Page } from "@playwright/test";

export const passcode = (): string => {
  const p = process.env.E2E_PASSCODE;
  if (p === undefined || p === "")
    throw new Error("E2E_PASSCODE is not set (playwright.config.ts sets it)");
  return p;
};

/** Signs in through the real sign-in form of the Negotiations page. */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/negotiations");
  await page.getByLabel("Operator passcode").fill(passcode());
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

/** The CSRF token of the current session, as the page itself would read it. */
export async function csrfToken(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const res = await fetch("/api/operator/session", { credentials: "same-origin" });
    return ((await res.json()) as { csrfToken: string }).csrfToken;
  });
}

/** A state-changing API call with the signed-in browser's cookie, CSRF token and origin (what the page itself sends). */
export async function post(page: Page, path: string, data: unknown): Promise<APIResponse> {
  return page.request.post(path, {
    data,
    headers: { "x-csrf-token": await csrfToken(page), origin: new URL(page.url()).origin },
  });
}

export const idFromUrl = (page: Page): string => {
  const n = new URL(page.url()).searchParams.get("n");
  if (n === null) throw new Error(`no ?n= in ${page.url()}`);
  return n;
};

/** Opens the fixture scenario's task through the form and returns the new negotiation's id. */
export async function openFixtureTask(page: Page): Promise<string> {
  await page.goto("/negotiations?scenario=compute-within-budget");
  await page.getByRole("button", { name: "Open negotiation" }).click();
  await expect(page.getByText("Negotiation opened.")).toBeVisible();
  await expect(page).toHaveURL(/[?&]n=neg_/);
  return idFromUrl(page);
}

export const acceptButton = (page: Page) =>
  page.getByRole("button", { name: /^Accept .* offer version \d+$/ });

/** Every console error and failed page script of a test, so a page that "works" while logging errors still fails. */
export function watchErrors(page: Page): () => string[] {
  const seen: string[] = [];
  page.on("pageerror", (e) => seen.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") seen.push(`console.error: ${m.text()}`);
  });
  return () => seen;
}

/** Horizontal overflow of the page itself (not of a scroller inside it). */
export const overflowPx = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
