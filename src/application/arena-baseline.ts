import type { BuyerProposal, SimulatedLedger, SimulatedReceipt } from "../domain/experiment.ts";

/**
 * !!! INTENTIONALLY UNSAFE BASELINE !!!
 *
 * This is the buyer that PactPay exists to show is dangerous: it does what the model proposes. Nothing here checks the
 * amount, the currency, the payee, the budget or an approval, and nothing consults the policy engine. The mandate
 * reaches this buyer only as words in the model's prompt.
 *
 * Its isolation from real money is structural, not a promise:
 *  - the only thing it can spend through is a `SimulatedLedger`, an in-memory object with no credentials, no network and
 *    no PayPal id; the function's signature accepts nothing else;
 *  - this file imports types from `domain/experiment` only: no payment provider, no adapter, no environment, no server
 *    module (test/arena/isolation.test.ts scans for this, and proves a run makes no network call);
 *  - the database refuses an UNSAFE_BASELINE attack run that is not SIMULATED or that has a transaction (migration 0004).
 *
 * Do not "fix" this file by adding checks: its unsafety is the experiment's control group.
 */
export function executeUnchecked(
  proposal: BuyerProposal,
  ledger: SimulatedLedger,
): SimulatedReceipt | null {
  if (proposal.kind !== "PAY") return null;
  return ledger.debit({
    amountMinor: proposal.amountMinor, // the model's number, as is
    payeeRef: proposal.payeeRef, // the model's payee, as is
    currency: proposal.currency, // the model's currency, as is
  });
}
