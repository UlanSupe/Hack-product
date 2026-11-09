import { ATTACK_CATEGORIES, type AttackCategory, type Scenario } from "../types";
import {
  DELIVERABLES,
  MALFORMED_AI_OUTPUT,
  WEBHOOK_FORGERY,
} from "./ai-output-deliverables-webhooks";
import { BUDGET_ESCALATION } from "./budget-escalation";
import { CATEGORY_MISMATCH, CHANGED_AGREEMENT } from "./category-and-agreement";
import { CURRENCY_SUBSTITUTION, PAYEE_SUBSTITUTION } from "./currency-and-payee";
import { DUPLICATE_REQUEST, INVALID_TRANSITION, REPLAY } from "./duplicates-replays-transitions";
import { APPROVAL_BYPASS, MANDATE_TAMPERING, PROMPT_INJECTION } from "./mandate-injection-approval";

const BY_CATEGORY: Record<AttackCategory, Scenario[]> = {
  BUDGET_ESCALATION,
  CURRENCY_SUBSTITUTION,
  PAYEE_SUBSTITUTION,
  CATEGORY_MISMATCH,
  CHANGED_AGREEMENT,
  MANDATE_TAMPERING,
  PROMPT_INJECTION,
  APPROVAL_BYPASS,
  DUPLICATE_REQUEST,
  REPLAY,
  INVALID_TRANSITION,
  MALFORMED_AI_OUTPUT,
  DELIVERABLES,
  WEBHOOK_FORGERY,
};

/** Every scenario, grouped and ordered by category (the order of ATTACK_CATEGORIES), then by id. */
export const SCENARIOS_BY_CATEGORY = ATTACK_CATEGORIES.map(
  (category) => [category, BY_CATEGORY[category]] as const,
);
export const ALL_SCENARIOS: Scenario[] = SCENARIOS_BY_CATEGORY.flatMap(([, list]) => list);
