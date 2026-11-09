# Tamper-evident audit chain

What it is, exactly what it hashes, how to verify it, and (more important) what it does **not** protect against.

Code: [`src/domain/audit.ts`](../src/domain/audit.ts) (hashing and verification, pure), [`src/adapters/sqlite/audit.ts`](../src/adapters/sqlite/audit.ts) (append and read), migration [`0008_audit_chain_identity.sql`](../src/adapters/sqlite/migrations/0008_audit_chain_identity.sql). Tests: `src/domain/audit.test.ts`, `test/persistence/audit.test.ts`, `test/persistence/audit-chain.test.ts`.

## 1. In one paragraph

Every decision, state change, observation and refusal is appended to one `audit_events` table. Each event stores the SHA-256 hash of the event before it, and its own hash is computed over a deterministic, canonical serialization of everything it contains **plus** that previous hash. Change, remove or reorder any event and the recomputation no longer matches, so `verifyChain()` reports the **first** event that does not check out. That is all it does. **It is a hash chain, not a digital signature.** No key is involved anywhere, so it cannot prove who wrote the log, and anyone who can write the whole table can write a chain that verifies (section 6).

## 2. What each event contains

| Field                                             | Meaning                                                                                                                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eventId`                                         | Stable id, unique across the log (`UNIQUE` index). Default `evt_` + the sequence number, zero-padded to 8 digits, so a replayed scenario hashes identically.                                                                                           |
| `seq`                                             | Position, gap-free from 1 (the database enforces it).                                                                                                                                                                                                  |
| `transactionId`                                   | The transaction the event is about, when there is one (foreign key).                                                                                                                                                                                   |
| `type`, `ts`, `actor`, `subjectType`, `subjectId` | What happened, when (ISO-8601 UTC, supplied by the application clock), who or what recorded it, and about which object.                                                                                                                                |
| `payload`                                         | Canonical JSON text (sorted keys, no whitespace, no `undefined`/`NaN`/non-plain objects). The **exact stored string** is hashed. Secret-looking keys and bearer-token values are refused before storage.                                               |
| `mandateId`, `mandateVersion`                     | The mandate (and version) in force. For an event about a transaction this is the transaction's own pinned mandate, read at append time; mandate events set it explicitly. A draft that is not yet a mandate version records the id and a null version. |
| `agreementId`, `agreementVersion`                 | The agreement and the **negotiation agreement version** in force for that transaction at append time (null before an agreement exists). If the agreement changes, the replacement is a different transaction and its events carry the new version.     |
| `provenance`                                      | `OBSERVED_EXTERNAL` or `LOCAL_DECISION` (section 3).                                                                                                                                                                                                   |
| `prevHash`, `hash`                                | Previous event's hash (64 zeros for the first event) and this event's hash.                                                                                                                                                                            |
| `hashVersion`                                     | Which serialization the hash was computed over (section 4).                                                                                                                                                                                            |

## 3. Observed external facts vs local decisions

`provenance` records what the **payload asserts**, not who typed it:

- **`OBSERVED_EXTERNAL`**: the payload reports something PayPal said (today: `PAYPAL_ORDER_OBSERVED`, the result of an authenticated read of the order). The database refuses this value unless the actor is `PAYPAL_API` or `PAYPAL_WEBHOOK`, and the verifier flags a stored event that violates it. Even so, it only means "PayPal told us this and we wrote it down". The chain does **not** prove PayPal said it. External evidence is the authenticated read and a verified webhook (docs/PAYPAL_INTEGRATION.md), not this log.
- **`LOCAL_DECISION`** (the default): something this system or its operator decided, did, refused or noticed: policy decisions, state transitions (`TX_STATE_CHANGED` is always a local decision even when a PayPal response prompted it), approvals, write-ahead notes, refusals, anomalies, webhook rejections and outcomes, mandate changes.

Default is `LOCAL_DECISION` on purpose: an event is only labelled an external observation when the code that records it says so, so the label cannot be earned by accident. A `PAYPAL_API` actor on its own does not make an event an observation (a refused call or an anomaly noticed by us is still our decision).

## 4. How the hash is computed

Hash version **2** (every event appended since migration 0008):

```
hash = SHA-256( "pactpay.audit.v2\n" + canonicalJson({
  hashVersion, seq, eventId, ts, actor, type, subjectType, subjectId, transactionId,
  mandateId, mandateVersion, agreementId, agreementVersion, provenance, payload, prevHash
}) )
```

- SHA-256 is Node's `node:crypto` implementation (`createHash("sha256")`); there is no hand-written cryptography.
- `canonicalJson` is the repository's single canonical serializer (also used for mandate and offer-terms hashes): object keys sorted, no whitespace, strings via `JSON.stringify`, and it **throws** on values with no single canonical form. The same logical event always yields the same bytes.
- The prefix `pactpay.audit.v2\n` is domain separation: a version-2 digest cannot be re-presented as a version-1 digest of other data. The version number is itself hashed.
- `payload` is hashed as the canonical **string**, and the verifier additionally requires that string to be the canonical form of its own content, so re-spaced or re-ordered JSON is reported even if someone also fixed the hash.
- A known-answer test pins the digest of a fixed event against a hand-written canonical string (not one produced by the code under test), so an accidental change to the format fails a test. A format change must be a new `hashVersion`.

Hash version **1** (events written before migration 0008) hashed only `{seq, ts, actor, type, subjectType, subjectId, transactionId, payload, prevHash}`. Those rows are append-only, so migration 0008 does **not** rewrite them: they keep `hash_version = 1` and `NULL` in every new column, and are verified under the original form. Rules that stop that from becoming a loophole: a version-1 row must have all new columns null (otherwise they would be changes the hash does not cover), a version-1 row may not follow a version-2 row (`HASH_VERSION_DOWNGRADE`), and the database refuses to insert any new version-1 row.

## 5. Verification

```ts
verifyChain(db, anchor?)  // adapters/sqlite/audit.ts, wraps the pure verifyAuditEvents(events, anchor?)
```

It reads the whole log in `seq` order and checks, per event and in this order: position (`seq` = index + 1), link (`prevHash` = previous hash), version rules and structure, recomputed hash, canonical payload, unique event id. It stops at the first failure and returns:

```ts
{
  status: ("VERIFIED", count, headHash, legacyCount);
}
{
  status: ("FAILED", count, firstBadSeq, firstBadEventId, code, reason);
}
```

`code` is one of `SEQUENCE_GAP_OR_REORDER`, `PREV_HASH_MISMATCH`, `HASH_MISMATCH`, `MALFORMED_EVENT`, `HASH_VERSION_DOWNGRADE`, `DUPLICATE_EVENT_ID`, `TRUNCATED`, `ANCHOR_MISMATCH`. The result contains identifiers and a fixed reason string, **never payload text**. `npm run db:status` prints it.

What "first invalid event" means for each kind of damage:

| Damage                                        | Reported at                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| An event's payload or any hashed field edited | That event (`HASH_MISMATCH`).                                                            |
| An event edited and re-hashed on its own      | The **next** event (`PREV_HASH_MISMATCH`): its `prevHash` no longer matches.             |
| `prevHash` altered                            | That event (`PREV_HASH_MISMATCH`).                                                       |
| An event deleted (start, middle, a run)       | The first event after the hole (`SEQUENCE_GAP_OR_REORDER`).                              |
| Events swapped or moved                       | The first position whose predecessor is wrong.                                           |
| Several of the above                          | The lowest position, whatever order the damage was done in.                              |
| The **newest** events deleted                 | **Not detected without an anchor.** With one: `TRUNCATED` at the first missing position. |
| The whole chain recomputed from some point on | **Not detected without an anchor.** With one: `ANCHOR_MISMATCH`.                         |

### Anchor (optional, not wired to a store)

An anchor is `{ count, headHash }`: the head of a verified chain remembered **somewhere the database's attacker cannot write** (printed in a report, committed to a separate repository, written to an append-only log, signed by the operator). `verifyChain(db, anchor)` then also fails if the log has fewer events than the anchor, or the event at the anchored position has a different hash. A log that has only **grown** since the anchor still verifies. This repository implements the check, but **nothing takes, stores or schedules anchors**: that decision belongs to whoever deploys it, and until it is made, tail truncation and full rewrites go unseen.

## 6. Threat model and limitations

Assets: the record of what was decided and observed for each payment. Adversaries considered: (a) a bug or careless write that edits or removes history, (b) a person or process with SQL access who edits some rows, (c) a person or process with write access to the **entire database** (file, backups, the ability to drop triggers).

| Claim                                                                                       | Holds?                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An edit, deletion or reordering of **some** events leaves the chain verifiably inconsistent | **Yes** (tested for each kind, at the first, a middle and the last event).                                                                                                       |
| Triggers stop an application bug from UPDATE/DELETE-ing history                             | Yes, until someone drops the triggers; the hash chain is the backstop for that case.                                                                                             |
| The chain proves **who** wrote an event                                                     | **No.** There is no key and no signature. Anyone who can append can write any `actor`.                                                                                           |
| The chain prevents an attacker with **full database control** from rewriting history        | **No.** They can edit an event and recompute every later hash and `prev_hash`; the result verifies. A test demonstrates this.                                                    |
| The chain detects deletion of the newest events                                             | **No**, unless an anchor taken earlier is supplied.                                                                                                                              |
| An `OBSERVED_EXTERNAL` event proves PayPal said it                                          | **No.** It records what our code claims it read. External truth is PayPal's API, checked with an authenticated read or a verified webhook.                                       |
| `VERIFIED` means the events are true or complete                                            | **No.** It means the stored log is internally consistent (and consistent with the anchor, if given). An event that was never written, or was written wrongly, is not detectable. |

Not a digital signature: producing one would need a signing key that the database attacker cannot read, an agreed key-distribution and rotation story, and a verification routine that checks signatures against a trusted public key. None of that exists here, so this document and the UI call it **"local tamper-evidence"**. If signing is added later (for example signing each anchor with an operator key), it should be described as exactly that and nothing wider.

Other limits:

- The log is verified by reading all of it into memory (`ponytail:` comment in the code); fine for a demo, stream it if the log grows large.
- `ts` is the application's clock, not a trusted time source.
- Context columns (`mandate*`, `agreement*`) are read at append time. They say what was in force **when the event was recorded**, not what is in force now.
- The event id is deterministic, not secret and not unguessable; it is an identifier, not a capability.
- A privileged writer who can drop triggers can also insert rows directly; the verifier, not the database, is what catches a forged row (tested: a row that satisfies every database rule but carries a made-up hash fails at that row).
- Secrets: payload **keys** that look like credentials, and string **values** shaped like `Bearer <token>`, are refused before storage (`assertNoSecretKeys`). That is defence in depth, not a guarantee: callers must still never put secrets in a payload. Verification output and the CLI never print payloads.

## 7. Hardening that is deliberately not done

- Taking, storing and checking anchors on a schedule (needs a place the database owner cannot write).
- Signing events or anchors with a key (needs key management).
- A UI action to run verification (the CLI and the flagship page report `status`).
- Streaming verification of very large logs.
