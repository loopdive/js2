---
id: 7522
title: "IR post-mono verify: `sum$vec:v:f64?` clone writes slot 0 but has 0 slots (lodash-compile sum/mean)"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: []
---

# #7522: post-mono verifier failure on a monomorphised array parameter

## Problem

Measured by lane S25 on main `1a726b3e` (2026-11-26), default JS target:

```ts
function sum(arr: number[]): number {
  let total = 0;
  let i = 0;
  while (i < arr.length) { total = total + arr[i]; i = i + 1; }
  return total;
}
function mean(arr: number[]): number { return sum(arr) / arr.length; }
export function test(): number { return sum([1, 2, 3, 4, 5]); }
```

Compiling fails:

```
IR path failed for sum: synthetic artifact sum$vec:v:f64?: post-mono verify: slot.write slot index 0 out of bounds
(function has 0 slots) [verifier-failure]
```

The specialised clone keeps a body that writes a slot but drops the slot table. This is a compiler verifier failure,
not a refusal.

`tests/lodash-compile.test.ts` "lodash-compile: sum and mean" (2 tests) hits it. On main the whole file is hidden behind
a harness LinkError (class M, `plan/log/root-test-triage-2026-11-26.md`). With the harness fixed (patch below), the
file passes 36 of 38 and these 2 fail. Lead decision (2026-11-26): the harness fix lands with this bug's fix.

## Acceptance criteria

- The program above compiles and `test()` returns 15; `mean` likewise.
- With the patch below applied, `tests/lodash-compile.test.ts` passes 38/38.

## Harness patch to land with the fix (against main `1a726b3e`)

```diff
diff --git a/tests/lodash-compile.test.ts b/tests/lodash-compile.test.ts
index 30f0858eb..f90944f1e 100644
--- a/tests/lodash-compile.test.ts
+++ b/tests/lodash-compile.test.ts
@@ -1,35 +1,9 @@
 import { describe, it, expect } from "vitest";
-import { compile } from "../src/index.js";
-import { buildStringConstants } from "../src/runtime.js";
+import { compileToWasm } from "./equivalence/helpers.js";
 
 async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
-  const result = await compile(source);
-  if (!result.success) {
-    throw new Error(
-      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
-    );
-  }
-  const env: Record<string, Function> = {
-    console_log_number: () => {},
-    console_log_bool: () => {},
-    console_log_string: () => {},
-    number_toString: (v: number) => String(v),
-  };
-
-  const jsStringPolyfill = {
-    concat: (a: string, b: string) => a + b,
-    length: (s: string) => s.length,
-    equals: (a: string, b: string) => (a === b ? 1 : 0),
-    substring: (s: string, start: number, end: number) => s.substring(start, end),
-    charCodeAt: (s: string, i: number) => s.charCodeAt(i),
-  };
-
-  const { instance } = await WebAssembly.instantiate(result.binary, {
-    env,
-    "wasm:js-string": jsStringPolyfill,
-    string_constants: buildStringConstants(result.stringPool),
-  } as WebAssembly.Imports);
-  return (instance.exports as any)[fn](...args);
+  const exports = await compileToWasm(source);
+  return exports[fn]!(...args);
 }
 
 // =============================================================================
```
