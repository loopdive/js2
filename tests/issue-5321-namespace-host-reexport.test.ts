// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5321 — a module namespace object whose exports come from a Node builtin.
//
// Prettier's `#universal/assert` is literally
//
//     export { equal, ok, strictEqual } from "node:assert";
//
// and 15 of its source files do `import * as assert from "#universal/assert"`.
// Two independent defects made that read back as an unusable value:
//
//  1. `ModuleResolver` pins TypeScript's Node10 resolver, which predates the
//     package.json `imports` field — so `#universal/assert` resolved to null,
//     the graph walker dropped the edge, and `getExportsOfModule` reported an
//     EMPTY module. The namespace object was materialized empty and
//     `assert.equal(…)` threw "equal is not a function".
//  2. With the module resolved, every export is an alias to an unresolvable
//     `node:assert` symbol — no declaration, no compiled function — so
//     `namespaceFunctionExports` declined the WHOLE object and the binding fell
//     back to the identifier path, which produces null. `assert.equal` then
//     threw "Cannot read properties of null".
//
// The fixtures are plain untyped `.js`, matching how the upstream npm suites
// feed package code in. Annotating the namespace `: any` routes the member
// access through the dynamic-property path instead of the namespace-object
// decision, so a typed fixture passes with and without the fix and proves
// nothing.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/**
 * Reports the namespace member's callable-ness AND that it is the REAL host
 * binding: a namespace slot filled with a no-op would still say "function".
 */
const CONSUMER = (specifier: string) => `import * as assert from "${specifier}";

export function run() {
  let out = typeof assert.equal;
  try {
    assert.equal(1, 1);
    out += ":quiet";
  } catch {
    out += ":threw";
  }
  try {
    assert.equal(1, 2);
    out += ":silent";
  } catch {
    out += ":throws";
  }
  return out;
}
`;

const ENTRY = `import { run as direct } from "./direct.js";
import { run as mapped } from "./mapped.js";
import { run as twoStep } from "./two-step.js";

export function testDirect(): string { return (direct as unknown as () => string)(); }
export function testMapped(): string { return (mapped as unknown as () => string)(); }
export function testTwoStep(): string { return (twoStep as unknown as () => string)(); }
`;

async function compileFixture(): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "js2-ns-host-reexport-"));
  roots.push(root);
  mkdirSync(join(root, "universal"), { recursive: true });
  // A package scope whose `imports` map is the only route to `#universal/*`.
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "ns-host-reexport-fixture",
      type: "module",
      imports: { "#universal/*": "./universal/*.js" },
    }),
  );
  writeFileSync(join(root, "universal", "assert.js"), `export { equal, ok, strictEqual } from "node:assert";\n`);
  // The two-step spelling: the builtin is imported, then republished by a bare
  // `export { … }` whose local target is resolved by name inside the file.
  writeFileSync(
    join(root, "two-step-assert.js"),
    `import { equal, ok, strictEqual } from "node:assert";\nexport { equal, ok, strictEqual };\n`,
  );
  writeFileSync(join(root, "direct.js"), CONSUMER("./universal/assert.js"));
  writeFileSync(join(root, "mapped.js"), CONSUMER("#universal/assert"));
  writeFileSync(join(root, "two-step.js"), CONSUMER("./two-step-assert.js"));
  writeFileSync(join(root, "entry.ts"), ENTRY);
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return instance.exports as Record<string, () => unknown>;
}

describe("#5321 namespace object over a node-builtin re-export", () => {
  it("publishes the host binding for a relative specifier", async () => {
    const exports = await compileFixture();
    expect(exports.testDirect()).toBe("function:quiet:throws");
  });

  it("publishes the host binding through a package.json `imports` subpath", async () => {
    const exports = await compileFixture();
    expect(exports.testMapped()).toBe("function:quiet:throws");
  });

  it("publishes the host binding through a separate `import` + bare `export`", async () => {
    const exports = await compileFixture();
    expect(exports.testTwoStep()).toBe("function:quiet:throws");
  });
});
