// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 (script `var` reference homes) — codegen's `scriptVarHome` classifier
// names a script `var`'s sole-home slot `dynamic`, `string` or `typed`, and
// answers `undefined` for every other carrier. A var whose legacy slot holds a
// reference with no matching value kind — the `$__vec_f64` of `[1, 2, 3]`, a
// constructor or string array, `$Map`, an object struct — keeps the harness
// `<module-init>` on legacy: refused at selection, never claimed and demoted.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileHarnessBody, moduleInit, runModuleInit } from "./helpers/harness-module-init.js";

describe("#7106 — a script var in a reference-carrier slot stays legacy", () => {
  const shapes: Record<string, string> = {
    "a number array": `var arr = [1, 2, 3];
arr.push(4);
assert.sameValue(arr.length, 4);
assert.sameValue(arr, arr);`,
    "a string array": `var arr = ["a"];
assert.sameValue(arr.length, 1);`,
    "a constructor array": `var arr = [Float64Array];
assert.sameValue(arr.length, 1);`,
    "a Map": `var m = new Map();
assert.sameValue(m.size, 0);`,
    "a plain object": `var o = { x: 1 };
assert.sameValue(o.x, 1);`,
  };

  for (const [name, body] of Object.entries(shapes)) {
    it(`refuses <module-init> at selection: ${name} (standalone)`, async () => {
      const result = await compileHarnessBody(body);
      expect(moduleInit(result)).toMatchObject({ kind: "unsupported", stage: "select" });
      await runModuleInit(result);
    }, 60_000);
  }

  it("refuses a number-array script var at selection (gc)", async () => {
    const result = await compile(`var arr = [1, 2, 3]; arr.push(4);`, {
      fileName: "test.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(moduleInit(result)).toMatchObject({ kind: "unsupported", stage: "select" });
  }, 60_000);

  // `writeValueMatches` reads the home through the guarded `scriptVarHomeOf`:
  // a script `let` is not a script-var home, so an object written to it from
  // a function refuses that function at selection instead of claiming it.
  it("refuses a function writing an object to a script `let` at selection (standalone)", async () => {
    const result = await compile(`let o; function f() { o = { a: 1 }; return 1; } f();`, {
      fileName: "test.js",
      allowJs: true,
      target: "standalone",
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    const f = (result.irOutcomes ?? []).find((outcome) => outcome.displayName === "f");
    expect(f).toMatchObject({ irBodyEmitted: false, stage: "select" });
  }, 60_000);
});
