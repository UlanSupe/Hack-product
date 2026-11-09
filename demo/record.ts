// Records the browser scenes of the demo video, timed to the narration clips: node demo/record.ts [--payment 5A|5B] ...
//
// It drives the real production build in the installed Microsoft Edge (the same way the Playwright suite does) and records
// the page. Nothing on screen is faked: the pages are the app's own, the payment scene shows the app's own payment panel.
//
//   --base <url>      where `npm start` listens (default http://localhost:3000)
//   --payment 5B|5A   5B (default): this server has no PayPal credentials and the panel says so.
//                     5A: LIVE. Scene 4B runs the real model on camera (needs AGENT_MODE=llm), scene 5A performs a real PayPal
//                     Sandbox payment on camera: start, the PayPal login page, hold, capture, Cockpit. The buyer's login and
//                     approval at PayPal happen OFF camera: the capture pauses while you do them in the visible Edge window and
//                     resumes when the app is back. The script REFUSES to finish unless the panel itself reports a captured
//                     payment (checks G1 and G2 of docs/DEMO_SCRIPT.md). It creates two agreements (60.00 each of the budget).
//   --neg <id>        5B only: reuse a negotiation instead of creating a new agreement.
//   --synthetic       timings from the word count (150 words/minute) instead of recorded audio: a framing/timing rehearsal only
//   --out <dir>       work directory (default demo/work)
//
// OPERATOR_PASSCODE is read from the environment or .env.local (never printed). It is used off camera, in a separate browser
// context, to sign in and (for 5B) to create the synthetic negotiation; the recorded context only receives the resulting session.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";

type Clip = { id: string; scene: string; windowSeconds: number; text: string };
type SceneLog = { id: string; startS: number; audioStartS: number; endS: number };
type CueRun = { scene: string; name: string; startS: number; endS: number };
type Rect = { x: number; y: number; w: number; h: number };
type Snap = {
  scene: string;
  state: string;
  tS: number;
  rects: Record<string, Rect>;
  texts: Record<string, string>;
  hires: string;
};
/** Where an element is on the page: found by its visible text (deepest element), then `up` ancestors, or by CSS + closest(). */
type Target = {
  text?: string;
  nth?: number;
  up?: number;
  exact?: boolean;
  css?: string;
  closest?: string;
};

if (existsSync(".env.local")) process.loadEnvFile(".env.local"); // never overrides variables that are already set

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = (opt("base") ?? "http://localhost:3000").replace(/\/+$/, "");
const payment = opt("payment") ?? "5B";
const negArg = opt("neg");
const synthetic = args.includes("--synthetic");
const work = opt("out") ?? join("demo", "work");
const LEAD_S = 0.4; // after the page is ready, before the narration starts
const TAIL_S = 0.8; // after the narration ends, before the next scene
const VIEW = { width: 1280, height: 720 };
const DSF = Number(opt("dsf") ?? "2"); // device scale factor: 2 gives 2560x1440 frames, sharp enough for camera zooms

if (payment !== "5A" && payment !== "5B") fail("--payment must be 5A or 5B");

function fail(msg: string): never {
  console.error(`[record] ${msg}`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const T0 = performance.now();
const realNow = () => (performance.now() - T0) / 1000;
// Capture pauses (5A): while a human logs in at PayPal nothing is recorded and the clock stands still, so the video simply
// cuts from the PayPal login page to the app. The edit labels that cut as "off camera".
let pausedTotal = 0;
let pausedAt: number | null = null;
const now = () => realNow() - pausedTotal;

// ---- narration clips, durations and cue points -------------------------------------------------------------------------
const clips = (
  JSON.parse(readFileSync(join("demo", "narration.json"), "utf8")) as { clips: Clip[] }
).clips;
const payId = payment === "5A" ? "s5a" : "s5b";
const clipOf = (id: string): Clip => clips.find((c) => c.id === id) ?? fail(`no clip ${id}`);

const durations: Record<string, number> = synthetic
  ? Object.fromEntries(
      clips.map((c) => [
        c.id,
        c.text
          .replace(/\{\{\w+\}\}/g, "")
          .trim()
          .split(/\s+/).length * 0.4,
      ]),
    )
  : existsSync(join(work, "durations.json"))
    ? (JSON.parse(readFileSync(join(work, "durations.json"), "utf8")) as Record<string, number>)
    : fail(
        "demo/work/durations.json is missing: run `python demo/prepare_audio.py` first (or use --synthetic)",
      );

/** Seconds into the narration at which each {{cue}} is reached, proportional to the words spoken before it. */
function cueTimes(clip: Clip, duration: number): Record<string, number> {
  const tokens = clip.text.trim().split(/\s+/);
  const total = tokens.filter((t) => !/^\{\{\w+\}\}$/.test(t)).length;
  const out: Record<string, number> = {};
  let spoken = 0;
  for (const tok of tokens) {
    const m = /^\{\{(\w+)\}\}$/.exec(tok);
    if (m?.[1] !== undefined) out[m[1]] = (spoken / total) * duration;
    else spoken += 1;
  }
  return out;
}

// Exact cue times from `python demo/cue_times.py` (word timestamps of the prepared clips), when it has been run.
const preciseCues: Record<string, Record<string, number>> = !synthetic &&
existsSync(join(work, "cues.json"))
  ? (JSON.parse(readFileSync(join(work, "cues.json"), "utf8")) as Record<
      string,
      Record<string, number>
    >)
  : {};
// A cue marks the start of the phrase the screen should be showing; the action begins a little earlier so that it has
// arrived by the time the words that refer to it are spoken (seconds before the phrase).
const LEAD_BEFORE_PHRASE_S: Record<string, number> = {
  scroll: 0.2,
  audit: 0,
  panel: 0.6,
  protected: 0.6,
  compare: 0.8,
  // 4B and 5A (live): each action starts a little before the words it illustrates.
  ai: 0.3,
  numbers: 0.3,
  start: 0.2,
  approve: 1.0,
  hold: 2.0,
  capture: 1.0,
  cockpit: 0.3,
};

// ---- on-screen targets for the edit: the page's own elements, found by their text -------------------------------------
const TARGETS: Record<string, Target> = {
  banner: { text: "The flagship attack: budget escalation.", up: 1 },
  r1: { text: "Hi! I would love to design your logo", up: 1 },
  r2: { text: "Quick update after reviewing your brief", up: 1 },
  chipAuthority: { text: "Tactic: False authority" },
  chipUrgency: { text: "Tactic: Urgency" },
  identical: { text: "Inputs identical" },
  unsafeBadge: { text: "UNSAFE BY DESIGN" },
  ledgerBadge: { text: "SIMULATED LEDGER ONLY" },
  baselineHead: { text: "UNSAFE BY DESIGN", up: 2 },
  baselinePaid: { text: "Paid with no check (simulated)", nth: 1, up: 3 },
  simReceipt: { text: "SIM-B-001", up: 1 },
  violations: { text: "Per-purchase cap exceeded", up: 1 },
  protectedR2: { text: "Refused by the server's policy engine", nth: 1, up: 3 },
  denyCode: { text: "OVER_PER_TX_CAP", exact: true },
  payable: { text: "Payable agreement now", up: 2 },
  hashChain: { text: "Hash chain VERIFIED" },
  decisive: { text: "Decisive event #10", up: 1 },
  row10: { text: "POLICY_DENIED", nth: 1, up: 2 },
  payPanel: { css: "#pay-h", closest: "section" },
  payNotice: { text: "Payment cannot start on this server.", up: 1 },
  paidNo: { text: "No. Nothing counts as paid.", up: 1 },
  capturedHead: { text: "Captured: PayPal reports the payment completed", up: 1 },
  paidYes: { text: "Yes: PayPal reports the capture completed", up: 1 },
  captureRow: { text: "Capture", exact: true, up: 1 },
  aiRun: { text: "AI model run.", up: 1 },
  liveZero: { text: "Recommended paying an offer the server rejects", up: 1 },
  liveSeventeen: { text: "Asked a human to approve an offer the server would still deny", up: 1 },
  waitingNote: { text: "Waiting for the buyer to approve at PayPal", up: 1 },
  approvedNote: { text: "PayPal says the buyer approved", up: 1 },
  holdNote: { text: "Funds are on hold (authorized), not charged", up: 1 },
  cockStatus: { text: "Payment status", up: 1 },
  cockVerify: { text: "Verification", exact: true, up: 1 },
  cockChain: { text: "Audit chain", exact: true, up: 1 },
  benchCard: { text: "Persisted benchmark results", up: 2 },
  integrity: { text: "Integrity check passed" },
  arenaBlock: { text: "58 of 58 (100.0%)", up: 3 },
  arenaBlocked: { text: "58 of 58 (100.0%)", up: 1 },
  systemBlock: { text: "110 of 110 (100.0%)", up: 3 },
  systemBlocked: { text: "110 of 110 (100.0%)", up: 1 },
  cmpRow: { text: "All pairs", up: 1 },
  disclaimer: { text: "a count over these runs, not a guarantee" },
};

/** Viewport rectangle (CSS px) and visible text of a target, or null if it is not on the page. */
async function rectOf(page: Page, spec: Target): Promise<{ rect: Rect; text: string } | null> {
  // The app re-renders (sometimes navigates) after an action; a lookup that lands in that moment is simply repeated.
  for (let attempt = 1; ; attempt++) {
    try {
      return await rectOnce(page, spec);
    } catch (e) {
      const destroyed = e instanceof Error && /context was destroyed|navigation/i.test(e.message);
      if (!destroyed || attempt >= 5) throw e;
      await page.waitForLoadState("load");
      await sleep(300);
    }
  }
}

async function rectOnce(page: Page, spec: Target): Promise<{ rect: Rect; text: string } | null> {
  return page.evaluate((s) => {
    let el: Element | null = null;
    if (s.css !== undefined) {
      el = document.querySelector(s.css);
      if (el && s.closest) el = el.closest(s.closest);
    } else if (s.text !== undefined) {
      const needle = s.text;
      const visible = [
        ...document.querySelectorAll("body *:not(script):not(style):not(noscript)"),
      ].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !e.closest(".sr-only");
      });
      const hits = visible.filter((e) => {
        const own = (e.textContent ?? "").trim();
        if (s.exact ? own !== needle : !own.includes(needle)) return false;
        return ![...e.children].some((c) => (c.textContent ?? "").includes(needle));
      });
      el = hits[s.nth ?? 0] ?? null;
      for (let i = 0; el && i < (s.up ?? 0); i++) el = el.parentElement;
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      text: (el.textContent ?? "").trim().slice(0, 200),
    };
  }, spec);
}

const snaps: Snap[] = [];
const cueRuns: CueRun[] = [];
async function snap(scene: string, state: string, names: string[]): Promise<void> {
  const rects: Record<string, Rect> = {};
  const texts: Record<string, string> = {};
  for (const name of names) {
    const spec = TARGETS[name] ?? fail(`unknown target ${name}`);
    const found = await rectOf(page, spec);
    if (found === null) {
      const notices = await page.evaluate(() =>
        [...document.querySelectorAll(".notice")].map((n) =>
          (n as HTMLElement).innerText.slice(0, 90),
        ),
      );
      console.error(`[record] page ${page.url()} shows notices: ${JSON.stringify(notices)}`);
      fail(`target "${name}" is not on the page in ${scene}/${state}: the edit cannot be planned`);
    }
    rects[name] = found.rect;
    texts[name] = found.text;
  }
  // A sharp still of the settled page (device pixels): the screencast frames are 1x, which is fine in motion but soft when the
  // camera pushes in on a static page. The edit uses this still between the snapshot and the page's next change.
  const tS = now();
  const hires = join("hires", `${scene}-${state}.jpg`);
  await page.screenshot({ path: join(work, hires), type: "jpeg", quality: 92 });
  snaps.push({ scene, state, tS, rects, texts, hires });
}

// ---- page helpers --------------------------------------------------------------------------------------------------
const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

async function smoothScrollBy(page: Page, dy: number, ms: number): Promise<void> {
  await page.mouse.move(900, 400);
  // Paced by the clock, not by a step count: each wheel event takes a variable time to deliver, and the scroll must still
  // finish when the narration expects it to.
  const started = performance.now();
  let sent = 0;
  for (;;) {
    const f = Math.min(1, (performance.now() - started) / ms);
    const target = Math.round(dy * ease(f));
    if (target !== sent) {
      await page.mouse.wheel(0, target - sent);
      sent = target;
    }
    if (f >= 1) break;
    await page.waitForTimeout(8);
  }
}

/** Scrolls so that the element is `offset` px below the top of the window. */
async function scrollHeadingTo(
  page: Page,
  selector: string,
  offset: number,
  ms: number,
): Promise<void> {
  const top = await page.evaluate(
    (s) => document.querySelector(s)?.getBoundingClientRect().top ?? null,
    selector,
  );
  if (top === null) fail(`heading ${selector} not found`);
  await smoothScrollBy(page, top - offset, ms);
}

async function signIn(page: Page, passcode: string): Promise<void> {
  await page.goto(`${base}/negotiations`);
  await page.getByLabel("Operator passcode").fill(passcode);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Sign out" }).waitFor();
}

// ---- off camera: health gate, sign-in, and (5B) the synthetic negotiation --------------------------------------------
const health = (await (await fetch(`${base}/api/health`)).json()) as {
  paypal?: { credentials?: string; callsEnabled?: boolean };
  agents?: { mode?: string; llmCallsEnabled?: boolean };
  database?: { state?: string };
};
if (health.database?.state !== "ready")
  fail("the database is not ready: run `npm run db:migrate && npm run db:seed` first");
const credentials = health.paypal?.credentials;
if (payment === "5B" && credentials !== "absent")
  fail(
    'this server HAS PayPal credentials, so scene 5B\'s narration ("has not been run") would be wrong: record 5A or 5C',
  );
if (payment === "5A" && credentials !== "present")
  fail("5A gate G1 failed: /api/health does not report credentials 'present'");
if (payment === "5A" && (health.agents?.mode !== "llm" || health.agents.llmCallsEnabled !== true))
  fail(
    "scene 4B runs the real model: /api/health must report agents.mode 'llm' with llmCallsEnabled true",
  );

const passcode = process.env.OPERATOR_PASSCODE ?? "";
if (passcode.length < 16)
  fail("OPERATOR_PASSCODE (16+ characters) is needed in the environment or .env.local");

// 5A needs a visible window: the buyer logs in at PayPal in it, off camera.
const browser: Browser = await chromium.launch({ channel: "msedge", headless: payment !== "5A" });
const prep: BrowserContext = await browser.newContext({ viewport: VIEW });
const prepPage = await prep.newPage();
await signIn(prepPage, passcode);

let negId: string;
let aiNegId = "";
/** Opens a negotiation for the demo scenario off camera and returns its id (each agreement uses 60.00 of the budget). */
async function openNegotiation(): Promise<string> {
  await prepPage.goto(`${base}/negotiations?scenario=compute-within-budget`);
  await prepPage.getByRole("button", { name: "Open negotiation" }).click();
  await prepPage.getByText("Negotiation opened.").waitFor();
  return new URL(prepPage.url()).searchParams.get("n") ?? fail("no negotiation id in the address");
}
if (payment === "5A") {
  // Scene 4B: an open negotiation with no offers yet; the real model is run on it on camera.
  aiNegId = await openNegotiation();
  // Scene 5A: an agreement that passed the policy check; the payment itself is started, approved, held and captured on camera.
  negId = await openNegotiation();
  await prepPage.getByRole("button", { name: "Run the demo agents" }).click();
  await prepPage.getByText(/Demo agents\./).waitFor();
  await prepPage.getByRole("button", { name: /^Accept .* offer version \d+$/ }).click();
  await prepPage
    .getByText("Accepted: the policy check passed and agreement was created.")
    .waitFor();
  await prepPage.goto(`${base}/negotiations?n=${negId}`);
  await prepPage.locator("#pay-h").waitFor();
  const panel = await prepPage.evaluate(
    () => document.getElementById("pay-h")?.closest("section")?.innerText ?? "",
  );
  if (!panel.includes("Ready to start the PayPal sandbox payment"))
    fail("5A needs an agreement ready for payment; the panel does not say it is ready to start");
  console.log(
    `[record] prepared the model negotiation ${aiNegId} and the payment agreement ${negId}`,
  );
} else {
  if (negArg !== undefined) {
    negId = negArg; // reuse: every new negotiation uses 60.00 of the demo mandate's 150.00 budget
  } else {
    await prepPage.goto(`${base}/negotiations?scenario=compute-within-budget`);
    await prepPage.getByRole("button", { name: "Open negotiation" }).click();
    await prepPage.getByText("Negotiation opened.").waitFor();
    negId =
      new URL(prepPage.url()).searchParams.get("n") ?? fail("no negotiation id in the address");
    await prepPage.getByRole("button", { name: "Run the demo agents" }).click();
    await prepPage.getByText(/Demo agents\./).waitFor();
    await prepPage.getByRole("button", { name: /^Accept .* offer version \d+$/ }).click();
    await prepPage
      .getByText("Accepted: the policy check passed and agreement was created.")
      .waitFor();
    console.log(`[record] created ${negId}; reuse it next time with --neg ${negId}`);
  }
  await prepPage.goto(`${base}/negotiations?n=${negId}`);
  await prepPage.locator("#pay-h").waitFor();
  const panel = await prepPage.evaluate(
    () => document.getElementById("pay-h")?.closest("section")?.innerText ?? "",
  );
  if (
    !panel.includes("Payment cannot start on this server") ||
    !panel.includes("No. Nothing counts as paid.")
  )
    fail(
      "5B check failed: the payment panel does not show the 'cannot start / nothing counts as paid' state",
    );
}
const session = await prep.storageState();
await prep.close();

// ---- on camera: a CDP screencast (JPEG frames with timestamps); demo/assemble.py turns the frames into the video ----------
const framesDir = join(work, "frames");
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });
rmSync(join(work, "hires"), { recursive: true, force: true });
mkdirSync(join(work, "hires"), { recursive: true });
const ctx = await browser.newContext({
  viewport: VIEW,
  storageState: session,
  deviceScaleFactor: DSF,
});
const page = await ctx.newPage();
const problems: string[] = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && problems.push(`console.error: ${m.text()}`));

const cdp = await ctx.newCDPSession(page);
const epoch0 = Date.now() / 1000 - now(); // frame timestamps are epoch seconds; this converts them to this process's clock
const frames: { t: number; file: string }[] = [];
cdp.on("Page.screencastFrame", (e) => {
  if (pausedAt === null) {
    const file = `${String(frames.length).padStart(5, "0")}.jpg`;
    frames.push({ t: (e.metadata.timestamp ?? Date.now() / 1000) - pausedTotal, file });
    writeFileSync(join(framesDir, file), Buffer.from(e.data, "base64"));
  }
  void cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId });
});

/** Stops recording until `resumeCapture`. Frames in between are dropped and the clock does not advance. */
function pauseCapture(): void {
  pausedAt = realNow();
}
/** The screencast only sends a frame when the page changes, so nudge a repaint: otherwise the last frame before the pause
 *  (the PayPal page) would stay on screen until something else changed. */
async function resumeCapture(): Promise<void> {
  if (pausedAt === null) return;
  pausedTotal += realNow() - pausedAt;
  pausedAt = null;
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      document.body.style.opacity = "0.999";
      return new Promise<void>((r) => requestAnimationFrame(() => r()));
    });
    await sleep(60);
    await page.evaluate(() => {
      document.body.style.opacity = "";
    });
    await sleep(60);
  }
}
await page.goto("about:blank");
await cdp.send("Page.startScreencast", {
  format: "jpeg",
  quality: 92,
  maxWidth: VIEW.width * DSF,
  maxHeight: VIEW.height * DSF,
  everyNthFrame: 1,
});
await sleep(300);

const scenes: SceneLog[] = [];

async function scene(
  id: string,
  navigate: (() => Promise<void>) | null,
  cues: Record<string, () => Promise<void>>,
  snapNames: Record<string, string[]> = {},
) {
  const clip = clipOf(id);
  const dur = durations[id] ?? fail(`no duration for ${id}`);
  const startS = now();
  if (navigate !== null) await navigate();
  await sleep(LEAD_S * 1000);
  await snap(id, "nav", snapNames.nav ?? []);
  const audioStartS = now();
  const times = { ...cueTimes(clip, dur), ...(preciseCues[id] ?? {}) };
  const pending: Promise<void>[] = [];
  // One cue at a time, each together with its snapshot: the next action must not start (and navigate away) before the
  // previous one has been photographed.
  let turn: Promise<void> = Promise.resolve();
  for (const [name, fn] of Object.entries(cues)) {
    const phrase = times[name];
    if (phrase === undefined) fail(`cue ${name} not found in ${id}`);
    const at = Math.max(0, phrase - (LEAD_BEFORE_PHRASE_S[name] ?? 0));
    pending.push(
      (async () => {
        await sleep(Math.max(0, (audioStartS + at - now()) * 1000));
        turn = turn.then(async () => {
          const startRun = now();
          await fn();
          cueRuns.push({ scene: id, name, startS: startRun, endS: now() });
          await sleep(150);
          await snap(id, name, snapNames[name] ?? []);
        });
        await turn;
      })(),
    );
  }
  await Promise.all(pending);
  await sleep(Math.max(0, (audioStartS + dur + TAIL_S - now()) * 1000));
  scenes.push({ id, startS, audioStartS, endS: now() });
}

const go = (path: string) => async () => {
  await page.goto(`${base}${path}`);
  await page.waitForLoadState("load");
};

/** The payment panel: waits are scoped to it because the same words also appear in the (hidden) progress labels. */
const payPanelOf = () =>
  page
    .locator("section")
    .filter({ has: page.locator("#pay-h") })
    .last();

/** Runs a scene's handlers strictly one after another: a slow model or PayPal call is never overtaken by the next step. */
function inOrder() {
  let last: Promise<void> = Promise.resolve();
  return (fn: () => Promise<void>) => () => (last = last.then(fn));
}

await scene("s1", go("/flagship"), {}, { nav: ["banner"] });
await scene(
  "s2",
  go("/flagship#fs-h"),
  {},
  {
    nav: ["r1", "r2", "chipAuthority", "chipUrgency", "identical"],
  },
);
await scene(
  "s3",
  go("/flagship#fb-h"),
  { scroll: () => smoothScrollBy(page, 500, 1200) },
  {
    nav: ["unsafeBadge", "ledgerBadge", "baselineHead"],
    scroll: ["baselinePaid", "simReceipt", "violations", "protectedR2", "denyCode", "payable"],
  },
);
await scene(
  "s4",
  null,
  { audit: go("/flagship#fa-h") },
  { audit: ["hashChain", "decisive", "row10"] },
);
if (payment === "5A") {
  // Scene 4B: the real model, live, then the committed measurement of it against hostile sellers.
  const seqAi = inOrder();
  await scene(
    "s4b",
    async () => {
      await go(`/negotiations?n=${aiNegId}`)();
      await page.getByRole("button", { name: /Run with the AI model/ }).scrollIntoViewIfNeeded();
    },
    {
      ai: seqAi(async () => {
        // The free tier of the model provider rate-limits and the model sometimes answers in the wrong shape, so a call can
        // fail. A failed call is retried (on a fresh page) and never recorded as if it had worked.
        for (let attempt = 1; attempt <= 3; attempt++) {
          await page.getByRole("button", { name: /Run with the AI model/ }).click();
          await page.waitForFunction(
            () => /recommends an offer|failed to answer|Problems:/.test(document.body.innerText),
            undefined,
            { timeout: 60_000 },
          );
          if (await page.getByText(/The buyer agent recommends an offer/).count()) {
            await page.getByText(/AI model run\./).scrollIntoViewIfNeeded();
            return;
          }
          console.log(`[record] model call ${attempt} did not produce an offer; trying again`);
          await sleep(15_000);
          await go(`/negotiations?n=${aiNegId}`)();
        }
        fail(
          "the real model did not answer in three tries: nothing was recorded that did not happen",
        );
      }),
      numbers: seqAi(go("/live-model")),
    },
    { ai: ["aiRun"], numbers: ["liveZero", "liveSeventeen"] },
  );

  // Scene 5A: a real PayPal Sandbox payment, start to finish. Only the buyer's login and approval at PayPal are off camera.
  const seq = inOrder();
  await scene(
    payId,
    async () => {
      await go(`/negotiations?n=${negId}`)();
      await page.locator("#pay-h").waitFor();
      await scrollHeadingTo(page, "#pay-h", 90, 300);
    },
    {
      start: seq(async () => {
        await page.getByRole("button", { name: "Start PayPal sandbox payment" }).click();
        await payPanelOf()
          .getByText("Waiting for the buyer to approve at PayPal")
          .waitFor({ timeout: 30_000 });
      }),
      approve: seq(async () => {
        const href = await page
          .getByRole("link", { name: /Open the PayPal approval page/ })
          .getAttribute("href");
        if (href === null) fail("no PayPal approval link on the page");
        await page.goto(href, { waitUntil: "domcontentloaded" });
        await sleep(1200); // the PayPal login page, on camera; nothing is typed
        pauseCapture();
        console.log(
          "[record] >>> YOUR TURN: in the Edge window log in as the sandbox buyer (the Personal account) and approve. Capture is paused and resumes when the app is back.",
        );
        await page.waitForURL((u) => u.origin === new URL(base).origin, { timeout: 20 * 60_000 });
        await page.locator("#pay-h").waitFor({ timeout: 60_000 });
        await scrollHeadingTo(page, "#pay-h", 90, 250);
        await resumeCapture();
        // Coming back from PayPal proves nothing: the app only believes what its own read of the order says. This click is that
        // read, on camera (the narration says exactly this).
        await payPanelOf().getByRole("button", { name: "Check status with PayPal" }).click();
        await payPanelOf().getByText("PayPal says the buyer approved").waitFor({ timeout: 60_000 });
      }),
      hold: seq(async () => {
        await page.getByRole("button", { name: "Place the hold (authorize)" }).click();
        await payPanelOf()
          .getByText("Funds are on hold (authorized), not charged")
          .waitFor({ timeout: 30_000 });
        await scrollHeadingTo(page, "#pay-h", 90, 350); // the click scrolled the buttons into view; show the headline
      }),
      capture: seq(async () => {
        await page.getByRole("button", { name: /^Capture .* \(charge the buyer\)$/ }).click();
        await page.getByRole("button", { name: "Yes, capture" }).click();
        // Gate G2, on the live result: the panel itself must say PayPal reports the capture completed.
        await payPanelOf()
          .getByText("Captured: PayPal reports the payment completed")
          .waitFor({ timeout: 30_000 });
        await payPanelOf()
          .getByText("Yes: PayPal reports the capture completed")
          .waitFor({ timeout: 5_000 });
        await scrollHeadingTo(page, "#pay-h", 90, 350);
      }),
      cockpit: seq(async () => {
        const href = await page
          .getByRole("link", { name: "Inspect this transaction in the Cockpit" })
          .getAttribute("href");
        if (href === null) fail("no Cockpit link for the transaction");
        await go(href)();
        await page.getByText("The audit chain verifies").waitFor({ timeout: 30_000 });
      }),
    },
    {
      nav: ["payPanel"],
      start: ["payPanel", "waitingNote"],
      approve: ["approvedNote"],
      hold: ["holdNote"],
      capture: ["capturedHead", "paidYes"],
      cockpit: ["cockStatus", "cockVerify", "cockChain"],
    },
  );
} else {
  await scene(
    payId,
    async () => {
      await go(`/negotiations?n=${negId}`)();
      await page.locator("#pay-h").waitFor();
    },
    { panel: () => scrollHeadingTo(page, "#pay-h", 90, 1200) },
    { panel: ["payPanel", "payNotice", "paidNo"] },
  );
}
await scene(
  "s6",
  async () => {
    // From here the pages are seen as an anonymous visitor sees them: no operator data from the rehearsal on screen.
    await ctx.clearCookies();
    await go("/cockpit?view=analytics")();
    await page.getByText("Integrity check passed").first().waitFor();
  },
  {
    protected: () => scrollHeadingTo(page, "#an-prot-h", 150, 1800),
    compare: () => scrollHeadingTo(page, "#an-cmp-h", 60, 1200),
  },
  {
    nav: ["benchCard", "integrity"],
    protected: ["arenaBlock", "arenaBlocked", "systemBlock", "systemBlocked", "disclaimer"],
    compare: ["cmpRow"],
  },
);
await scene("s7", go("/"), {}, {});

await sleep(500);
await cdp.send("Page.stopScreencast");
await ctx.close();
await browser.close();
writeFileSync(join(work, "frames.json"), JSON.stringify({ epoch0, frames }));
writeFileSync(join(work, "snaps.json"), JSON.stringify(snaps, null, 2));

writeFileSync(
  join(work, "scenes.json"),
  JSON.stringify({ payment: payId, base, dsf: DSF, scenes, cueRuns, durations }, null, 2),
);
const total = scenes.at(-1)!.endS - scenes[0]!.startS;
console.log(
  `[record] ${scenes.length} scenes, ${total.toFixed(1)} s of screen. Page errors during recording: ${problems.length}`,
);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  fail("the recording contains page errors: do not use it");
}
