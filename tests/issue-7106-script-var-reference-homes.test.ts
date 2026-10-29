// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 (script `var` reference homes) — a script `var` initialised with an
// array literal of numbers lives in a `(ref null $__vec_f64)` slot. The module
// binding resolver refused it (`vardecl-module-storage-unrepresentable`), so
// the harness-claimed `<module-init>` of every such test stayed legacy. It now
// binds as the `f64-vec` kind, the `vec<f64>` an array literal of numbers
// lowers to. Every other reference-shaped slot, and every consumer or write the
// IR has no vector lowering for, still refuses at selection.
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import {
  assembleHarnessBody,
  compileHarnessBody,
  moduleInit,
  runModuleInit,
  type HarnessCompileResult,
} from "./helpers/harness-module-init.js";

function nodeThrows(body: string): boolean {
  try {
    runInNewContext(assembleHarnessBody(body));
    return false;
  } catch {
    return true;
  }
}

async function moduleInitThrows(result: HarnessCompileResult): Promise<boolean> {
  try {
    await runModuleInit(result);
    return false;
  } catch (error) {
    if (!(error instanceof WebAssembly.Exception)) throw error;
    return true;
  }
}

describe("#7106 — a number-array script var binds as the f64-vec module binding", () => {
  const admitted: Record<string, string> = {
    "push and indexed reads": `var arr = [1, 2, 3];
arr.push(4);
assert.sameValue(arr.length, 4);
assert.sameValue(arr[3], 4);
assert.sameValue(arr.indexOf(2), 1);`,
    "a literal rewrite and an element store": `var arr = [0.5, -2];
arr = [7, 8, 9];
arr[0] = 6;
assert.sameValue(arr.length, 3);
assert.sameValue(arr[0], 6);`,
    "a read from a function unit": `var arr = [5, 6];
function first() { return arr[0]; }
assert.sameValue(first(), 5);`,
    "a failing check": `var arr = [1, 2];
assert.sameValue(arr.length, 3);`,
  };

  for (const [name, body] of Object.entries(admitted)) {
    it(`claims <module-init> and agrees with node: ${name} (standalone)`, async () => {
      const result = await compileHarnessBody(body);
      expect(moduleInit(result)?.irBodyEmitted).toBe(true);
      expect(await moduleInitThrows(result)).toBe(nodeThrows(body));
    }, 60_000);
  }

  const refused: Record<string, string> = {
    // Slots that are not the number vector keep their own (absent) value kind.
    "a string array": `var arr = ["a"];
assert.sameValue(arr.length, 1);`,
    "a constructor array": `var arr = [Float64Array];
assert.sameValue(arr.length, 1);`,
    "a Map": `var m = new Map();
assert.sameValue(m.size, 0);`,
    "a plain object": `var o = { x: 1 };
assert.sameValue(o.x, 1);`,
    // Writes the vector slot cannot take exactly.
    "a computed write": `var arr = [1];
arr = arr.concat([2]);
assert.sameValue(arr.length, 2);`,
    "a hole": `var arr = [1, , 3];
assert.sameValue(arr.length, 3);`,
    // Consumers with no vector lowering.
    "a length write": `var arr = [1, 2];
arr.length = 1;
assert.sameValue(arr.length, 1);`,
    "an undefined comparison": `var arr = [1];
assert.sameValue(arr === undefined, false);`,
    "a unary plus": `var arr = [1];
assert.sameValue(+arr, 1);`,
    // es5id 15.4.5.1-5-2: the f64 element store lowers only a proven number.
    "a string element store": `var arr = [0, 1, 2];
arr[4294967295] = "not an array element";
assert.sameValue(arr.length, 3);`,
  };

  for (const [name, body] of Object.entries(refused)) {
    it(`refuses <module-init> at selection: ${name} (standalone)`, async () => {
      const result = await compileHarnessBody(body);
      expect(moduleInit(result)).toMatchObject({ kind: "unsupported", stage: "select" });
      await runModuleInit(result);
    }, 60_000);
  }

  it("refuses a function that writes the vector's length at selection (standalone)", async () => {
    const result = await compileHarnessBody(`var arr = [1, 2];
function truncate() { arr.length = 0; }
truncate();
assert.sameValue(arr.length, 0);`);
    const truncate = (result.irOutcomes ?? []).find((outcome) => outcome.displayName === "truncate");
    expect(truncate).toMatchObject({ kind: "unsupported", stage: "select", code: "array-method-unsupported" });
    await runModuleInit(result);
  }, 60_000);

  it("keeps the JS-host lane's vector slot legacy-owned (gc)", async () => {
    const result = await compile(`var arr = [1, 2, 3]; arr.push(4);`, {
      fileName: "test.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(moduleInit(result)).toMatchObject({ kind: "unsupported", stage: "select" });
  }, 60_000);
});
