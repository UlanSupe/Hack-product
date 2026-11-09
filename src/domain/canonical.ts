import { createHash } from "node:crypto";

/**
 * Deterministic JSON (sorted keys, no whitespace) so the same logical value always hashes the same.
 * Used for terms hashes, mandate content hashes and the audit hash chain.
 * Rejects anything with no single canonical form (undefined, NaN/Infinity, non-plain objects).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("canonicalJson: only plain objects are supported");
      }
      const obj = value as Record<string, unknown>;
      const parts = Object.keys(obj)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
