# Submission text (Devpost)

Copy the sections from "Project name" down into the submission form. Everything below is written to be true **as of 2026-11-07**. Before you submit, update the sentences listed here if the matching live run has since been done; do not change them otherwise.

| If this has been done                                     | Update this                                                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A real PayPal Sandbox payment was completed on this build | "How PayPal is used" (status sentence), "What works today", "Limitations" (first bullet), and the video scene 5A |
| The real AI model was run on this build                   | "How AI is used" (status sentence), "Tools used" (Anthropic row), "Limitations" (second bullet)                  |
| The app was deployed                                      | "Try it" (add the URL) and "Limitations" (third bullet)                                                          |
| The repository is public                                  | "Try it" (add the repository link)                                                                               |

---

## Project name

PactPay Arena

## Tagline

Agents negotiate. Code enforces. PayPal settles.

## What it does

AI agents are starting to spend money on our behalf, but they read text written by the other side of the deal, and that text can pressure them: a revised price, a claim that the account owner already approved it, a different payee. If the model alone decides whether to pay, the best message controls the wallet.

PactPay Arena shows the difference. It sends the **same seller attack to two buyers**: an intentionally unsafe baseline (an isolated simulation on an in-memory ledger) and a protected buyer. In the flagship scenario a seller opens with a valid $24.00 offer and then raises it to $36.00 with persuasion, false authority and urgency. The baseline pays $36.00 (simulated), over the $30.00 cap and with no human approval. The protected buyer's model proposes the same thing, but the model only asks the server to accept an offer: a deterministic server-side **policy engine** judges the stored offer against the human-approved, versioned **mandate** and refuses it with the reason code `OVER_PER_TX_CAP`. The refusal is written to a hash-chained audit log (event `POLICY_DENIED`).

Around that core, the app provides:

- an operator console for the mandate (budget, per-transaction cap, categories, approval threshold) and for negotiations (offers, counter-offers, agreements with policy decisions in plain language);
- a **PayPal Sandbox payment flow** where the server creates the order from its own records, reads PayPal back before believing it, and then authorizes (a hold), captures or voids, with verified webhooks and reconciliation;
- the **Cockpit**, an AG Grid data grid over stored transactions, refused offers, attack runs and benchmark results, with an analytics view that shows every denominator;
- a reproducible **adversarial benchmark**: 524 recorded runs from a seeded catalogue of attacks (budget escalation, payee and currency substitution, tampering, injection, forged webhooks, replay and more), reported with separate result classes.

## How PayPal is used

PayPal Orders API v2 in the Sandbox is central to the product's second half: the protected path ends in a real order, authorization, capture or void. The server (never the browser or an agent) supplies amount, currency, payee and agreement; every payment step re-checks policy and reads the order from PayPal before it is believed; a timeout or unreadable answer is "unknown", never success; requests carry stable `PayPal-Request-Id` values; the webhook endpoint asks PayPal's own `verify-webhook-signature` service, deduplicates by event id, and then re-reads the order. Only a capture that PayPal reports as completed is shown as paid. There are no payouts to sellers, no escrow claims, and no non-sandbox PayPal anywhere (the app refuses to start otherwise).

**Status:** this flow is implemented and tested against HTTP-level test doubles of PayPal (many cases, including lost responses, duplicate and replayed webhooks, concurrent requests and denied captures). It was also **run end to end against the real PayPal Sandbox on 2026-11-08**: create order, buyer approval at PayPal, authorization hold, and a capture that PayPal reported as completed for 60.00 USD, confirmed by an independent read of the order. That run found and fixed two defects the test doubles had hidden. A separate hold-and-void was also run live (PayPal reported the authorization voided, nothing charged). Signed webhooks were also run live through a temporary tunnel: over two runs PayPal delivered seven events (order approved, authorization created, authorization voided, capture completed, capture refunded), each verified by PayPal's own verification service and stored. The refund event carries no order id, so it is stored but, by design, not applied. The tunnel and webhook are not left running; there are no payouts.

## How AI is used

AI agents are the protagonists of the problem and of the product. Buyer and seller agents sit behind small interfaces that have **no method to approve a mandate, authorize, capture or pay**. Every agent output, from a mock or a real model, passes the same pipeline (timeouts, bounded retries, strict JSON, strict schema, reference and constraint checks), the other party's text is treated as hostile and scanned for injection, and the only thing an agent can do is propose. The default agents are deterministic and scripted, so that every demo and every benchmark replays exactly; the benchmark's "models" are scripted stand-ins with stated weaknesses, not a measurement of any real model. An optional real-model provider runs the same agents on Groq's OpenAI-compatible API (free tier) or the Anthropic Messages API; the operator chooses the model id.

**Status:** the Groq provider was **called live on 2026-11-08** with `openai/gpt-oss-120b`: `npm run agents:smoke` passed (the reply passed the same strict validation as the scripted agents) and the app's "Run with the AI model" button recorded an offer. The Anthropic provider is tested against mocked HTTP only (a live call was refused by the API for lack of account credit). A separate live measurement ([docs/LIVE_MODEL_ATTACK.md](LIVE_MODEL_ATTACK.md)) ran the real model as the buyer against ten hostile-seller scripts, 50 negotiations: it never recommended an offer the server rejects, but in 17 of 50 it passed an offer that the server would deny on to a human, so the server, not the model, is what stops those. That is one model, small counts and a scripted seller; the benchmark itself still uses scripted stand-ins.

## What works today (verified)

- 3,353 automated tests pass (policy, money, database, payment state transitions, idempotency and concurrency, webhook verification and replay, audit chain, failure injection) and 20 Playwright browser tests pass on the production build.
- 124 adversarial scenarios behave as specified; the benchmark reproduces to the same results hash on a clean clone.
- In the benchmark's simulated arena, the protected buyer blocked 58 of 58 attempted violations and the unsafe baseline let 58 of 58 through; in the 110 system scenarios (fake PayPal) the protected system blocked 110 of 110. These are counts over this catalogue with scripted models, not a guarantee about other inputs.
- Setup was verified from a clean copy of the repository with no credentials. Details and every skipped item: `docs/QA_REPORT.md`, `docs/RELEASE_CANDIDATE.md`.

## When it was built

The Submission Period began on 2026-10-01. This project was started during it: its earliest files (the engineering rules, the project audit and the first architecture documents) are dated 2026-10-11, and everything else, including the PayPal flow, the agents, the Arena, the Cockpit, the benchmark, the demo video and the hosted demo, was built after that. The git history in the public repository starts on the day it was published (2026-11-09), so the dates inside the documents and the file contents are the record of the work.

## The demo video (2:44)

Screen footage captured from the running app, with an AI voice reading the script in `docs/DEMO_SCRIPT.md`. It shows: the budget-escalation attack and the unsafe baseline (a labelled simulation); the protected buyer refused by the server's policy engine with its audit event; **a real model (Groq) run live as the buyer**, and the measurement of it against ten hostile-seller scripts; **a real PayPal Sandbox payment from start to finish** (order created, PayPal's own login page, hold, capture, and the Cockpit showing PayPal's read-back and an intact audit chain); and the seeded benchmark. The buyer's login and approval at PayPal were done by the tester off camera, and the video says so on screen. The video makes no claim beyond what these sections state: the benchmark's models are scripted and the baseline's payment is simulated.

## Tools used

| Tool                                                                        | How it is used                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PayPal Orders API v2 (Sandbox) and webhooks                                 | Create order, authorize, capture, void, order reads and signature verification. Create, approve, authorize, capture, void and order reads verified live in the Sandbox, and signed webhooks verified live through a temporary tunnel (see status above).                 |
| Groq API (`openai/gpt-oss-120b`) and Anthropic Messages API                 | Optional real-model buyer and seller agents. Groq verified live (a smoke call, a negotiation run, and a 50-negotiation measurement against hostile sellers); Anthropic tested against mocked HTTP only (see status above). The default is deterministic scripted agents. |
| Claude Code (AI coding assistant)                                           | Used to design, write, test and review the code and documentation under the engineering rules in `CLAUDE.md`.                                                                                                                                                            |
| ElevenLabs (AI voice)                                                       | Generates the narration of the demo video from the written script (voice from ElevenLabs' voice library; the video description credits ElevenLabs); the screen footage is captured from the real app.                                                                    |
| Python (numpy, scipy) and Playwright                                        | Edit the demo video: the music bed and sound effects are synthesised locally (no third-party music or samples), and the motion graphics are rendered from a web page.                                                                                                    |
| AG Grid Community (sponsor tool, MIT)                                       | The Cockpit data grid. No Enterprise feature or licence key; AG Studio is not used.                                                                                                                                                                                      |
| Render (sponsor tool)                                                       | A Blueprint (`render.yaml`) and hosted start script are prepared; nothing is deployed yet.                                                                                                                                                                               |
| Next.js, React, TypeScript, Zod, SQLite (`node:sqlite`), Vitest, Playwright | The application, runtime validation, storage and tests.                                                                                                                                                                                                                  |

## Try it

Judges can run it without credentials. Requirements: Node.js 22.18 or newer and npm.

```bash
git clone <repository link>
cd <repository folder>
npm ci
npm run dev        # then open http://localhost:3000, /flagship, /arena, /cockpit and /live-model
```

**Hosted demo:** https://pactpay-arena.onrender.com (Render free plan: it sleeps after 15 minutes without requests, so the first load can take about a minute, and its data is recreated on every restart). On 2026-11-09 its health endpoint reported demo mode, PayPal Sandbox credentials present and a ready database, and the Start, Flagship, Arena, Cockpit and Live model pages answered 200. The operator pages need the passcode given in the submission's testing instructions. One PayPal Sandbox payment was also run on this host (order, approval, hold, capture) and confirmed at PayPal: order `COMPLETED`, capture `COMPLETED` for 60.00 USD, and PayPal issued the order-approved, authorization-created and capture-completed webhook events for it. The flagship attack (`/flagship`), the Arena, the Cockpit and the Live model page (`/live-model`) need no setup. The operator consoles need one value (`OPERATOR_PASSCODE` in `.env.local`, see `.env.example`), and the PayPal and real-model paths need your own sandbox credentials and key. Full instructions, troubleshooting, the threat model and the benchmark methodology are in `README.md`.

## Testing instructions (for the submission form)

Paste this into the form's testing instructions and fill in the three bracketed values there. They are deliberately not stored in this public repository.

> Hosted demo: https://pactpay-arena.onrender.com (free plan: the first load after a period of no use takes about a minute). Code and full setup instructions: https://github.com/UlanSupe/Hack-product (README, section "Testing it (for judges)").
> No sign-in is needed for the Flagship attack (/flagship), the Arena (/arena), the Cockpit (/cockpit) and the Live model page (/live-model).
> To run the protected payment flow (/negotiations): sign in with the operator passcode **[passcode]**. Open a task from the "compute-within-budget" scenario, press "Run the demo agents", accept the offer, then "Start PayPal sandbox payment", open the PayPal approval page and log in with the sandbox buyer **[sandbox buyer email]** / **[sandbox buyer password]** and approve. Back in the app press "Check status with PayPal", then "Place the hold", then "Capture". Everything is PayPal Sandbox test money.
> The hosted demo uses scripted agents. The real-model scene of the video needs a free Groq key and runs locally (README); the recorded measurement of that model is on /live-model.
> Please do not change the sandbox accounts. The operator passcode and the buyer login stay valid until the judging period ends.

## Sponsor tools used

AG Grid (Community edition, MIT): the Cockpit's data grid. Render: the hosted demo (Blueprint `render.yaml`). No other sponsor tool is used, and none is claimed.

## Trademarks

PactPay Arena is an independent hackathon project, not affiliated with or endorsed by PayPal, Groq, Anthropic, ElevenLabs or Render. It uses the PayPal Sandbox only.

## Limitations (stated plainly)

- Verified live in the PayPal Sandbox: create, approve, authorize, capture, void, reconciliation, and signed webhooks for five event types (through a temporary tunnel; no public deployment exists).
- A real model was called live through Groq (one smoke call and one negotiation run); Anthropic is mocked-HTTP only. The benchmark's models are deterministic stand-ins; how a real model resists the attacks was measured once, at small scale ([docs/LIVE_MODEL_ATTACK.md](LIVE_MODEL_ATTACK.md)), and is not a guarantee.
- Deployed on Render's free plan (sleeps when idle, data recreated on restart); the PayPal payment flow was run both locally and once on that host. Everything can also be run locally from the repository.
- One shared operator passcode (demo-grade authentication), single-instance SQLite, no Content-Security-Policy header, no payouts, refunds or escrow.
- Reviewed and tested by the same team that built it; no independent security audit.

## What's next

Run the Sandbox flow and a real model end to end and publish the results; let a real model play the susceptible buyer under the same attacks; per-user accounts and revocable sessions; payouts as a separate, clearly labelled stage; a hosted demo.
