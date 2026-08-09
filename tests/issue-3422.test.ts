// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3422) Strict-mode rerun: `delete` of a non-configurable property must throw
// a **real** TypeError instance, not a bare string.
//
// test262's authentic harness (#3370) runs each test a second time with
// `"use strict";` prepended. Under strict mode `propertyHelper.js::isConfigurable()`
// probes a non-configurable property's refusal with
//
//     try { delete obj[name]; } catch (e) {
//       if (!(e instanceof TypeError)) throw new Test262Error("Expected TypeError, got " + e);
//     }
//
// Before this fix the compiler threw the strict-mode refusal as a BARE STRING
// ("TypeError: Cannot delete non-configurable property in strict mode") on the
// shared exception tag. A string is not `instanceof TypeError`, so the guard
// tripped and ~313 strict-rerun cases failed with
// "Expected TypeError, got TypeError: Cannot delete non-configurable property in
// strict mode" (the string carried its own "TypeError:" prefix, which is why the
// `+ e` text looked like a TypeError yet `instanceof` still returned false).
//
// The read-only-assignment sibling family (isWritable's `obj[name] = v` refusal)
// was already fixed to throw a real instance (#3471); this is the `delete`
// counterpart. The fix routes typeof-delete.ts's delete-refusal throws through
// `buildThrowJsErrorInstrs` (host `__new_TypeError` / standalone in-module
// constructor), so `e instanceof TypeError` is true in both lanes.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

// A strict-mode delete of a non-configurable own property, caught in a
// Wasm-level try/catch that returns 1 when the caught value is `instanceof
// <Ctor>` and 2 when it is caught but NOT an instance (the pre-fix bug).
const INSTANCEOF_PROBE = `
"use strict";
export function test(): number {
  const o: any = {};
  Object.defineProperty(o, "p", { value: 1, configurable: false });
  try { delete o.p; return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; }
}
`;

async function runInstanceofProbe(target?: "standalone"): Promise<number> {
  const result = await compile(INSTANCEOF_PROBE, target ? { target } : undefined);
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const imports = target
    ? {}
    : (buildImports(result.imports, undefined, result.stringPool) as unknown as WebAssembly.Imports);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as { test: () => number }).test();
}

describe("#3422 strict-mode delete of a non-configurable property throws a real TypeError", () => {
  it("host lane: the caught value is `instanceof TypeError` (not a bare string)", async () => {
    expect(await runInstanceofProbe()).toBe(1);
  });

  it("standalone lane: the in-module TypeError constructor also satisfies `instanceof`", async () => {
    expect(await runInstanceofProbe("standalone")).toBe(1);
  });

  // End-to-end: real test262 files from the pre-fix 313-failure cluster now
  // reach a full `pass` (primary + strict rerun) through the authentic honest
  // harness — the same `assembleOriginalHarness` assembly CI's oracle uses.
  // This locks in the NEXT-layer guard: `isConfigurable()` returns
  // `!__hasOwnProperty(obj, name)` after the caught delete, and any later
  // `verifyProperty` assertion must also hold (cf. #3470 → #3471, where fixing
  // one probe unblocked a deeper bug in the next).
  const CITED_TESTS = [
    "built-ins/Object/defineProperty/15.2.3.6-3-85.js",
    "built-ins/Object/defineProperties/15.2.3.7-6-a-72.js",
    "built-ins/Symbol/toPrimitive/prop-desc.js",
    "built-ins/Math/PI/prop-desc.js",
    "built-ins/Number/MAX_SAFE_INTEGER.js",
  ] as const;

  for (const rel of CITED_TESTS) {
    it(`test262 ${rel} passes primary + strict rerun`, async () => {
      const res = await runTest262File(resolve("test262/test", rel), rel.split("/")[0]!);
      restoreHostBuiltins();
      expect(res.status, `${rel}: ${res.error ?? ""}`).toBe("pass");
    }, 60_000);
  }
});
