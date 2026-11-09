import { z } from "zod";

import { ForbiddenError, NotFoundError } from "../domain/errors.ts";
import {
  CATEGORY_CODES,
  CURRENCY_CODES,
  SERVICE_CATEGORIES,
  SUPPORTED_CURRENCIES,
  describeRules,
  toInputFields,
  validateMandateInput,
  type FieldError,
  type MandateInputFields,
  type MandateTerms,
} from "../domain/mandate.ts";
import type {
  MandateDraft,
  MandateStore,
  MandateVersion,
  SellerOption,
} from "../ports/mandate-store.ts";

/**
 * Mandate use cases. Authority model:
 *   - Only the human OPERATOR may create, edit, approve, discard or revoke. Every method checks the actor FIRST,
 *     before reading or validating anything, so an AI agent (or anonymous caller) learns nothing and changes nothing.
 *   - Approved mandates are immutable. "Editing" one means editing a DRAFT; approving it creates the next version.
 *     Transactions pin the version they started under, so approving a new version never rewrites their rules.
 *   - Agents have no import path to this module (lint rule) and the type system never hands them an OperatorActor;
 *     the runtime check below is the backstop for anything that forges one.
 */

export type OperatorActor = { kind: "OPERATOR"; id: string };
export type Actor = OperatorActor | { kind: "AGENT"; id: string } | { kind: "ANONYMOUS" };

export function requireOperator(actor: Actor, action: string): asserts actor is OperatorActor {
  if (
    typeof actor !== "object" ||
    actor === null ||
    actor.kind !== "OPERATOR" ||
    typeof actor.id !== "string" ||
    actor.id === ""
  ) {
    const who =
      typeof actor === "object" && actor !== null && "kind" in actor
        ? String(actor.kind)
        : "unknown";
    throw new ForbiddenError(
      `only the human operator may ${action}; ${who.toLowerCase()} callers cannot`,
    );
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

/* ------------------------------------------------------------------ views (what the UI and API see) */

export type MandateVersionView = {
  id: string;
  version: number;
  status: "ACTIVE" | "REVOKED";
  expiresAt: string;
  createdAt: string;
  contentHash: string;
  sourceDraftId: string | null;
  fields: MandateInputFields;
  rules: string[];
};

export type DraftView = {
  id: string;
  mandateId: string;
  baseVersion: number | null;
  revision: number;
  status: MandateDraft["status"];
  approvedVersion: number | null;
  fields: MandateInputFields;
  rules: string[];
  createdAt: string;
  updatedAt: string;
};

export type MandateSummary = {
  id: string;
  latest: MandateVersionView;
  versions: MandateVersionView[];
  openDraft: DraftView | null;
};

export type Overview = {
  mandates: MandateSummary[];
  drafts: DraftView[];
  sellers: SellerOption[];
  currencies: { code: string; label: string; exponent: number }[];
  categories: { code: string; label: string }[];
};

const versionView = (v: MandateVersion): MandateVersionView => ({
  id: v.id,
  version: v.version,
  status: v.status,
  expiresAt: v.expiresAt,
  createdAt: v.createdAt,
  contentHash: v.contentHash,
  sourceDraftId: v.sourceDraftId,
  fields: toInputFields(v.terms),
  rules: describeRules(v.terms),
});

const draftView = (d: MandateDraft): DraftView => ({
  id: d.id,
  mandateId: d.mandateId,
  baseVersion: d.baseVersion,
  revision: d.revision,
  status: d.status,
  approvedVersion: d.approvedVersion,
  fields: toInputFields(d.terms),
  rules: describeRules(d.terms),
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

/* ------------------------------------------------------------------ request shapes */

const Id = z.string({ error: "is required" }).regex(/^[A-Za-z0-9_-]{1,64}$/, "is not a valid id");
const Revision = z
  .number({ error: "is required" })
  .int("must be a whole number")
  .min(1, "must be at least 1");
const strict = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape);

const CreateRequest = strict({
  basedOn: strict({ mandateId: Id, version: Revision }).optional(),
  fields: z.unknown(),
});
const UpdateRequest = strict({ draftId: Id, revision: Revision, fields: z.unknown() });
const DraftRef = strict({ draftId: Id, revision: Revision });
const RevokeRequest = strict({ mandateId: Id, expectedVersion: Revision });

function parseRequest<S extends z.ZodType>(schema: S, raw: unknown): Result<z.infer<S>> {
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    errors: r.error.issues.flatMap((i) =>
      i.code === "unrecognized_keys"
        ? i.keys.map((k) => ({
            field: k.slice(0, 40),
            message: "is not a recognised field and cannot be set through this request",
          }))
        : [{ field: i.path.join(".") || "(root)", message: i.message }],
    ),
  };
}

/* ------------------------------------------------------------------ service */

export type MandateServiceDeps = {
  store: MandateStore;
  now: () => Date;
  newId: (prefix: string) => string;
};

export function createMandateService({ store, now, newId }: MandateServiceDeps) {
  const stamp = () => now().toISOString();

  /** Validates fields and checks the sellers exist (the one rule that needs the store). */
  function validateFields(raw: unknown): Result<MandateTerms> {
    const v = validateMandateInput(raw);
    if (!v.ok) return v;
    const known = new Set(store.listSellers().map((s) => s.id));
    const unknown = v.terms.allowedSellerIds.filter((s) => !known.has(s));
    if (unknown.length > 0) {
      return {
        ok: false,
        errors: [
          {
            field: "allowedSellerIds",
            message: `unknown sellers: ${unknown.map((u) => JSON.stringify(u)).join(", ")}`,
          },
        ],
      };
    }
    return { ok: true, value: v.terms };
  }

  return {
    overview(actor: Actor): Overview {
      requireOperator(actor, "view mandate configuration");
      const mandates = store.listLatestMandates().map((latest): MandateSummary => {
        const drafts = store.listDrafts().filter((d) => d.mandateId === latest.id);
        return {
          id: latest.id,
          latest: versionView(latest),
          versions: store.listVersions(latest.id).map(versionView),
          openDraft: drafts[0] ? draftView(drafts[0]) : null,
        };
      });
      const lineages = new Set(mandates.map((m) => m.id));
      return {
        mandates,
        // drafts for mandates that do not exist yet (brand new)
        drafts: store
          .listDrafts()
          .filter((d) => d.baseVersion === null || !lineages.has(d.mandateId))
          .map(draftView),
        sellers: store.listSellers(),
        currencies: CURRENCY_CODES.map((code) => ({
          code,
          label: SUPPORTED_CURRENCIES[code].label,
          exponent: SUPPORTED_CURRENCIES[code].exponent,
        })),
        categories: CATEGORY_CODES.map((code) => ({ code, label: SERVICE_CATEGORIES[code] })),
      };
    },

    /** Start a draft: from scratch, or from an existing approved version (which stays untouched). */
    createDraft(actor: Actor, raw: unknown): Result<DraftView> {
      requireOperator(actor, "create a mandate draft");
      const req = parseRequest(CreateRequest, raw);
      if (!req.ok) return req;
      const terms = validateFields(req.value.fields);
      if (!terms.ok) return terms;

      const base = req.value.basedOn;
      if (base && !store.getMandate(base.mandateId, base.version))
        throw new NotFoundError(`mandate ${base.mandateId} version ${base.version}`);
      const draft = store.createDraft({
        id: newId("drf"),
        mandateId: base ? base.mandateId : newId("mdt"),
        baseVersion: base ? base.version : null,
        ownerId: actor.id,
        terms: terms.value,
        actorId: actor.id,
        now: stamp(),
      });
      return { ok: true, value: draftView(draft) };
    },

    /** Edits an open draft. Never touches an approved mandate or any transaction. */
    updateDraft(actor: Actor, raw: unknown): Result<DraftView> {
      requireOperator(actor, "edit a mandate draft");
      const req = parseRequest(UpdateRequest, raw);
      if (!req.ok) return req;
      const terms = validateFields(req.value.fields);
      if (!terms.ok) return terms;
      const draft = store.updateDraft({
        id: req.value.draftId,
        expectedRevision: req.value.revision,
        terms: terms.value,
        actorId: actor.id,
        now: stamp(),
      });
      return { ok: true, value: draftView(draft) };
    },

    discardDraft(actor: Actor, raw: unknown): Result<DraftView> {
      requireOperator(actor, "discard a mandate draft");
      const req = parseRequest(DraftRef, raw);
      if (!req.ok) return req;
      return {
        ok: true,
        value: draftView(
          store.discardDraft({
            id: req.value.draftId,
            expectedRevision: req.value.revision,
            actorId: actor.id,
            now: stamp(),
          }),
        ),
      };
    },

    /** Approving creates the next immutable version. This is the only way a mandate's rules ever change. */
    approveDraft(actor: Actor, raw: unknown): Result<MandateVersionView> {
      requireOperator(actor, "approve a mandate");
      const req = parseRequest(DraftRef, raw);
      if (!req.ok) return req;
      return {
        ok: true,
        value: versionView(
          store.approveDraft({
            id: req.value.draftId,
            expectedRevision: req.value.revision,
            actorId: actor.id,
            now: stamp(),
          }),
        ),
      };
    },

    revoke(actor: Actor, raw: unknown): Result<MandateVersionView> {
      requireOperator(actor, "revoke a mandate");
      const req = parseRequest(RevokeRequest, raw);
      if (!req.ok) return req;
      return {
        ok: true,
        value: versionView(
          store.revokeMandate({
            mandateId: req.value.mandateId,
            expectedVersion: req.value.expectedVersion,
            actorId: actor.id,
            now: stamp(),
          }),
        ),
      };
    },
  };
}

export type MandateService = ReturnType<typeof createMandateService>;
