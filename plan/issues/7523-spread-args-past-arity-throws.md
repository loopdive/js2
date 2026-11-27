---
id: 7523
title: "Spread call arguments beyond the arity, `(function (a, b) {…})(1, 2, ...[3, 4, 5])`, throw an uncaught WebAssembly.Exception"
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
related: [6583]
---

# #7523: spread arguments past the arity throw

**Owner: Session B** (spread / iteration area). Routing is posted on #6583.

## Problem

Measured by lane S25 on main `1a726b3e` (2026-11-26), default JS target. Same result through the test harness and
through the real embedder path (`compileAndInstantiate` in `src/runtime.ts`):

```ts
let result = 0;
(function (a: number, b: number) { result = a + b; })(1, 2, ...[3, 4, 5]);
export function main() { return result; }
```

Running it throws an uncaught `WebAssembly.Exception`. JS evaluates the spread, binds `a = 1, b = 2`, ignores the extra
arguments, and sets `result = 3`.

`tests/null-dereference-guards.test.ts` "should handle spread with extra args in IIFE (evaluated and dropped)" hits
it. On main the file fails earlier on a harness LinkError (class M, `plan/log/root-test-triage-2026-11-26.md`), so
when this broke is unknown. With the harness fixed (patch below), the file passes 2 of 3 and this case fails. Lead
decision (2026-11-26): the harness fix lands with this bug's fix.

## Acceptance criteria

- The program above runs and leaves `result === 3`; the spread is still evaluated.
- With the patch below applied, `tests/null-dereference-guards.test.ts` passes 3/3.

## Harness patch to land with the fix (against main `1a726b3e`)

```diff
diff --git a/tests/null-dereference-guards.test.ts b/tests/null-dereference-guards.test.ts
index 86abda7e7..3fae1a5cc 100644
--- a/tests/null-dereference-guards.test.ts
+++ b/tests/null-dereference-guards.test.ts
@@ -1,17 +1,10 @@
 import { describe, it, expect } from "vitest";
 import { compile } from "../src/index.js";
+import { compileToWasm } from "./equivalence/helpers.js";
 
 async function run(source: string): Promise<unknown> {
-  const result = await compile(source);
-  if (!result.success) {
-    throw new Error(
-      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
-    );
-  }
-  const { instance } = await WebAssembly.instantiate(result.binary, {
-    env: { console_log_number: () => {}, console_log_bool: () => {}, console_log_string: () => {} },
-  });
-  return (instance.exports as any).main();
+  const exports = await compileToWasm(source);
+  return exports.main!();
 }
 
 describe("SpreadElement in IIFE and expression positions", () => {
```
