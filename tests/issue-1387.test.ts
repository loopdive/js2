// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ISSUE_1387 = /#1387: with statement requires a proven closed object-literal shape/;

async function compileSloppy(source: string) {
  return compile(source, {
    allowJs: true,
    fileName: "issue-1387.js",
    skipSemanticDiagnostics: true,
  });
}

async function run(source: string): Promise<unknown> {
  const result = await compileSloppy(source);
  const errorMessages = result.errors.filter((e) => e.severity !== "warning").map((e) => `  L${e.line}: ${e.message}`);
  expect(
    result.success && errorMessages.length === 0,
    `Compile failed:\n${errorMessages.join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as { run: () => unknown }).run();
}

describe("#1387 with statement static literal lowering", () => {
  it("routes own-property reads and lexical fallthroughs in a closed literal scope", async () => {
    expect(
      await run(`
        module.exports.run = function () {
          var outside = 7;
          var total = 0;
          with ({ a: 3, b: 4 }) {
            total = a + b + outside;
          }
          return total;
        };
      `),
    ).toBe(14);
  });

  it("writes bare identifiers back to the proven with object field", async () => {
    expect(
      await run(`
        module.exports.run = function () {
          var result = 0;
          with ({ a: 1 }) {
            a = a + 9;
            result = a;
          }
          return result;
        };
      `),
    ).toBe(10);
  });

  it("routes Object.freeze literal heads as closed read-only scopes", async () => {
    expect(
      await run(`
        module.exports.run = function () {
          var outside = 5;
          var result = 0;
          with (Object.freeze({ a: 11, b: 13 })) {
            result = a + b + outside;
          }
          return result;
        };
      `),
    ).toBe(29);
  });

  it("routes Object.seal literal heads as closed writable scopes", async () => {
    expect(
      await run(`
        module.exports.run = function () {
          var result = 0;
          with (Object.seal({ a: 2 })) {
            a = a + 6;
            result = a;
          }
          return result;
        };
      `),
    ).toBe(8);
  });

  // (#7032) This and the opaque-target case below used to pin the static
  // lowering's REFUSAL diagnostics ("field is immutable" / "requires a proven
  // closed object-literal shape"). Measured on upstream/main 0727e2985b, those
  // refusals are no longer reached: the dynamic `with` lowering (#2663) claims
  // both shapes and runs them with the correct sloppy-mode semantics, so the
  // tests assert that behaviour (node prints the same 1 and 9) instead.
  it("a write through a frozen with-object binding is a silent sloppy no-op", async () => {
    expect(
      await run(`
        module.exports.run = function () {
          var o = Object.freeze({ a: 1 });
          with (o) {
            a = 2;
          }
          return o.a;
        };
      `),
    ).toBe(1);
  });

  it("resolves nested literal with scopes innermost first", async () => {
    expect(
      await run(`
        module.exports.run = function () {
          var result = 0;
          with ({ a: 1, b: 10 }) {
            with ({ a: 2 }) {
              result = a + b;
            }
          }
          return result;
        };
      `),
    ).toBe(12);
  });

  it("keeps declarations inside the body lexical instead of rewriting them", async () => {
    expect(
      await run(`
        module.exports.run = function () {
          var result = 0;
          with ({ a: 1 }) {
            let a = 5;
            result = a;
          }
          return result;
        };
      `),
    ).toBe(5);
  });

  it("resolves names through an opaque (non-literal) with target", async () => {
    expect(
      await run(`
        module.exports.run = function () {
          var obj = JSON.parse('{"value": 9}');
          var result = 0;
          with (obj) {
            result = value;
          }
          return result;
        };
      `),
    ).toBe(9);
  });

  it("refuses inherited Object.prototype names that are not own fields", async () => {
    const result = await compileSloppy(`
      module.exports.run = function () {
        var result = 0;
        with ({ a: 1 }) {
          result = toString;
        }
        return result;
      };
    `);

    const msg = result.errors.map((e) => e.message).join("\n");
    expect(msg).toMatch(ISSUE_1387);
    expect(msg).toContain('inherited Object.prototype key "toString"');
  });
});
