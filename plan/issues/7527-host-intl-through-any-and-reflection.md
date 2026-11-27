---
id: 7527
title: "Host Intl through `any` and reflection: methods on an `any` Intl object, `Intl.X` as a value, `Reflect.construct(Intl.X)`"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: low
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [6978, 6986, 5355, 5381, 7516, 7528]
---

# #7527: host Intl reached through `any` or reflection

A follow-up to #6986. The `intl` host accelerator is opt-in in the JS environment (`hostAccelerators: ["intl"]`, #6978),
so priority is low.

## Problem

Measured by lane S25 on main `1a726b3e` (2026-11-26). Default JS target, compiled with `hostAccelerators: ["intl"]` and
bound with `buildCompiledImports(result)`:

1. **Methods on an `any` receiver.** `const f: any = new Intl.DateTimeFormat(...); f.formatToParts(0).length` gives 0.
   Affects `tests/issue-5355-intl-datetimeformat-bridge.test.ts` "works across a module boundary (linked lane)":
   `expected 'false|1/1/1970|0' to be 'false|1/1/1970|5'`. A single-module probe fails the same way, so linking is
   not the cause.
2. **A dynamic `Intl` member as a value.** `typeof (Intl as any).PluralRules` is `"object"`, and calling it throws
   `TypeError: called value is not a function` (from `_nativeErrorToHost`). The module imports `global_Intl` but has
   no boundary get for the member. Affects `tests/issue-5381-intl-options-bag.test.ts`, PluralRules and
   RelativeTimeFormat, single-module and cross-module (4 tests).
3. **`Reflect.construct(Intl.DateTimeFormat | Intl.NumberFormat, …)`.** No `Intl_*` import is emitted; the result is
   `undefined`. Affects 5381, 2 tests: `expected null to be '1/1/1970'` and `expected null to be '1.500'`.

Items 2 and 3 are on #6986's own "Left out (follow-ups)" list. These tests passed under the host-assisted mode that
#6979 removed.

Other failures in the same two files that belong elsewhere:
- a `Request` init dictionary is not converted: #7516;
- `e.cause === obj` is false: #7528.

## Acceptance criteria

- Items 1–3 behave as in JS with the `intl` accelerator selected.
- With the patch below applied, `tests/issue-5355-intl-datetimeformat-bridge.test.ts` passes in full (it is 9/1 with
  the patch, 2/8 on main). `tests/issue-5381-intl-options-bag.test.ts` (12/9 with the patch, 0/21 on main) passes once
  #7516's `Request` case and #7528 are fixed too.

## Harness patch (acceptance test, against main `1a726b3e`)

Compiles with `hostAccelerators: ["intl"]`, binds with `buildCompiledImports`, and reads results through
`jsFacingExports`. Lane S25 committed the same fix for `tests/issue-1070.test.ts` in #7486.

```diff
diff --git a/tests/issue-5355-intl-datetimeformat-bridge.test.ts b/tests/issue-5355-intl-datetimeformat-bridge.test.ts
index 645a6f43a..352d8dfb0 100644
--- a/tests/issue-5355-intl-datetimeformat-bridge.test.ts
+++ b/tests/issue-5355-intl-datetimeformat-bridge.test.ts
@@ -47,16 +47,22 @@
 
 import { describe, expect, it } from "vitest";
 import { compile, compileMulti } from "../src/index.js";
-import { buildImports } from "../src/runtime.js";
+import { buildCompiledImports } from "../src/runtime.js";
+import { jsFacingExports } from "./helpers/compile.js";
+
+// (#6986) Intl has no native implementation on the native semantic regime: the
+// JS-environment lanes below select the `intl` host accelerator
+// (`--host-accelerator intl`) and bind through the embedder API, which admits it.
+const INTL = { hostAccelerators: ["intl"] } as const;
 
 /** Single-module JS-host lane. */
 async function run(source: string): Promise<unknown> {
-  const result = await compile(source, { fileName: "issue-5355.ts" });
+  const result = await compile(source, { fileName: "issue-5355.ts", ...INTL });
   expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
-  const imports = buildImports(result.imports, undefined, result.stringPool);
+  const imports = buildCompiledImports(result);
   const { instance } = await WebAssembly.instantiate(result.binary, imports);
   imports.setInstance?.(instance);
-  return (instance.exports as Record<string, () => unknown>).test!();
+  return (jsFacingExports(result, instance) as Record<string, () => unknown>).test!();
 }
 
 /**
@@ -71,12 +77,12 @@ async function runLinked(source: string): Promise<unknown> {
      }`,
     "./entry.ts": source,
   };
-  const result = await compileMulti(files, "./entry.ts", { skipSemanticDiagnostics: true });
+  const result = await compileMulti(files, "./entry.ts", { skipSemanticDiagnostics: true, ...INTL });
   expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
-  const imports = buildImports(result.imports, undefined, result.stringPool);
+  const imports = buildCompiledImports(result);
   const { instance } = await WebAssembly.instantiate(result.binary, imports);
   imports.setInstance?.(instance);
-  return (instance.exports as Record<string, () => unknown>).test!();
+  return (jsFacingExports(result, instance) as Record<string, () => unknown>).test!();
 }
 
 describe("#5355 — Intl.DateTimeFormat host-mirror bridge", () => {
@@ -155,7 +161,7 @@ describe("#5355 — Intl.DateTimeFormat host-mirror bridge", () => {
       `export function test(): string {
          return String(new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(0));
        }`,
-      { fileName: "issue-5355-imports.ts" },
+      { fileName: "issue-5355-imports.ts", ...INTL },
     );
     expect(result.success).toBe(true);
     const names = result.imports.map((entry) => entry.name);
diff --git a/tests/issue-5381-intl-options-bag.test.ts b/tests/issue-5381-intl-options-bag.test.ts
index e3bd42485..f2732278d 100644
--- a/tests/issue-5381-intl-options-bag.test.ts
+++ b/tests/issue-5381-intl-options-bag.test.ts
@@ -55,16 +55,22 @@
 
 import { describe, expect, it } from "vitest";
 import { compile, compileMulti } from "../src/index.js";
-import { buildImports } from "../src/runtime.js";
+import { buildCompiledImports } from "../src/runtime.js";
+import { jsFacingExports } from "./helpers/compile.js";
+
+// (#6986) Intl has no native implementation on the native semantic regime: the
+// JS-environment lanes below select the `intl` host accelerator
+// (`--host-accelerator intl`) and bind through the embedder API, which admits it.
+const INTL = { hostAccelerators: ["intl"] } as const;
 
 /** Consumer-only lane: one module, JS host. */
 async function run(source: string): Promise<unknown> {
-  const result = await compile(source, { fileName: "issue-5381.ts", skipSemanticDiagnostics: true });
+  const result = await compile(source, { fileName: "issue-5381.ts", skipSemanticDiagnostics: true, ...INTL });
   expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
-  const imports = buildImports(result.imports, undefined, result.stringPool);
+  const imports = buildCompiledImports(result);
   const { instance } = await WebAssembly.instantiate(result.binary, imports);
   imports.setInstance?.(instance);
-  return (instance.exports as Record<string, () => unknown>).test!();
+  return (jsFacingExports(result, instance) as Record<string, () => unknown>).test!();
 }
 
 /**
@@ -80,12 +86,12 @@ async function runLinked(providerBody: string, consumerBody: string): Promise<un
     "./entry.ts": `import { makeBag } from "./bag.js";
        export function test(): string { ${consumerBody} }`,
   };
-  const result = await compileMulti(files, "./entry.ts", { skipSemanticDiagnostics: true });
+  const result = await compileMulti(files, "./entry.ts", { skipSemanticDiagnostics: true, ...INTL });
   expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
-  const imports = buildImports(result.imports, undefined, result.stringPool);
+  const imports = buildCompiledImports(result);
   const { instance } = await WebAssembly.instantiate(result.binary, imports);
   imports.setInstance?.(instance);
-  return (instance.exports as Record<string, () => unknown>).test!();
+  return (jsFacingExports(result, instance) as Record<string, () => unknown>).test!();
 }
 
 describe("#5381 — extern-class constructors marshal their options bag", () => {
```
