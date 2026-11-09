/**
 * Reads a model reply as JSON, strictly. A reply is one JSON object, optionally wrapped in a single
 * code fence (models do that); anything else, such as prose before or after, a second object, an array
 * or a bare value, is rejected rather than "helpfully" repaired. Repairing is how injected text gets in.
 */
export type ParsedReply =
  { ok: true; value: Record<string, unknown> } | { ok: false; issue: string };

export function parseModelJson(text: string): ParsedReply {
  let body = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(body);
  if (fenced) body = (fenced[1] as string).trim();
  if (!body.startsWith("{") || !body.endsWith("}")) {
    return { ok: false, issue: "the reply must be a single JSON object with no text around it" };
  }
  try {
    const value: unknown = JSON.parse(body);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, issue: "the reply must be a JSON object" };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, issue: "the reply is not valid JSON" };
  }
}
