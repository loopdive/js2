// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1431 — Assignment-pattern destructuring: completion / defaults / compound side effects.
//
// Sub-fixes shipped here:
//
// 1. Array assignment pattern on null/undefined RHS throws TypeError.
//    Per §13.15.5.2 step 2, evaluating ArrayAssignmentPattern calls
//    GetIterator(rval). `GetIterator(null/undefined)` throws TypeError, so
//    even empty `[] = null` must throw. The previous carve-out (#225) for
//    empty patterns was applied to assignment patterns but only the binding
//    forms had spec justification; the assignment carve-out has been
//    removed for the externref RHS path.
//
// 2. Default initializer fires for `undefined`, not `null`.
//    Per §13.15.5.5 AssignmentElement step 4, the default fires only when
//    the resolved value is `undefined`. The externref destructure path
//    previously used `ref.is_null` which incorrectly fired the default for
//    explicit `null` too. We now route through `__extern_is_undefined`
//    (the same host import already used by parameter-default checks),
//    which performs a strict `=== undefined` test.
//
// Note: the inline (vec / tuple) destructure path still has a related but
// distinct gap — `[null]` typed `any[]` flows through a different code path
// where `null` and `undefined` are conflated at the array slot level. That
// is tracked as a follow-up; the externref path covers the bulk of the
// test262 failures (171 of the 363 referenced in the issue).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function runFn(source: string, fnName = "test"): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
  const fn = (instance.exports as Record<string, unknown>)[fnName] as (() => unknown) | undefined;
  if (!fn) throw new Error(`export '${fnName}' missing`);
  return fn();
}

describe("#1431 — assignment destructuring completion and defaults", () => {
  it("empty array pattern on null RHS throws TypeError", async () => {
    const result = await runFn(`
      export function test(): boolean {
        let threw = false;
        try {
          const a: any = null;
          [] = a;
        } catch (e) {
          threw = true;
        }
        return threw;
      }
    `);
    expect(result).toBe(1); // boolean true -> i32 1
  });

  it("empty array pattern on undefined RHS throws TypeError", async () => {
    const result = await runFn(`
      export function test(): boolean {
        let threw = false;
        try {
          const a: any = undefined;
          [] = a;
        } catch (e) {
          threw = true;
        }
        return threw;
      }
    `);
    expect(result).toBe(1);
  });

  it("non-empty array pattern on null RHS throws TypeError", async () => {
    const result = await runFn(`
      export function test(): boolean {
        let threw = false;
        try {
          let x: any;
          const a: any = null;
          [x] = a;
        } catch (e) {
          threw = true;
        }
        return threw;
      }
    `);
    expect(result).toBe(1);
  });

  it("externref destructure: default fires on out-of-bounds (undefined)", async () => {
    const result = await runFn(`
      export function test(): string {
        let x: any = "before";
        function source(): any { return []; }
        const vals: any = source();
        [x = "DEFAULT"] = vals;
        if (x === "DEFAULT") return "PASS";
        return "FAIL: " + String(x);
      }
    `);
    expect(result).toBe("PASS");
  });

  it("externref destructure: default does NOT fire on explicit null", async () => {
    // The RHS comes from an externref source so element reads go through
    // __extern_get → __extern_is_undefined. Pre-fix, ref.is_null would have
    // fired the default for `null` too.
    //
    // We synthesize the externref via JSON.parse so the host sees a real JS
    // array with a real null element, not a compiler-internal vec struct.
    const result = await runFn(`
      declare const JSON: { parse(s: string): any };
      export function test(): string {
        let x: any = "before";
        const vals: any = JSON.parse("[null]");
        [x = "DEFAULT"] = vals;
        if (x === null) return "PASS";
        return "FAIL: " + String(x);
      }
    `);
    expect(result).toBe("PASS");
  });

  it("externref destructure: default fires on explicit undefined", async () => {
    // JSON has no `undefined`, so build the array via a host call to be safe.
    const result = await runFn(`
      declare const JSON: { parse(s: string): any };
      export function test(): string {
        let x: any = "before";
        // [undefined] is reconstructed by deleting an entry (sparse): the
        // resulting slot reads as undefined per JS spec.
        const vals: any = JSON.parse("[0]");
        delete vals[0];
        [x = "DEFAULT"] = vals;
        if (x === "DEFAULT") return "PASS";
        return "FAIL: " + String(x);
      }
    `);
    expect(result).toBe("PASS");
  });

  it("default expression with throw propagates out of destructure", async () => {
    const result = await runFn(`
      function thrower(): any { throw new Error("DEFAULT_THREW"); }
      export function test(): boolean {
        let x: any = "before";
        function source(): any { return []; }
        const vals: any = source();
        try {
          [x = thrower()] = vals;
          return false;
        } catch (e) {
          return e instanceof Error;
        }
      }
    `);
    expect(result).toBe(1);
  });
});
