import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { parseEnv } from "@/config/env.schema";
import { liveModelFrom } from "@/server/agent-factory";

import { KEY, MODEL, fetchStub, messageWith } from "./helpers";

function envOf(raw: Record<string, string>) {
  const r = parseEnv(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.env;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}
const rel = (p: string) => relative(".", p).replaceAll("\\", "/");
const SRC = sourceFiles("src").map((p) => ({ path: rel(p), text: readFileSync(p, "utf8") }));

describe("liveModelFrom: configuration to a bounded model, or nothing", () => {
  it("is undefined unless AGENT_MODE=llm (the key alone never switches a model on)", () => {
    expect(liveModelFrom(envOf({}))).toBeUndefined();
    expect(liveModelFrom(envOf({ ANTHROPIC_API_KEY: KEY, AGENT_MODEL: MODEL }))).toBeUndefined();
    expect(
      liveModelFrom(envOf({ AGENT_MODE: "scripted", ANTHROPIC_API_KEY: KEY })),
    ).toBeUndefined();
  });

  it("builds the transport and bounds in llm mode: 60 s default per attempt, deadline = attempts x timeout", () => {
    const live = liveModelFrom(
      envOf({ AGENT_MODE: "llm", ANTHROPIC_API_KEY: KEY, AGENT_MODEL: MODEL }),
    );
    expect(live?.transport.name).toBe(`anthropic:${MODEL}`);
    expect(live?.runtime).toEqual({ timeoutMs: 60_000, maxAttempts: 3, totalDeadlineMs: 180_000 });
  });

  it("honors explicit timeout and attempts, and caps the overall deadline", () => {
    const base = { AGENT_MODE: "llm", ANTHROPIC_API_KEY: KEY, AGENT_MODEL: MODEL };
    expect(
      liveModelFrom(envOf({ ...base, AGENT_TIMEOUT_MS: "5000", AGENT_MAX_ATTEMPTS: "2" }))?.runtime,
    ).toEqual({
      timeoutMs: 5000,
      maxAttempts: 2,
      totalDeadlineMs: 10_000,
    });
    expect(
      liveModelFrom(envOf({ ...base, AGENT_TIMEOUT_MS: "120000", AGENT_MAX_ATTEMPTS: "5" }))
        ?.runtime.totalDeadlineMs,
    ).toBe(600_000);
  });

  it("passes the configured output budget and key to the adapter, and nothing else", async () => {
    const fetch = fetchStub(messageWith("{}"));
    const live = liveModelFrom(
      envOf({
        AGENT_MODE: "llm",
        ANTHROPIC_API_KEY: KEY,
        AGENT_MODEL: MODEL,
        AGENT_MAX_OUTPUT_TOKENS: "2048",
      }),
      fetch,
    );
    await live?.transport.complete(
      {
        agent: "buyer",
        task: "COMPARE",
        system: "s",
        prompt: "p",
        attempt: 1,
        corrective: null,
        maxOutputChars: 8000,
      },
      { signal: new AbortController().signal },
    );
    expect(fetch.calls[0]?.body.max_tokens).toBe(2048);
    expect(fetch.calls[0]?.headers["x-api-key"]).toBe(KEY);
  });
});

describe("the policy engine and payment code do not depend on any model provider", () => {
  const importsOf = (text: string) =>
    [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");

  it("only the server's factory imports the provider adapter", () => {
    const users = SRC.filter((f) => importsOf(f.text).some((i) => /adapters\/llm/.test(i))).map(
      (f) => f.path,
    );
    expect(users).toEqual(["src/server/agent-factory.ts"]);
  });

  it("the domain layer (policy engine included), the ports other than the model one, and the negotiation/mandate services never import agents, the model port or an adapter", () => {
    const guarded = SRC.filter(
      (f) =>
        f.path.startsWith("src/domain/") ||
        (f.path.startsWith("src/ports/") &&
          f.path !== "src/ports/model-transport.ts" &&
          f.path !== "src/ports/agents.ts") ||
        /^src\/application\/(negotiations|mandates)\.ts$/.test(f.path) ||
        /policy/.test(f.path) ||
        /payment|paypal|capture|payout/i.test(f.path),
    );
    expect(guarded.length).toBeGreaterThan(5);
    for (const f of guarded) {
      for (const spec of importsOf(f.text)) {
        expect(spec, f.path).not.toMatch(/agents|model-transport|adapters\/llm|anthropic/i);
      }
    }
  });

  it("the provider key is read in exactly two places: the env schema and the factory that hands it to the adapter", () => {
    const readers = SRC.filter((f) => /ANTHROPIC_API_KEY/.test(f.text)).map((f) => f.path);
    expect(readers.sort()).toEqual(["src/config/env.schema.ts", "src/server/agent-factory.ts"]);
    for (const f of SRC)
      expect(f.text, f.path).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(ANTHROPIC|AGENT_MODEL)/);
  });

  it("no client component can reach the provider adapter or the key", () => {
    for (const f of SRC.filter((s) => /^\s*["']use client["']/.test(s.text))) {
      expect(f.text, f.path).not.toMatch(/adapters\/llm|agent-factory|ANTHROPIC/);
    }
  });

  it("the adapter has no tool, code-execution, shell, filesystem or logging surface", () => {
    const adapter = SRC.find((f) => f.path === "src/adapters/llm/anthropic.ts")?.text ?? "";
    expect(adapter).not.toMatch(
      /console\.|child_process|node:fs|\beval\(|new Function|require\(|process\.env/,
    );
    const code = adapter.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\btools\b|tool_choice|"thinking"|stream\b|mcp_servers/);
  });

  it("each provider has one hard-coded origin and no other host appears in the adapters", () => {
    const hosts = SRC.flatMap((f) =>
      [...f.text.matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((m) => [f.path, m[0]] as const),
    ).filter(([path]) => path.startsWith("src/adapters/llm/"));
    expect([...new Set(hosts.map(([, h]) => h))].sort()).toEqual([
      "https://api.anthropic.com",
      "https://api.groq.com",
    ]);
  });
});

describe("the smoke script", () => {
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, ["scripts/agents-smoke.ts", ...args], {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        ...env,
      },
      timeout: 30_000,
    });

  it("without credentials it makes no call, says SKIPPED and NOT VERIFIED, and exits 0 (3 with --require)", () => {
    const blank = { AGENT_MODE: "", ANTHROPIC_API_KEY: "", AGENT_MODEL: "" };
    const soft = run([], blank);
    expect(soft.status).toBe(0);
    expect(soft.stdout).toMatch(/SKIPPED/);
    expect(soft.stdout).toMatch(/NOT VERIFIED/);
    expect(soft.stdout).not.toMatch(/VERIFIED by this run/);
    expect(run(["--require"], blank).status).toBe(3);
  });

  it("in llm mode with a key but no model it refuses to start and never echoes the key", () => {
    const r = run([], { AGENT_MODE: "llm", ANTHROPIC_API_KEY: KEY, AGENT_MODEL: "" });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("AGENT_MODEL");
    expect(`${r.stdout}${r.stderr}`).not.toContain(KEY);
  });

  it("is wired as an npm script", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["agents:smoke"]).toBe("node scripts/agents-smoke.ts");
  });
});
