---
id: 4191
title: "SUPERSEDED by #4163 — test262 in-process runner did not link js2wasm:runtime-eval (kept for the measurement)"
status: wont-fix
created: 2026-08-06
updated: 2026-08-06
priority: high
task_type: bug
area: conformance, tooling
goal: es5
sprint: current
horizon: s
superseded_by: 4163
related: [4163, 2928, 4192, 2875]
---

# #4191 — superseded by #4163; kept only for the measurement

**Do not implement this.** PR **#4163** fixes the same defect properly: a shared
`scripts/test262-import-object.mjs` seam across **all five** instantiate sites
(worker, shared fixture lane, in-process runner, …), normalisation of
`WebAssembly.instantiate`'s two return shapes, and a **structural** guard that
asserts no lane calls `WebAssembly.instantiate` on a test binary itself. It also
carries a second vacuity fix #4191 did not find (`handleNegativeTest` built
compile options from an unbound `target`, and the `ReferenceError` landed in the
`try` whose `catch` returns `pass` — so every parse/early/resolution negative
test was "passing" without compiling anything).

This file is retained because the reservation is spent and the measurement below
is corroborating evidence for #4163, plus one correction to its trigger
analysis.

## What was measured (2026-08-06, ES5 label, `--target standalone`)

`tests/test262-runner.ts` did not attach the cached `js2wasm:runtime-eval`
namespace, so any standalone module importing that carrier died at
`WebAssembly.instantiate` with
`Import #0 module="js2wasm:runtime-eval": module is not an object` — **and that
link error overwrote the test's real failure signature.**

| runner state | top signature in `built-ins/Function/prototype` |
| --- | --- |
| before | `dynamic code evaluation … not supported` — **46 of 95 failures**, one bucket |
| after | that bucket disappears; the real distribution is `bind` 34, apply/call `this` 19, misc |

## Correction to #4163's trigger analysis

#4163 attributes the import to the `$262.evalScript` shim. That may also be
true, but the simpler and much broader trigger is the compiler's own pre-scan
`sourceUsesRuntimeEvalBoundary` (`src/codegen/index.ts`), which emits the
carrier import for **any value-position mention of `Function` or `eval`**.
Minimal demonstration, no harness involved:

```
"var g = Function; var z = 1;"  =>  js2wasm:runtime-eval::__runtime_apply_interpreted,
                                    js2wasm:runtime-eval::__runtime_indirect_eval
"var f = new Function('return 1');" =>  (none)
"var y = 1 + 1;"                    =>  (none)
```

So `for (var p in Function)` and `Function.propertyIsEnumerable('prototype')`
were affected too — tests that never evaluate dynamic code at all.

## Second half of the trap, for whoever measures locally

The runner's default provider tier is **REFUSAL**; CI standalone runs with
`TEST262_FULL_RUNTIME_EVAL=1`, i.e. the **INTERPRETER** tier
(`test262-sharded.yml`). The refusal tier links but throws
`dynamic code evaluation is not supported` on any real dynamic-code call, so a
local sweep without that env var still mis-buckets every genuinely
`Function()`-driven test. `selectCachedRuntimeEvalProvider` prints the tier it
chose on first use — read that line before trusting a sweep.

**And: any `src/` edit changes `computeCompilerBundleHash`, which invalidates
the provider cache and silently drops you back to REFUSAL mid-A/B.** That
turned a clean `+2 / 0 regressions` into an apparent `-10` on the first #4192
measurement. Rebuild with `node --import tsx
scripts/build-runtime-eval-provider.mjs` (~100 s) after changing the compiler,
and confirm the printed tier on both sides of the comparison.
