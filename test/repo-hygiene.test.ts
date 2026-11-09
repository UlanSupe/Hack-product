import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

/** README.md plus every document under docs/ (the text a public reader sees first). */
const publicDocs = ["README.md", ...readdirSync("docs").map((f) => `docs/${f}`)].filter((f) =>
  f.endsWith(".md"),
);

describe("public open-source readiness", () => {
  it("ships an MIT LICENSE that package.json and the README both point to", () => {
    expect(existsSync("LICENSE")).toBe(true);
    expect(read("LICENSE")).toMatch(/^MIT License\r?\n/);
    expect(read("LICENSE")).toMatch(/Copyright \(c\) \d{4} \S/);
    expect((JSON.parse(read("package.json")) as { license?: string }).license).toBe("MIT");
    expect(read("README.md")).toMatch(/\[LICENSE\]\(LICENSE\)/);
  });

  it("README has every section an evaluator needs, and states what was and was not verified live against PayPal", () => {
    const readme = read("README.md");
    for (const heading of [
      "The problem",
      "Quick start",
      "Environment variables",
      "Commands",
      "Architecture",
      "Policy engine",
      "Agent architecture",
      "PayPal Sandbox configuration",
      "Threat model",
      "Benchmark methodology",
      "Testing",
      "Deployment",
      "Troubleshooting",
      "Known limitations",
      "License",
    ])
      expect(readme, `missing section: ${heading}`).toMatch(new RegExp(`^#{2,3} ${heading}`, "m"));
    // The honest status must not be silently dropped in a future edit.
    expect(readme).toMatch(/run end to end against the real PayPal Sandbox/i);
    expect(readme).toMatch(/signed webhooks \(seven PayPal-delivered events/i);
    expect(readme).toMatch(/needs a public HTTPS address/i);
  });

  it("every relative link in README.md and docs/ points to a file that exists", () => {
    const broken: string[] = [];
    for (const file of publicDocs) {
      for (const m of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1] ?? "";
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const path = target.split("#")[0] ?? "";
        if (path !== "" && !existsSync(join(dirname(file), path)))
          broken.push(`${file} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("no tracked text names a local machine path or looks like a real credential", () => {
    const roots = ["README.md", "CLAUDE.md", ".env.example", "render.yaml", ...publicDocs];
    const localPath = /[A-Za-z]:[\\/]+Users[\\/]|\/Users\/[a-z]|\/home\/[a-z]/;
    // Shapes of real keys: Anthropic/OpenAI-style, GitHub, AWS, Slack, JWT, private key blocks.
    const secretShape =
      /sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{30,}|github_pat_|AKIA[0-9A-Z]{16}|xox[bap]-|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./;
    const findings: string[] = [];
    for (const file of roots) {
      const text = read(file);
      if (localPath.test(text)) findings.push(`${file}: local path`);
      if (secretShape.test(text)) findings.push(`${file}: secret-shaped string`);
    }
    expect(findings).toEqual([]);
  });
});

describe("repository hygiene (CLAUDE.md: never commit secrets)", () => {
  it(".gitignore ignores env files but keeps .env.example tracked", () => {
    const lines = read(".gitignore").split(/\r?\n/);
    expect(lines).toContain(".env");
    expect(lines).toContain(".env.*");
    expect(lines).toContain("!.env.example");
    expect(lines).toContain("node_modules/");
    expect(lines).toContain(".next/");
    expect(lines).toContain("*.db");
  });

  it(".env.example holds only placeholders for secret-like keys and no NEXT_PUBLIC_ entries", () => {
    const secretLike = /(SECRET|KEY|TOKEN|PASSCODE|CLIENT_ID|WEBHOOK_ID)$/;
    for (const line of read(".env.example").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!m) continue;
      const [, name = "", value = ""] = m;
      expect(name.startsWith("NEXT_PUBLIC_"), `${name} must not be public`).toBe(false);
      if (secretLike.test(name)) {
        expect(
          value === "" || value.startsWith("replace-with-"),
          `${name} must be blank or a replace-with-* placeholder`,
        ).toBe(true);
      }
    }
  });
});
