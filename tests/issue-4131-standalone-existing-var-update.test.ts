// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4131 — Annex B B.3.3.1 step 3.f must update an existing `var` binding with
// the function object produced by a sloppy block-level function declaration.
// These are the five `if` statement forms covered by the ES5 generated
// `*-func-existing-var-update.js` rows. Keep the numeric initializer after the
// observation: numeric usage admission must not re-narrow the hidden function
// assignment to an f64 carrier.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const cases = [
  {
    name: "if-decl-else-decl-a",
    statement: "if (true) function f() { return 17; } else function _f() {}",
  },
  {
    name: "if-decl-else-decl-b",
    statement: "if (false) function _f() {} else function f() { return 17; }",
  },
  {
    name: "if-decl-else-stmt",
    statement: "if (true) function f() { return 17; } else ;",
  },
  {
    name: "if-decl-no-else",
    statement: "if (true) function f() { return 17; }",
  },
  {
    name: "if-stmt-else-decl",
    statement: "if (false) ; else function f() { return 17; }",
  },
] as const;

async function runStandalone(statement: string): Promise<number> {
  const source = `
    export function test() {
      var after;
      (function() {
        ${statement}
        after = f;
        var f = 123;
      }());
      return typeof after === "function" && after() === 17 ? 1 : 0;
    }
  `;
  const result = await compile(source, {
    allowJs: true,
    fileName: "/issue-4131-standalone-existing-var-update.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#4131 Annex B existing-var updates in standalone if forms", () => {
  for (const { name, statement } of cases) {
    it(`${name} writes the function object into the existing var`, async () => {
      await expect(runStandalone(statement)).resolves.toBe(1);
    });
  }
});
