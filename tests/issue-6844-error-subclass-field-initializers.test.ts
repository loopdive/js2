// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6844 — instance field initializers of a class that extends a host builtin
// (`class ConfigError extends Error { name = "ConfigError"; }`) were silently
// dropped on the JS-host lane: the instance is the host object
// `__new_Error` returned, not a WasmGC struct, and the constructor's field loop
// skipped every externref-backed class (#1366a). `new ConfigError("x").name`
// read "Error".
//
// It surfaced as prettier's upstream unit suite dropping 108 → 75 on
// 2026-10-02. The bisect landed on #6798 (PR #6428), which made `typeof` of a
// class object the correct "function". The suite's `toThrow(C)` matcher is
// `typeof C === "function" ? error instanceof C || error.name === C.name : true`
// — before #6798 every `toThrow(InvalidDocError)` row fell through to `true`
// and passed without checking anything. #6798 exposed the field bug; it did not
// cause it.
//
// Every expectation below comes from running the same module source in native
// Node (`.tmp/native-6844.mjs`). Rows marked (was ✗) were wrong on the parent
// commit; the controls passed there and must keep passing.

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

const ENTRY = `import { run } from "./mod.js";\nexport function test(): string { return String((run as unknown as () => unknown)()); }`;

// Two untyped `.js` files, like prettier's `src/common/errors.js` imported by a
// test module.
const ERRORS = `
export class ConfigError extends Error { name = "ConfigError"; }
export class InvalidDocError extends Error {
  name = "InvalidDocError";
  constructor(doc) { super("bad doc " + typeof doc); this.doc = doc; }
}
export class Tagged extends Error { code = 7; label = "t" + "x"; }
export class Plain extends Error {}
`;

async function runCase(body: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "js2-6844-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "errors.js"), ERRORS);
  writeFileSync(
    join(root, "mod.js"),
    `import { ConfigError, InvalidDocError, Tagged, Plain } from "./errors.js";\n` +
      `function thrown(fn) { try { fn(); } catch (e) { return e; } return null; }\n` +
      `export function run() { ${body} }\n`,
  );
  writeFileSync(join(root, "entry.ts"), ENTRY);
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return String((instance.exports as Record<string, () => unknown>).test());
}

describe("#6844 externref-backed class field initializers", () => {
  it("defines a `name` field over the inherited Error.prototype.name (was ✗)", async () => {
    expect(await runCase(`const a = new ConfigError("foo"); return [a.name, a.message, String(a)].join("|");`)).toBe(
      "ConfigError|foo|ConfigError: foo",
    );
  });

  it("runs the field initializer after super() in an explicit constructor (was ✗)", async () => {
    expect(
      await runCase(
        `const b = thrown(() => { throw new InvalidDocError(1); });` +
          ` return [b.name, b.message, b.doc, b instanceof InvalidDocError, b instanceof Error].join("|");`,
      ),
    ).toBe("InvalidDocError|bad doc number|1|true|true");
  });

  it("defines non-`name` fields with computed initializers (was ✗)", async () => {
    expect(await runCase(`const c = new Tagged("m"); return [c.code, c.label, c.name, c.message].join("|");`)).toBe(
      "7|tx|Error|m",
    );
  });

  it("the prettier upstream matcher identifies the thrown subclass by name (was ✗)", async () => {
    expect(
      await runCase(
        // The suite's own test: `error.name === expected.name`, with the class
        // held in a variable as the matcher receives it.
        `const C = InvalidDocError; const e = thrown(() => { throw new C({ type: "x" }); });` +
          ` return String(e.name === C.name) + "|" + C.name;`,
      ),
    ).toBe("true|InvalidDocError");
  });

  // Anti-vacuity controls: these passed on the parent and must keep passing —
  // a subclass with no fields keeps the inherited name, and an explicit
  // constructor assignment still wins.
  it("control: a field-less Error subclass keeps the inherited name", async () => {
    expect(await runCase(`const p = new Plain("p"); return [p.name, p.message].join("|");`)).toBe("Error|p");
  });
});
