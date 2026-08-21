import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupJestUpstreamSuite(options = {}) {
  const suite = setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "jest-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/jest",
    inventoryDirectory: "packages",
    accept: (path) => /^packages\/.*\/__tests__\/.*\.(?:test|spec)\.(?:js|jsx|ts|tsx)$/.test(path),
    force: options.force,
  });
  // jest-docblock's published source depends on the tiny CommonJS
  // `detect-newline` package. The compiler deliberately does not guess a
  // CommonJS default export, so provide the same dependency as an explicit
  // ESM adapter inside the verified checkout. This keeps the upstream test
  // and implementation unchanged while making its real package dependency
  // available to both Node's oracle and the Wasm project resolver.
  const dependencyRoot = join(suite.root, "node_modules", "detect-newline");
  mkdirSync(dependencyRoot, { recursive: true });
  writeFileSync(
    join(dependencyRoot, "package.json"),
    '{"name":"detect-newline","type":"module","main":"./index.ts","exports":"./index.ts"}\n',
  );
  writeFileSync(
    join(dependencyRoot, "index.ts"),
    `export default function detectNewline(value: string): string | undefined {
  if (typeof value !== "string") throw new TypeError("Expected a string");
  const matches = value.match(/(?:\\r?\\n)/g) ?? [];
  if (matches.length === 0) return undefined;
  const crlf = matches.filter((newline) => newline === "\\r\\n").length;
  return crlf > matches.length - crlf ? "\\r\\n" : "\\n";
}
export function graceful(value: unknown): string {
  return typeof value === "string" ? detectNewline(value) ?? "\\n" : "\\n";
}
`,
  );
  return suite;
}
