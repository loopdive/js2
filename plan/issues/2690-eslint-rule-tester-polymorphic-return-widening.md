---
id: 2690
title: "ESLint rule-tester.js: cloneDeeplyExcludesParent polymorphic return widens i32 into anyref slot"
status: ready
created: 2026-06-26
updated: 2026-07-26
priority: low
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: allowjs-param-inference
goal: npm-library-support
sprint: current
model: fable
fable_role: spec
es_edition: ES5
related: [1573, 684, 1400]
disposition: "senior-dev/architect-lane — param-type MONOMORPHIZATION in JS/allowJs mode (not return-widening). Fix = param-widening in usage-inference (#684); central/fragile inference, high regression risk. Do NOT treat as a contained dev fallback. Re-scoped 2026-07-17 by dev-2961 with a minimal repro + root cause."
---
# ESLint rule-tester.js — cloneDeeplyExcludesParent polymorphic return widening

Carved from the de-staled #1573 ESLint survey. This is rule-tester.js's NEW
first-error after #1573 bug A (`inferLastType` branch-arm fix) unblocked the
prior `LazyLoadingRuleMap_new` blocker.

## Revalidated 2026-07-26

On current `origin/main` with ESLint 10.0.3, direct `rule-tester.js`
compilation still returns `success: true`, but constructing a
`WebAssembly.Module` fails:

```text
Compiling function #233:"cloneDeeplyExcludesParent" failed:
local.tee[0] expected type (ref null 2), found local.get of type i32
@+158758
```

This is **1 compile+invalid target out of the 6-target ESLint critical-path
sample** recorded in #1400. The refreshed result confirms the existing root
cause below; no duplicate issue is needed.

## Reproducer

```ts
import { compileProject } from "./src/index.js";
const r = await compileProject("/workspace/node_modules/eslint/lib/rule-tester/rule-tester.js", { allowJs: true });
expect(r.success).toBe(true); // passes
expect(WebAssembly.validate(r.binary)).toBe(true); // FAILS
```

## Error (current main, eslint 10.0.3, post-#1573-bug-A)

```
function #236 "cloneDeeplyExcludesParent":
  local.tee[0] expected type (ref null 2), found local.get of type i32
```

## Source

```js
function cloneDeeplyExcludesParent(x) {
  if (typeof x === "object" && x !== null) {
    if (Array.isArray(x)) return x.map(cloneDeeplyExcludesParent);
    const retv = {};
    for (const key in x) {
      if (key !== "parent" && hasOwnProperty(x, key)) retv[key] = cloneDeeplyExcludesParent(x[key]);
    }
    return retv;
  }
  return x;
}
```

## Root cause (CORRECTED 2026-07-17, dev-2961 — NOT return-widening)

The original hypothesis (unified _return_-slot widening) was **wrong**. The real
bug is **param-type MONOMORPHIZATION in JS/allowJs mode**, and it is confirmed
with a minimal, self-contained repro (no ESLint needed):

```ts
// FAILS WebAssembly.validate ONLY under allowJs (plain JS); the TS `x: any`
// form below validates fine — the trigger is JS-mode param inference.
compile(
  `function clone(x){
     if(typeof x==="object"&&x!==null){
       if(Array.isArray(x))return x.map(clone);
       const retv={}; for(const key in x){retv[key]=clone(x[key]);} return retv;
     }
     return x;
   }
   export function test(){return clone(5);}`,
  { target: "gc", allowJs: true, fileName: "t.js" },
);
// WebAssembly.compile(): Compiling function "clone" failed:
//   local.tee[0] expected type (ref null 2), found local.get of type f64
```

Contrast: the **same body with a TS `x: any` annotation validates fine**. So the
trigger is JS-mode param inference, not the control flow.

**Mechanism.** In JS/allowJs mode the param `x` is inferred as a **scalar
(`f64`)** from the `clone(5)` call site (numeric-argument monomorphization). But
the body uses `x` **polymorphically** — `Array.isArray(x)`, `x.map(clone)`,
`for (const key in x)`, `x[key]`, plus a scalar `return x`. In the WAT, the
`Array.isArray(x)` map branch emits `local.get 0` (the `f64` param) straight
into the `(ref null 2)` array-vec slot (`local.tee` of `$__arr_map_vec`), which
is a hard type error. Wasm validation is static, so even the (dynamically dead
for an `f64`) `x.map` branch must type-check — hence the validation failure, not
a runtime trap. The `i32` vs `f64` in the error text just depends on which
scalar the call-site inference picked (ESLint's real call graph → `i32`; the
`clone(5)` minimal → `f64`).

## Fix direction (CORRECTED)

Not the return-coercion path. The fix belongs in **param-type widening in
usage-inference** (`#684 UsageInference` / the JS-mode any-widening in
`src/checker/usage-inference.ts` + how `createCodegenContext` maps param types):
a param that is used in **ref-requiring** ways (`Array.isArray`, `.map`/array
methods, `for-in`, member/index access) must widen to `anyref`, overriding a
scalar call-site inference — and the scalar `return x` / arithmetic uses must
then box/coerce off that anyref param. This is **central, fragile inference
work** with a broad blast radius (it changes param ABIs), so it is
**senior-dev/architect-lane**, NOT a contained dev fallback. Recommend an
architect spec before implementation.

## Bug class

CODEGEN — **param-type monomorphization vs polymorphic body usage** (JS/allowJs
mode). Pure ES5.

## Permanent regression target

`tests/issue-2690.test.ts` must pin both the reduced `allowJs` polymorphic
parameter fixture and successful Wasm validation of the real ESLint
`rule-tester.js` entry before this issue moves to `done`.
