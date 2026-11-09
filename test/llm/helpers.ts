import { createMockBuyerModel, createMockSellerModel } from "@/agents/mock-models";
import type { SellerConfig } from "@/domain/agent-contract";
import type { FetchLike } from "@/adapters/llm/anthropic";
import type { ModelReply, ModelRequest, ModelTransport } from "@/ports/model-transport";

/** A syntactically valid but obviously fake key. It must never appear in any output, log or error. */
export const KEY = "sk-test-0123456789abcdef-NOT-A-REAL-KEY";
export const MODEL = "test-model-1";

type Resp = Awaited<ReturnType<FetchLike>>;
export type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

export type Step = Resp | Error | "hang-until-abort" | ((call: Call) => Resp | Promise<Resp>);

export const response = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Resp => {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name) => h.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
};

export const messageWith = (text: string, stop_reason = "end_turn"): Resp =>
  response(200, {
    id: "msg_1",
    type: "message",
    role: "assistant",
    stop_reason,
    content: [{ type: "text", text }],
  });

export const providerError = (
  status: number,
  type: string,
  headers: Record<string, string> = {},
): Resp =>
  response(
    status,
    {
      type: "error",
      error: { type, message: `secret detail ${KEY} must never be copied` },
      request_id: "req_body_0001",
    },
    { "request-id": "req_hdr_0001", ...headers },
  );

/** Scripted fetch: step n answers call n; the last step repeats. Records every call. */
export function fetchStub(...steps: Step[]): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const stub: FetchLike & { calls: Call[] } = Object.assign(
    async (url: string, init: Parameters<FetchLike>[1]): Promise<Resp> => {
      const call: Call = {
        url,
        headers: init.headers,
        body: JSON.parse(init.body) as Record<string, unknown>,
      };
      calls.push(call);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (step === undefined) throw new Error("no step");
      if (step instanceof Error) throw step;
      if (step === "hang-until-abort") {
        return new Promise<Resp>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error(`aborted ${KEY}`)), {
            once: true,
          });
        });
      }
      return typeof step === "function" ? step(call) : step;
    },
    { calls },
  );
  return stub;
}

/** Wraps what a deterministic model would say in the provider's response envelope. */
export const envelopeOf = (reply: ModelReply): Resp =>
  reply.kind === "refusal"
    ? response(200, { stop_reason: "refusal", content: [] })
    : messageWith(reply.text);

/**
 * A fetch that answers every call by asking a deterministic model, as if the provider were that model. This lets
 * the real adapter, runtime and validators run end to end without a network.
 */
export function fetchDelegatingTo(
  pick: (task: string, system: string) => ModelTransport = defaultPick,
): FetchLike & { calls: Call[] } {
  return fetchStub(async (call) => {
    const messages = call.body.messages as { content: string }[];
    const prompt = messages[0]?.content ?? "";
    const task = (JSON.parse(prompt) as { task: string }).task;
    const request: ModelRequest = {
      agent: ["INTERPRET", "COMPARE"].includes(task) ? "buyer" : "seller",
      task,
      system: String(call.body.system),
      prompt,
      attempt: 1,
      corrective: null,
      maxOutputChars: 8000,
    };
    return envelopeOf(
      await pick(task, String(call.body.system)).complete(request, {
        signal: new AbortController().signal,
      }),
    );
  });
}

/**
 * Buyer tasks go to the deterministic buyer. Seller tasks go to a deterministic seller built from the very
 * constraints the agent put in its system prompt, so the seller's offers always satisfy its own rules.
 */
function defaultPick(task: string, system: string): ModelTransport {
  if (task === "INTERPRET" || task === "COMPARE") return createMockBuyerModel();
  const marker = "Seller constraints (trusted configuration): ";
  const at = system.indexOf(marker);
  if (at < 0) throw new Error("no seller constraints in the system prompt");
  const line = system.slice(at + marker.length).split("\n")[0] ?? "";
  const constraints = JSON.parse(line) as Omit<SellerConfig, "maxRounds">;
  return createMockSellerModel({ ...constraints, maxRounds: 4 });
}
