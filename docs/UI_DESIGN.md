# Interface design notes

A restrained dark theme for a payments product: quiet surfaces, one accent, status colours reserved for status. No dependency was added; everything is in [`src/app/globals.css`](../src/app/globals.css) and a few small components.

## 1. Principles

- **Hierarchy first.** Every page has one visible title (`PageHead`) and one sentence saying what it is for. Long explanations sit in a closed `Explainer` (`<details>`), so the text is in the page for anyone who wants it and out of the way for anyone who does not.
- **Details on demand.** An offer shows its total, delivery and validity at a glance; currency, category, items, deliverables and written terms are under "Full terms" (open by default only while the offer can still be accepted). The Arena's note on the simulated model is closed by default. The nine-step description on the start page is closed by default.
- **Nothing invented.** The interface shows stored records, simulation output that is labelled as simulation, or clearly labelled fixtures. There is no rating, score, trend, volume or success rate anywhere; a test scans the interface code for that kind of wording. An empty view says it is empty.
- **Colour is never the only signal.** Every status has a word and a symbol. The two buyers also differ by pattern.

## 2. Tokens

`:root` in `globals.css`. Surfaces `--bg`, `--surface`, `--surface-2`, `--surface-3`; text `--text`, `--muted`; one accent `--info`/`--focus`; status pairs `--success`, `--warning`, `--danger`, `--info`, `--neutral`, each with a tinted `-bg`. A 4px spacing scale (`--space-1` to `--space-6`), two radii, one elevation. Text/background pairs are checked against WCAG AA (4.5:1) in `test/contrast.test.ts`; the focus ring is checked at 3:1 on every surface. Amounts and dates use tabular figures so columns line up.

Type scale: page title 26px, section 17px, sub-section 15px, body 15px, labels and captions 12 to 13px. Money is always shown as the amount with two decimals (none for yen) and the ISO currency code, for example `450.00 USD`. It is formatted from integer minor units by `formatMoney` / `formatMinor` in `src/domain/mandate.ts`; four places that used to divide a float by 100 now use it (a test shows the float way is off by a cent for very large amounts).

## 3. One vocabulary for states

`src/app/_ui/state-note.tsx` is the only place that defines what these look like.

| State     | Word        | Symbol | Colour | When                                                                 | Announced as |
| --------- | ----------- | ------ | ------ | -------------------------------------------------------------------- | ------------ |
| `loading` | Loading     | ◌      | grey   | the server has not answered                                          | status       |
| `empty`   | Nothing yet | ○      | grey   | there is nothing to show, and that is the truth                      | status       |
| `pending` | Pending     | …      | amber  | work is under way or waiting on someone                              | status       |
| `denied`  | Denied      | ■      | blue   | a check refused it, as designed: the protection working, not a fault | status       |
| `failed`  | Failed      | !      | red    | something went wrong that should not have                            | alert        |
| `done`    | Completed   | ✓      | green  | it finished and the record says so                                   | status       |

A policy refusal is blue everywhere (the Arena, the Cockpit, the offer's policy box), and red is kept for faults, so a refused offer is never drawn like a broken payment. The payment panel maps the server's own tone onto this vocabulary (`failed`, `pending`, `done`); it never marks a payment completed unless the server says it was captured.

## 4. Protected versus unsafe baseline

The two Arena panes cannot be mistaken for each other even in greyscale: the baseline has a hazard-stripe bar, a red border and the chips "UNSAFE BY DESIGN" and "SIMULATED LEDGER ONLY"; the protected buyer has a solid green bar, a green border and "POLICY ENFORCED". Inside each outcome card the **reason** is lifted into its own highlighted block, and the amounts are set larger, so "why was this blocked or paid" is read first.

## 5. Why something was blocked

A refusal reads, top to bottom: the verdict chip and one-sentence headline, then one block per reason (bold title, a plain sentence, the code in monospace, and an arrow line saying what to do), then the policy version and time. It is the same markup on the offer, in the history and on the agreement.

## 6. Responsive and keyboard

- Layouts collapse to one column; grids use `minmax(0, 1fr)` so no long code, chip or table can push the page wider than the screen. Checked at 375px on the start page, mandate, negotiations, Cockpit, replay and Arena: no horizontal page scroll.
- The nine-step bar scrolls sideways on its own with snap points. On narrow screens the buttons in a row go full width, chips may wrap, and with a coarse pointer controls are at least 44px tall.
- Skip link to the main content, one `h1` and one `nav` per page, visible 2px focus ring on every control (checked by tabbing in a browser), `<details>` summaries are keyboard operable and at least 44px tall.
- `prefers-reduced-motion` removes animation; `forced-colors` keeps borders and the buyers' bars visible.

## 7. What was and was not checked

Checked: the full test suite (including new tests for the state vocabulary, the refusal markup, page structure, the "nothing invented" scan, money formatting and the stylesheet's accessibility and responsive rules) and the production build. In the in-app browser, against a production build with a throwaway database:

- **By eye at a 1280px layout** (shown scaled down, because the browser pane is narrower than that): the start page, negotiations (a refused offer and an agreed one with its payment panel), the Arena and the Cockpit.
- **By eye at 375px:** the Arena's unsafe-baseline pane.
- **Measured by script at 375px** (page width against screen width, one `h1`, no unnamed controls): the start page, mandate, negotiations, Cockpit, replay and Arena. This found real sideways overflow on the replay and the Arena, which is fixed; the replay page was not looked at by eye.
- **Primary flow through the polished interface:** open a task from the scenario, run the mock agents, accept an offer (policy check passed, agreement created, progress bar updated, payment panel says it cannot start without credentials).
- **Keyboard:** Tab reaches the skip link, brand and navigation in order and shows the focus ring.

Not checked: any screen reader; real touch devices; other browsers than the in-app one; widths between 375 and 1280 other than the tablet-sized pane; automated visual regression (none exists, so a later CSS change can look different without a test failing). The payment steps against PayPal's sandbox were not exercised (no credentials), so the pending, failed and completed payment states were verified through markup tests and the earlier fake-PayPal flows, not on screen against PayPal.
