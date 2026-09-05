---
id: 4530
title: "clsx: variadic argument classification broken — strings iterate per-character ('f o o'), numbers and object keys drop; 12/32 upstream tests fail"
status: done
completed: 2026-08-21
sprint: current
created: 2026-08-16
updated: 2026-08-21
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: typeof, arguments, for-in
goal: npm-library-support
related: [3995, 4529, 3750]
# LOC allowances for the #4530/#4529 fix PR: each addition is a narrow,
# commented soundness/semantics patch at the site that owns the defect —
# the alias registration (index.ts), the closure-call signature dispatch
# (call-identifier.ts), the typeof fold (typeof-delete.ts), the host
# ToObject/typeof helpers (runtime.ts), and one context registry field
# (context/types.ts).
loc-budget-allow:
  - src/codegen/typeof-delete.ts
  - src/runtime.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/index.ts
  - src/codegen/context/types.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/runtime.ts::<anonymous>#90
files:
  - tests/dogfood/clsx-upstream-suite.mjs
---

# clsx: `toVal`'s typeof/iteration classification misfires on variadic args

## Problem

clsx's pinned upstream suite: **20/32 Wasm** (32/32 Node), measured
2026-08-16 on `a9b20d4c`, matching the npm-compat card. The 12 failures are
classification errors inside clsx's tiny `toVal`/loop core:

| upstream test | got | expected | reading |
| --- | --- | --- | --- |
| `strings` | `f o o` | `foo` | a **string** arg was iterated element-wise like an array |
| `strings (variadic)` | `f o o bar` | `foo bar` | same, mixed with a later arg that worked |
| `numbers` | `` (empty) | `1` | a **number** arg was dropped (typeof gate missed) |
| `numbers (variadic)` | `2` | `1 2` | first number dropped |
| `objects` | `` | `foo` | object key iteration produced nothing |
| `objects (variadic)` | `bar` | `foo bar` | first object's keys dropped |
| `arrays (no push escape)` | `` | `push` | array-like branch misrouted |
| `functions` | `hello w o r l d` | `hello world` | string after function arg re-hit the char-split |
| `exports` (×2, index+lite) | function !== function | — | default vs named export not identical |
| lite `strings` ×2 | ``/`bar` | `foo`/`foo bar` | lite's `typeof x === 'string'` gate failed |

Upstream `toVal` is: `typeof mix === 'string' || typeof mix === 'number'` →
append; else if object → `Array.isArray` ? recurse : `for (k in mix)`. The
observed set (string treated as iterable object, number failing the typeof
gate, `for..in` over an object yielding nothing) says variadic/boxed args are
misclassified — the same family as #4529's typeof-on-boxed-any, plus the
`for..in`-over-boxed-object and `Array.isArray`-on-boxed gates. The
`exports` failures are separate: `clsx` default and named export are not the
same function object after compilation.

## Reproduction

```bash
node --import tsx tests/dogfood/clsx-upstream-suite.mjs --json
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. **Land #4529 first** (typeof on boxed any) and re-run this suite — the
   string/number rows likely flip with it; this issue then owns what
   remains. Do not duplicate the typeof fix here.
2. **Reduce the `for..in` row independently**: a function receiving a boxed
   object arg (via rest/`arguments`) whose `for (k in obj)` yields no keys.
   Cross-check #3750 (dynamic property writes dropped) and the
   `Object.keys`-on-dynamic issues (#4298) — pick the existing issue if the
   reduction matches; otherwise this issue carries it.
3. **Reduce the export-identity row**: `export default clsx; export { clsx }` —
   both bindings must resolve to one function object through the host
   bridge. Suspect: each export path mints its own wrapper closure. Fix in
   the export emission (one canonical function value per declaration),
   not in the harness.
4. **Validation gates**: clsx harness 20 → ≥30 (record exact); committed
   reductions for each fixed row; equivalence green.

## Acceptance criteria

- [ ] `clsx('foo')` compiles to `"foo"`, `clsx(1,2)` to `"1 2"`,
      `clsx({foo:true})` to `"foo"` through the dynamic-arg path.
- [ ] Default and named export are identical function values.
- [ ] clsx upstream ≥ 30/32 with any residual named in this file.

## Resolution (2026-08-21)

clsx pinned suite **20/32 → 31/32**. Three general fixes, none clsx-specific:

1. `registerImportBindingAliases` (src/codegen/index.ts) now copies
   `funcUsesArguments` and `funcRestParams` onto the local import name — a
   call through a default-import alias of an `arguments`-reading function
   previously skipped the `__argc`/`__extras_argv` protocol and dropped every
   argument.
2. The lazy function-closure singleton (`ensureFuncClosureSingleton`,
   src/codegen/closures/method-trampolines.ts) is canonicalized per target
   funcIdx via `ctx.funcClosureSingletonKeyByFuncIdx` — the default and named
   bindings of one function now materialize the SAME value
   (`mod.default === mod.clsx`), and an alias's stored wrapper matches the
   call-site dispatch candidates.
3. The closure-call signature dispatch (call-identifier.ts) strips the
   declaration-less rest slot TS synthesizes for JS `arguments`-readers
   (`(...args: any[])`) from the positional param count — it previously
   became one positional vec param that materialized the first argument into
   a char vec (`clsx('foo')` → "f o o").

Additionally #4529's param-inference withdrawal (opaque `any` call-site args
withdraw GC-ref narrowings in `inferParamTypeFromCallSites`) fixed the
in-module `toVal` misclassification this issue's plan step 1 predicted.

Regression tests: `tests/issue-4530-import-alias-calls.test.ts` (3 tests).

**Residual (1/32) — FIXED 2026-08-22, clsx now 32/32**: `functions` assertion
3 — `fn(foo, 'hello', [[fn], 'world'])` returned "hello w o r l d": the
first-element heuristic in `compileArrayLiteral` picked the nested array's
VEC type for the whole literal, so the string element was coerced string→vec
(char split). Added the vec-first widening arm alongside the existing
numeric-first (#786/#4394) and string-first (#2190/#2190b) mirrors: a
vec-first literal with any non-vec element widens its carrier to externref.
Homogeneous nested-array literals keep their vec (guarded). Regression test:
`tests/issue-4530-vec-first-string-widening.test.ts` (2). Guards green:
#786 ×2, #1021, #2190, #2190b, #3532, #3979, #4531 (88 tests).

## 2026-08-22 — opaque-any withdrawal SCOPED DOWN (native-messaging smoke regression)

The withdrawal's any-typed IDENTIFIER arm broke the `native-messaging smoke`
required check on every head of PR #4728: in the bun-bundled
(annotation-stripped) framing core, `readFillExact(read, buf, …)` passes a
plain identifier bound to the caller's own untyped param. Flagging it
withdrew the `Uint8Array` vec narrowing module-wide and the WASI byte path
silently no-opped — node_fs/deno scale variants emitted ZERO output at every
size (bisected by cumulative file-revert against the first PR commit; main's
CLI produced a working module from the identical bundle).

Scope now: only NON-identifier `any` args flag opacity — `arguments[i]`,
call results, member reads, i.e. every poison shape this issue actually
fixed — and a param with an explicit non-`any` annotation never withdraws.
Verified: scale test passes all 4 variants at 1/64/128/256 MiB under
wasmtime v46.0.1; clsx 32/32, acorn 3518/3518, #4530/#4611/#2867 guards
green.
