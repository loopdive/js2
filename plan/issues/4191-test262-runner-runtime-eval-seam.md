---
id: 4191
title: "test262 in-process runner never attached the runtime-eval provider — the link error overwrote the real failure signature of every Function/eval-mentioning standalone test"
status: done
created: 2026-08-06
completed: 2026-08-06
updated: 2026-08-06
priority: high
task_type: bug
area: conformance, tooling
goal: es5
assignee: ttraenkler/W13-builtin-proto-residue
sprint: current
horizon: s
related: [2928, 4163, 2875]
---

# #4191 — the in-process test262 runner did not link `js2wasm:runtime-eval`

## Problem

`tests/test262-shared.ts` (the sharded CI lane) and `scripts/test262-worker.mjs`
both attach the cached `js2wasm:runtime-eval` provider namespace before
instantiating a `--target standalone` module. **`tests/test262-runner.ts` — the
in-process runner every triage lane uses — did not.**

The compiler's own pre-scan (`sourceUsesRuntimeEvalBoundary`,
`src/codegen/index.ts`) turns *any value-position mention of `Function` or
`eval`* into a module-level import of the linked runtime-eval carrier. Not just
`new Function(src)` — a bare `var g = Function;`, `for (var p in Function)`,
`Function.propertyIsEnumerable('prototype')`. So a large class of tests that
never evaluate dynamic code still emitted the import, and every one of them died
at `WebAssembly.instantiate` with

```
TypeError: WebAssembly.instantiate(): Import #0 module="js2wasm:runtime-eval":
module is not an object or function
```

**and that link error replaced the test's real failure signature.**

## Why this matters more than a runner nicety

It silently corrupts triage. Measured on the 2026-08-06 tree, ES5-label
`built-ins/Function/prototype` under `--target standalone`:

| runner state | top signature |
| --- | --- |
| before (no provider) | `dynamic code evaluation … not supported` — **46 of 95 failures**, one bucket |
| after (provider attached) | that bucket **disappears**; the real distribution is `bind` 34, apply/call `this` 19, misc |

A census built on the "before" column points a lane at a phantom. Three
separate lanes lost time to it, and the previous session's hand-off note
explicitly warned the next one.

A second, quieter half of the same trap: the runner's default tier is the
**REFUSAL** provider, while CI standalone runs with `TEST262_FULL_RUNTIME_EVAL=1`
(the **INTERPRETER** tier, `test262-sharded.yml`). The refusal tier links but
throws `TypeError: dynamic code evaluation is not supported` on any actual
dynamic-code call, so a local sweep without that env var still mis-buckets every
genuinely `Function()`-driven test. `selectCachedRuntimeEvalProvider` prints
which tier it chose on first use — read that line before trusting a sweep.

## Fix

`tests/test262-runner.ts` grows one shared seam,
`attachRuntimeEvalProvider(binary, imports, target)`, applied at both standalone
instantiate sites (`runOriginalHarnessVariant` and the legacy synthetic runner).
It compiles the binary to a `WebAssembly.Module`, and **only** when
`target === "standalone"` *and* the module actually asks for
`js2wasm:runtime-eval` does it mint a **fresh** provider namespace into the
import object — same policy as `test262-shared.ts`, so interpreter globals never
leak between tests. The host lane and standalone modules that do not ask for the
carrier are untouched.

## Test

`tests/issue-4191-runner-runtime-eval-seam.test.ts` (6 cases): the premise
(`var g = Function;` really does emit the import), the defect (instantiate
rejects with `/js2wasm:runtime-eval/` without the attachment), the fix
(instantiate succeeds with it), per-module provider identity, and the two
no-op guards (host lane; standalone module without the import).

## Local-sweep recipe (for the next lane)

```bash
node --import tsx scripts/build-runtime-eval-provider.mjs   # ~100 s, once
TEST262_FULL_RUNTIME_EVAL=1 npx tsx <your sweep>            # CI-comparable tier
```

Without the env var you get the refusal tier and a wrong bucket for every test
that really evaluates code.
