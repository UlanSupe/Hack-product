// Layer rules from docs/ARCHITECTURE.md section 3.1. Kept in its own file so
// test/boundaries.test.ts can load exactly these rules and prove they fire.
// Server/client split is enforced separately: src/server/* imports "server-only",
// so a client-component import of it fails the Next build.

/** Import patterns matching a layer via the `@/` alias or a relative path. */
const layer = (names, message) => ({
  group: names.flatMap((n) => [`@/${n}`, `@/${n}/**`, `**/${n}`, `**/${n}/**`]),
  message,
});

const packages = (names, message) => ({ group: names, message });

const files = (glob, patterns) => ({
  files: [glob],
  rules: { "no-restricted-imports": ["error", { patterns }] },
});

const FRAMEWORKS = ["next", "next/**", "react", "react-dom", "server-only"];

export default [
  files("src/domain/**/*.{ts,tsx}", [
    layer(
      ["application", "adapters", "agents", "ports", "server", "config", "app"],
      "domain/ is pure: it may not import other layers.",
    ),
    packages(FRAMEWORKS, "domain/ must not depend on frameworks."),
  ]),
  files("src/ports/**/*.{ts,tsx}", [
    layer(
      ["application", "adapters", "agents", "server", "config", "app"],
      "ports/ may import only domain/.",
    ),
    packages(FRAMEWORKS, "ports/ must not depend on frameworks."),
  ]),
  // Agents are untrusted-output producers: no path to money, storage, or the web layer.
  files("src/agents/**/*.{ts,tsx}", [
    layer(
      ["adapters", "application", "server", "config", "app"],
      "agents/ may import only domain/ and ports/ (it must not reach ActionGateway, PayPal, or the store).",
    ),
    packages(FRAMEWORKS, "agents/ must not depend on frameworks."),
  ]),
  files("src/application/**/*.{ts,tsx}", [
    layer(
      ["adapters", "app", "server"],
      "application/ talks to ports; adapters are wired in server/.",
    ),
    packages(
      ["next", "next/**", "react", "react-dom", "server-only"],
      "application/ is framework-free.",
    ),
  ]),
  files("src/adapters/**/*.{ts,tsx}", [
    layer(["application", "agents", "app"], "adapters/ implement ports; they may not call upward."),
  ]),
  // The web layer must not reach adapters (money/storage) directly; go through application/.
  files("src/app/**/*.{ts,tsx}", [
    layer(["adapters"], "app/ must go through application/, never straight to adapters/."),
  ]),
];
