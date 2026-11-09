import {
  BuyerCompareInputSchema,
  BuyerInterpretInputSchema,
  SellerAnswerInputSchema,
  SellerCounterInputSchema,
  SellerOpenInputSchema,
  type SellerConfig,
} from "../domain/agent-contract.ts";
import type { ModelReply, ModelRequest, ModelTransport } from "../ports/model-transport.ts";
import { mockBuyerCompare, mockBuyerInterpret } from "./mock-buyer.ts";
import { mockSellerAnswer, mockSellerCounter, mockSellerOpen } from "./mock-seller.ts";

/**
 * Deterministic "models". They are ModelTransports, so the mock agents travel the very same road as a
 * real provider: the agent serializes the prompt, the mock reads that JSON (and nothing else), answers
 * with TEXT, and the agent parses and validates the text. No credentials, no network, no randomness.
 */

export const PLAIN_REFUSAL: ModelReply = { kind: "refusal", message: "mock: input not understood" };

/** Reads the `{ protocol, task, input }` document from a prompt. */
export function readPrompt(request: ModelRequest): { task: string; input: unknown } | null {
  try {
    const doc: unknown = JSON.parse(request.prompt);
    if (doc !== null && typeof doc === "object" && "task" in doc && "input" in doc) {
      const { task, input } = doc;
      if (typeof task === "string") return { task, input };
    }
  } catch {
    // fall through
  }
  return null;
}

export const asText = (output: unknown): ModelReply => ({
  kind: "text",
  text: JSON.stringify(output),
});

export function createMockBuyerModel(): ModelTransport {
  return {
    name: "mock-buyer",
    complete(request) {
      const doc = readPrompt(request);
      if (doc?.task === "INTERPRET") {
        const input = BuyerInterpretInputSchema.safeParse(doc.input);
        return Promise.resolve(
          input.success ? asText(mockBuyerInterpret(input.data)) : PLAIN_REFUSAL,
        );
      }
      if (doc?.task === "COMPARE") {
        const input = BuyerCompareInputSchema.safeParse(doc.input);
        return Promise.resolve(
          input.success ? asText(mockBuyerCompare(input.data)) : PLAIN_REFUSAL,
        );
      }
      return Promise.resolve(PLAIN_REFUSAL);
    },
  };
}

export function createMockSellerModel(config: SellerConfig): ModelTransport {
  return {
    name: `mock-seller:${config.sellerId}`,
    complete(request) {
      const doc = readPrompt(request);
      if (doc?.task === "OPEN") {
        const input = SellerOpenInputSchema.safeParse(doc.input);
        return Promise.resolve(
          input.success ? asText(mockSellerOpen(config, input.data)) : PLAIN_REFUSAL,
        );
      }
      if (doc?.task === "COUNTER") {
        const input = SellerCounterInputSchema.safeParse(doc.input);
        return Promise.resolve(
          input.success ? asText(mockSellerCounter(config, input.data)) : PLAIN_REFUSAL,
        );
      }
      if (doc?.task === "ANSWER") {
        const input = SellerAnswerInputSchema.safeParse(doc.input);
        return Promise.resolve(
          input.success ? asText(mockSellerAnswer(config, input.data)) : PLAIN_REFUSAL,
        );
      }
      return Promise.resolve(PLAIN_REFUSAL);
    },
  };
}
