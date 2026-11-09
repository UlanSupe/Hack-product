import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Reads the real tokens from globals.css so the check cannot drift from the UI.
const css = readFileSync("src/app/globals.css", "utf8");
const root = /:root\s*{([^}]*)}/.exec(css)?.[1] ?? "";
const token = (name: string): string => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(root);
  if (!m?.[1]) throw new Error(`token --${name} not found as #rrggbb`);
  return m[1];
};

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
};
export const ratio = (fg: string, bg: string) => {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (a + 0.05) / (b + 0.05);
};

const STATUSES = ["success", "warning", "danger", "info", "neutral"] as const;
const SURFACES = ["bg", "surface", "surface-2", "surface-3"] as const;

describe("WCAG AA contrast of UI tokens (>= 4.5:1 for text)", () => {
  it.each(SURFACES)("body text on %s", (s) => {
    expect(ratio(token("text"), token(s))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SURFACES)("muted text on %s", (s) => {
    expect(ratio(token("muted"), token(s))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(STATUSES)("%s chip text on its own tinted background", (t) => {
    expect(ratio(token(t), token(`${t}-bg`))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(STATUSES)("%s text on page surfaces (stand-alone status text)", (t) => {
    for (const s of ["bg", "surface", "surface-2"] as const) {
      expect(ratio(token(t), token(s)), `${t} on ${s}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("text on the primary (info) button and the error panel", () => {
    expect(ratio(token("bg"), token("info"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token("text"), token("danger-bg"))).toBeGreaterThanOrEqual(4.5);
  });

  it("focus ring has >= 3:1 against every surface", () => {
    for (const s of SURFACES) expect(ratio(token("focus"), token(s)), s).toBeGreaterThanOrEqual(3);
  });
});
