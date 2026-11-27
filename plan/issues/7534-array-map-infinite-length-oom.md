---
id: 7534
title: "Array.prototype.map on `{ length: \"Infinity\" }` exhausts the heap instead of throwing a catchable RangeError"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
owner: session-B
related: [1022, 6583]
---

# #7534: `map` with `length: "Infinity"` runs out of memory

**Owner: Session B** (arrays). Routing is posted on #6583.

## Problem

Measured by lane S25 on main `1a726b3e` (2026-11-26), default JS target. test262
`built-ins/Array/prototype/map/15.4.4.19-3-14.js` calls `Array.prototype.map` on `{ 0: 9, length: "Infinity" }`
and expects a `RangeError` from ArraySpeciesCreate / ArrayCreate (ECMA-262 §10.4.2.2: a length above 2³² − 1
throws `RangeError`).

- In the vitest worker it dies with `FATAL ERROR: Reached heap limit`.
- With a 2 GB heap it throws `requested new array is too large`, which the test's RangeError check cannot catch.
- The standalone baseline (`test262-standalone-current.jsonl`, 2026-11-26) records it as pass. The frozen JS-host
  baseline recorded `compile_timeout`. So it is not a new regression on the JS target, but it is wrong.

`tests/test-1022-regression.test.ts` "map timeout" hits it. On main the whole file fails earlier on a hardcoded
`/workspace/test262` path (class E, `plan/log/root-test-triage-2026-11-26.md`). With the path fixed (patch below), 12 of
13 cases pass and this one fails. The path fix lands with this bug's fix.

## Acceptance criteria

- The test262 file passes on the default target: a catchable `RangeError`, no heap growth to the length.
- With the patch below applied, `tests/test-1022-regression.test.ts` passes 13/13.

## Harness patch to land with the fix (against main `1a726b3e`)

```diff
diff --git a/tests/test-1022-regression.test.ts b/tests/test-1022-regression.test.ts
--- a/tests/test-1022-regression.test.ts
+++ b/tests/test-1022-regression.test.ts
@@ -7,9 +7,10 @@ import { compile } from "../src/index.js";
 import { buildImports } from "../src/runtime.js";
 import { parseMeta, wrapTest } from "../tests/test262-runner.js";
 import { readFileSync } from "fs";
+import { resolve } from "path";
 
 async function runTest262(file: string): Promise<string> {
-  const src = readFileSync(file, "utf-8");
+  const src = readFileSync(resolve(__dirname, "..", file), "utf-8");
   const meta = parseMeta(src);
   const { source: w } = wrapTest(src, meta);
   try {
@@ -32,72 +33,72 @@ async function runTest262(file: string): Promise<string> {
 describe("Regression fixes for PR #68 regressions (#1022)", () => {
   // Fix A: map/filter/reduce removed from ARRAY_LIKE_METHOD_SET
   it("map timeout: map with length=Infinity falls back to __proto_method_call (Fix A)", async () => {
-    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/map/15.4.4.19-3-14.js");
+    const r = await runTest262("test262/test/built-ins/Array/prototype/map/15.4.4.19-3-14.js");
     expect(r).toBe("PASS");
   });
 
   it("filter getter: filter falls back to __proto_method_call (Fix A)", async () => {
-    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/filter/15.4.4.20-9-c-i-30.js");
+    const r = await runTest262("test262/test/built-ins/Array/prototype/filter/15.4.4.20-9-c-i-30.js");
     expect(r).toBe("PASS");
   });
 
   it("filter call-with-boolean: filter falls back (Fix A)", async () => {
-    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/filter/call-with-boolean.js");
+    const r = await runTest262("test262/test/built-ins/Array/prototype/filter/call-with-boolean.js");
     expect(r).toBe("PASS");
   });
 
   it("map call-with-boolean: map falls back (Fix A)", async () => {
-    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/map/call-with-boolean.js");
+    const r = await runTest262("test262/test/built-ins/Array/prototype/map/call-with-boolean.js");
     expect(r).toBe("PASS");
   });
 
   it("reduce call-with-boolean: reduce falls back (Fix A)", async () => {
-    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/reduce/call-with-boolean.js");
+    const r = await runTest262("test262/test/built-ins/Array/prototype/reduce/call-with-boolean.js");
     expect(r).toBe("PASS");
   });
 
   it("reduce length-getter throws: reduce falls back (Fix A)", async () => {
-    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/reduce/15.4.4.21-5-12.js");
+    const r = await runTest262("test262/test/built-ins/Array/prototype/reduce/15.4.4.21-5-12.js");
     expect(r).toBe("PASS");
   });
 
   // Fix B + D: void callback (0 params, no return) — every/some/findIndex call-with-boolean
   it("every call-with-boolean: void arrow () => {} on boolean receiver (Fix B+D)", async () => {
-    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/every/call-with-boolean.js");
+    const r = await runTest262("test262/test/built-ins/Array/prototype/every/call-with-boolean.js");
     expect(r).toBe("PASS");
   });
 
   it("some call-with-boolean: void arrow () => {} on boolean receiver (Fix B+D)", async () => {
-    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/some/call-with-boolean.js");
+    const r = await runTest262("test262/test/built-ins/Array/prototype/some/call-with-boolean.js");
     expect(r).toBe("PASS");
   });
 
   it("findIndex call-with-boolean: void arrow () => {} on boolean receiver (Fix B+D)", async () => {
-    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/findIndex/call-with-boolean.js");
+    const r = await runTest262("test262/test/built-ins/Array/prototype/findIndex/call-with-boolean.js");
     expect(r).toBe("PASS");
   });
 
   // Fix C: null/undefined receiver → fall back to __proto_method_call
   it("find return-abrupt-from-this: null receiver throws TypeError (Fix C)", async () => {
-    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/find/return-abrupt-from-this.js");
+    const r = await runTest262("test262/test/built-ins/Array/prototype/find/return-abrupt-from-this.js");
     expect(r).toBe("PASS");
   });
 
   it("findIndex return-abrupt-from-this: null receiver throws TypeError (Fix C)", async () => {
     const r = await runTest262(
-      "/workspace/test262/test/built-ins/Array/prototype/findIndex/return-abrupt-from-this.js",
+      "test262/test/built-ins/Array/prototype/findIndex/return-abrupt-from-this.js",
     );
     expect(r).toBe("PASS");
   });
 
   // Previously passing tests should still pass
   it("every.call with 3-param callback (regression guard)", async () => {
-    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/every/15.4.4.16-3-24.js");
+    const r = await runTest262("test262/test/built-ins/Array/prototype/every/15.4.4.16-3-24.js");
     expect(r).toBe("PASS");
   });
 
   it("every.call with 3-param named function (regression guard)", async () => {
-    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/every/15.4.4.16-3-1.js");
+    const r = await runTest262("test262/test/built-ins/Array/prototype/every/15.4.4.16-3-1.js");
     expect(r).toBe("PASS");
   });
 });
```
