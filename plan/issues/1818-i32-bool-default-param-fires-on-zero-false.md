---
id: 1818
title: "i32/boolean parameter default fires on a legitimate 0 / false argument"
status: done
escalation: architect-spec-written
created: 2026-06-04
updated: 2026-06-11
pr: 1275
priority: high
feasibility: hard
task_type: bugfix
area: codegen
goal: correctness
sprint: 61
claimed_by: codex-developer
claimed_at: 2026-06-07T10:03:41.716Z
completed: 2026-06-08
---
# #1818 — i32/boolean parameter default fires on `0` / `false`

## Symptom
- `function f(b=true){return b}; f(false)` → `true`.
- `function f(n:number=5){return n}; f(0)` (n narrowed to i32) → `5`.

## Location
`src/codegen/closures.ts:767-770` and `src/codegen/class-bodies.ts:1076-1083`
use `i32.eqz` as the "argument missing" sentinel; booleans resolve to i32
(`type-mapper.ts:55`). The f64 path correctly uses a NaN self-test, and the
array/object-pattern paths already *skip* the check for i32 (closures.ts:714).

## Spec
Default applies only when the argument is `undefined`.

## Fix
Don't emit a default check for plain i32/boolean params; thread an explicit
arg-present flag instead of reusing `0` as the missing sentinel.

## Investigation (2026-06-04, dev-t2) — [ESCALATED-NEEDS-ARCHITECT]

Reproduced; the defect is **broader and more systemic than a localized
`i32.eqz` swap** — missing-argument signalling is inconsistent across function
forms AND value types. Matrix (target wasi, nativeStrings):

| form                | arg = falsy (`false`/`0`) | arg omitted `f()` |
|---------------------|---------------------------|-------------------|
| boolean export fn   | 0 OK                      | **0 WRONG** (default not applied; want 1) |
| boolean arrow       | **1 WRONG** (default fired)| 1 OK             |
| boolean method      | **1 WRONG** (default fired)| (n/t)            |
| i32-native export fn| 0 OK                      | 5 OK             |
| f64 export fn       | 0 OK                      | **NaN WRONG** (default not applied; want 5) |
| f64 arrow           | 0 OK                      | **0 WRONG** (default not applied; want 5) |

Two independent defects, not one:
1. **Inline check fires on a falsy value** (arrow/method i32/boolean):
   `emitParamDefaultCheckInline` (`closures.ts:767-770`) uses `i32.eqz`, which
   cannot distinguish a real `0`/`false` from a missing-arg pad. i32 has **no
   spare sentinel** — every i32 is a legitimate argument — so a value-sentinel
   is fundamentally impossible; an explicit arg-present signal is required.
   (`pushParamSentinel` in `type-coercion.ts:2346` falls to `pushDefaultValue`
   → `i32.const 0` for i32, confirming the collision.)
2. **Omitted-arg default not applied** (export-fn / some f64 paths): the no-arg
   call site does not reliably fill the slot with the missing sentinel, so the
   callee's check never fires (or the f64 sNaN sentinel `0x7FF00000DEADC0DE`
   isn't the value padded — `f64 arrow f()` returns 0, not NaN).

The existing reliable signal is the `__argc` global
(`statements/nested-declarations.ts:1016`), but it is **only set by call sites
when the callee uses `arguments`** (`calls.ts:1106`), so it can't be relied on
for the default check today. The correct fix makes the calling convention carry
a reliable arg-present/arg-count signal for **every** call to a defaulted
function (set `__argc` unconditionally when the callee has defaulted params, and
gate i32/boolean/f64 defaults on `__argc <= paramOrdinal`), threaded across the
direct-call, closure/call_ref, and method-dispatch paths — spanning `calls.ts`,
`closures.ts`, `class-bodies.ts` and the f64 sentinel path. Broad regression
surface on every defaulted function.

**Recommendation: architect spec for the arg-present calling-convention design
before implementation.** The localized "swap i32.eqz" fix the issue proposed
fixes defect #1 for arrows/methods but leaves defect #2 broken and risks
regressing the currently-correct i32-native and f64-export paths. No code change
landed; findings only.

## Implementation Plan (architect, 2026-06-04)

### Root cause (precise, per the source)

Per ES §10.2.11 (FunctionDeclarationInstantiation, step 27.f) a default
initializer runs **iff the bound argument is `undefined`** — i.e. omitted or
explicitly `undefined`. Never for `0`, `false`, `''`, `NaN`, `null`, or any
object. The compiler today decides "is the arg undefined?" by inspecting the
**received value**, which works only for ref types and the f64 sNaN sentinel.
It breaks wherever the value space has no spare sentinel:

1. **i32/boolean inline check fires on a falsy value** — `closures.ts:767-770`
   (`emitParamDefaultCheckInline`, the arrow/method receive path) and the
   mirror at `function-body.ts:774-781` use `i32.eqz`. Every i32 is a valid
   argument, so a real `0`/`false` is indistinguishable from a pad. Booleans
   map to i32 (`type-mapper.ts:55`), so `f(false)` fires the default and
   returns `true`.
   - Note the asymmetry with the *constant-default* path: for `b = true`,
     `extractConstantDefault` (`index.ts:317`, i32 arm at 361-377) returns
     `{i32, value: 1}` → recorded as `constantDefault`. The
     **function-body.ts prologue skips** the check for constant defaults
     (`684`: `if (optEntry?.constantDefault) continue;`) and trusts the caller
     to inline the value. But `emitArrowParamDefaults`/the inline closure path
     does **not** skip — it still emits the `i32.eqz` check — which is why the
     matrix shows **arrow/method** wrong on `false` but the **direct-call**
     i32-native export correct on `0`.

2. **Omitted-arg default not applied** (export-fn boolean/f64) — an exported
   function is emitted with its full formal Wasm signature (no optional-param
   wrapper; `declarations.ts:2937-2960`). Wasm has no optional params, so the
   host must pass every slot. Whatever the host/runner passes for an "omitted"
   trailing arg is a *real* value to the callee — for i32/bool there is no
   sentinel to detect it, and for f64 the host passes plain `0`/`NaN`, not the
   sNaN sentinel `pushParamSentinel` uses, so the prologue check
   (`function-body.ts:782-794`, comparing against `0x7FF00000DEADC0DE`) never
   fires. Hence `boolean export f()` → `0` (want `1`) and `f64 export f()` →
   `NaN` (want `5`).

The existing reliable signal is the `__argc` (mut i32) global
(`nested-declarations.ts:1021`). Today callers set it **only** when the callee
reads `arguments` (`emitSetArgc`, `calls.ts:1108`; closure/method paths via
`emitClosureCallArgcExtras`, `calls.ts:1149`), and the prologue consumes it
**only** in `emitArgumentsVecBody` (`nested-declarations.ts:1116`). The fix
generalizes `__argc` into a per-call **arg-count signal** that defaulted
functions always set and always read for the default check.

### Design: arg-count calling convention for defaulted functions

**Contract.** For any compiled function `F` that has at least one
default-initialized parameter (i.e. `ctx.funcOptionalParams.has(F)`), every
**internal** call site sets `__argc = <number of arguments actually supplied
at the call>` immediately before the call instruction, and the prologue gates
each default on `__argc <= paramOrdinal`. This replaces value-sentinels for
i32/boolean and supplements them for f64 (the sNaN path stays as a correct
secondary signal for the destructuring/array-element callers that already use
it — see Edge cases).

`__argc` semantics already in place are reused verbatim:
- `-1` = "not set / unknown caller" sentinel (module init, host entry). The
  prologue must treat `-1` as "all formals present" → **no default fires**
  unless the value-sentinel says so. This preserves the export-fn host path's
  current behaviour for explicitly-passed args and is the seam Slice 3 widens.
- The prologue **clears `__argc` to -1** right after reading it
  (`nested-declarations.ts:1153-1155` already does this for the arguments
  path; the default-check read must do the same, once, before any nested call
  in the initializer expression can clobber it).

**Why a global and not an extra Wasm param:** adding a synthetic leading param
would change every funcref type, break `call_ref` type-compat with stored
closures, and ripple through `addUnionImports` index math. `__argc` is already
the project's established channel for exactly this (call-site arity → callee),
is already index-shift-aware (`registry/imports.ts:264`), and already has
save/restore discipline on the closure path (`emitResetArgcExtras`). Reuse it.

### Changes

**File: src/codegen/context/types.ts**
- No new field strictly required (`argcGlobalIdx` exists, line 583). Optionally
  add `funcHasDefaults: Set<string>` for O(1) "does this callee gate on argc?"
  lookups, but `ctx.funcOptionalParams.has(name)` already answers it — prefer
  reusing that to avoid a second source of truth.

**File: src/codegen/expressions/calls.ts** — send side (set `__argc` for every defaulted callee)
- `emitSetArgc` (line 1108): generalize. It currently computes
  `min(actualArgCount, paramCount)`. Keep that (the default check only cares
  about ordinals < paramCount; overflow handled by extras), but the **callers**
  must invoke it for defaulted functions, not just arguments-reading ones.
- Add a helper `maybeSetArgcForDefaults(ctx, fctx, funcName, actualArgCount, paramCount)`:
  - `if (ctx.funcUsesArguments.has(funcName) || ctx.funcOptionalParams.has(funcName)) emitSetArgc(...)`.
  - This is the single gate. Call it on **every direct-call arm** that currently
    only conditionally set argc. The direct-call arms that pad with
    `pushDefaultValue`/`pushParamSentinel` are at lines ~2664, ~2739, ~2789,
    ~5604, ~6180, ~6263, ~6328, ~6413, ~6474, ~8397, ~8738 (each already calls
    `emitSetArgc` for the arguments case at the paired `emitSetArgc` lines
    5609/6185/6268/6333/6418/6479) — switch those to `maybeSetArgcForDefaults`
    and add it to the arms that have a `pushParamSentinel` block but no argc set
    today (the ~2664/2739/2789 apply/spread arms and the ~8397/8738 inline arms).
  - **Crucially**: argc is the count of *supplied* args, set even when the call
    fills all formals (so a present-but-trailing arg reads as present). When
    `expr.arguments.length >= paramCount`, argc = paramCount (all present).
- `compileOptionalDirectCall` (line 1238): the padding loop at 1287-1291 uses
  `pushDefaultValue` for missing slots and never sets argc — add
  `maybeSetArgcForDefaults(ctx, fctx, callee.text, expr.arguments.length, paramTypes.length)`
  before the `call` at 1292, and switch the pad to `pushParamSentinel` so the
  f64 sNaN secondary signal is still emitted.

**File: src/codegen/expressions/calls-closures.ts** — closure / method send side
- `compileClosureCall` already calls `emitClosureCallArgcExtras` (line 136)
  unconditionally, which sets argc for *every* closure call — good, no change
  needed beyond confirming it runs before the `call_ref`. The lifted closure
  body is compiled through the same `function-body.ts` prologue, so the
  receive-side change covers it.
- `compileGetterCallable` (line 289) likewise calls `emitClosureCallArgcExtras`
  — no change.

**File: src/codegen/function-body.ts** — receive side (the canonical prologue)
- In the default-init loop (lines 678-796), replace the **value-sentinel gate**
  for **i32 and f64** with an **argc gate**, keeping the value-sentinel as a
  fallback for the `__argc == -1` (unknown-caller) case:
  - Compute the argc-present condition once per param: 
    `argMissing(i) := (global.get __argc) != -1 && (global.get __argc) <= i`.
    (Read `__argc` into a local **once at prologue top**, before the loop and
    before any initializer expression runs — initializer eval can make nested
    calls that overwrite the global. Clear the global to -1 after caching.)
  - **i32 arm (774-781)**: replace `i32.eqz` with the cached
    `argMissing(paramIdx)` i32 condition. When argc is -1 (host/unknown), do
    **not** fire (matches "explicit value present"); export-fn omitted-arg for
    i32-native is out of reach without argc and is accepted as-is (the matrix
    shows i32-native export `f()`→5 already correct because the runner passes
    the literal default — leave it).
  - **f64 arm (782-794)**: gate on `argMissing(paramIdx) || isSentinel(paramIdx)`
    — OR the new argc condition with the existing sNaN test. This fixes both
    `f64 arrow f()` (argc=0 from the closure path) and keeps the destructuring
    sentinel callers working. For `f64 export f()` the argc is -1 so the sNaN
    test alone governs — Slice 3 addresses the host-entry case.
  - **externref / ref arms (741-773)**: leave as-is. `__extern_is_undefined` /
    `ref.is_null` is already spec-correct (fires on undefined, not null).
    Optionally also OR in `argMissing` for symmetry, but not required.
- The constant-default skip at line 684 stays — for constant defaults the value
  is inlined by the caller (direct calls) so the prologue need not check. **But**
  add: do **not** skip when the function is a closure/arrow whose inline path
  (`emitArrowParamDefaults`) emits the check, OR (simpler, preferred) make the
  arrow inline path **also** honor the constant-default skip + argc gate so both
  receive sides are identical. See next.

**File: src/codegen/closures.ts** — arrow/method inline prologue (must mirror function-body.ts)
- `emitParamDefaultCheckInline` (lines 738-777): apply the identical argc gate.
  - **i32 arm (767-770)**: replace `i32.eqz` with the cached `argMissing(paramIdx)`
    condition (same `__argc`-local pattern; the closure body is a separate
    function context so it caches its own `__argc` local at its prologue top).
  - **f64 arm (771-775)**: OR `argMissing` with the existing `f64.ne` self-NaN
    test. (Note: the current f64 arm here uses `f64.ne` self-test = "is NaN",
    which is **wrong** vs the sNaN-sentinel approach in function-body.ts — it
    fires on *any* NaN, including explicit `NaN`. Switch it to the sNaN
    `i64.reinterpret_f64 == 0x7FF00000DEADC0DE` test to match function-body.ts,
    then OR with argc. This also fixes a latent "explicit NaN triggers default"
    bug on arrows.)
  - externref/ref arms: unchanged.
- `emitArrowParamDefaults` (line 783): cache `__argc` into a local at the top of
  the lifted body (before the per-param loop at 804), mirroring the
  function-body.ts placement. Apply the constant-default skip here too so arrows
  match declarations: read `ctx.funcOptionalParams` keyed by the lifted closure
  name (or thread the `OptionalParamInfo[]` through `liftClosure`), and `continue`
  on `constantDefault` params **only when the call site inlines** — since closure
  call sites do NOT inline constant defaults (they `pushDefaultValue` at
  `calls-closures.ts:127-129`), the arrow prologue MUST keep checking. So: keep
  the check for arrows, but use the argc gate (not value-sentinel) + sNaN.

**File: src/codegen/class-bodies.ts** — class method prologue (issue cites 1076-1083)
- Same change as `emitParamDefaultCheckInline`: the method-body default check at
  ~1076-1083 must use the argc gate + sNaN f64 test, not `i32.eqz`/`f64.ne`.
  Method call sites set argc via `emitClosureCallArgcExtras` (the method-dispatch
  arms in calls.ts at ~6328/6413/6474 call `emitSetArgc`), so the signal is
  present. If any method-dispatch arm lacks an argc set, add
  `maybeSetArgcForDefaults` there.

**File: src/codegen/type-coercion.ts** — sentinel emission (keep, narrow)
- `pushParamSentinel` (line 2346) stays as-is — it remains the f64 secondary
  signal and the i32 constant-default emitter. No behavioural change; the i32
  fall-through to `pushDefaultValue` (`i32.const 0`) is now harmless because the
  receive side no longer treats `0` as "missing" — it trusts argc. Add a comment
  noting argc is now authoritative for i32.

### Wasm IR pattern

Prologue, cached once at top (both function-body.ts and each closure body):

```wasm
;; __argc_dflt = global.get __argc ; then clear to -1
global.get $__argc
local.tee $__argc_dflt
i32.const -1
global.set $__argc            ;; clear so nested initializer calls don't see stale
```

Per defaulted param `i` (i32 example):

```wasm
;; argMissing(i) := __argc_dflt != -1 && __argc_dflt <= i
local.get $__argc_dflt
i32.const -1
i32.ne
local.get $__argc_dflt
i32.const <i>
i32.le_s
i32.and
if  ;; arg i was omitted → run initializer
  <compile initializer> 
  local.set $param_i
end
```

f64 param `i` (argc OR sNaN):

```wasm
;; argMissing(i)  (as above, leaves i32 on stack)
local.get $param_i
i64.reinterpret_f64
i64.const 0x7FF00000DEADC0DE
i64.eq
i32.or
if
  <compile initializer>
  local.set $param_i
end
```

### Slice breakdown

- **Slice 1 — i32/boolean argc gate (fixes defect #1, the headline symptom).**
  Cache `__argc` local in function-body.ts + closures.ts + class-bodies.ts
  prologues; replace the i32 `i32.eqz` checks with `argMissing(i)`; ensure every
  defaulted-callee call site sets argc (`maybeSetArgcForDefaults`). Add the
  `__argc != -1` guard so host/unknown callers don't spuriously fire. Target:
  `f(false)`→`false`, `f(0)`→`0`, arrow/method boolean falsy correct. ~80 LOC.
- **Slice 2 — f64 argc OR sNaN + arrow f64 self-NaN bugfix.** OR argc into the
  f64 prologue check; switch the arrow/method f64 arm from `f64.ne` self-test to
  the sNaN-sentinel test (matches function-body.ts; also fixes explicit-`NaN`
  default firing on arrows). Target: `f64 arrow f()`→`5`, explicit `NaN` arg
  preserved. ~40 LOC.
- **Slice 3 — export-fn omitted-arg (defect #2).** The host entry point can't
  set `__argc`. Two options, pick per dev judgement + a quick spike:
  - (a) **Preferred:** emit a thin **export wrapper** for any exported function
    with defaults — the wrapper takes the full formal signature, but the
    *runner/host contract* is unchanged; instead, generate an **arity-aware
    export** by exporting the function under its name and having the wrapper set
    `__argc` based on a sentinel the host passes for omitted trailing args. Since
    the test262 runner controls argument marshalling, the cleaner route is: when
    the host omits a trailing arg, pass the **sNaN sentinel for f64** and rely on
    Slice 2; for i32/boolean exports, accept the limitation (document it) OR
    widen the exported param to f64/externref so a sentinel exists.
  - (b) **Scoped alternative:** in the test262 harness adapter, detect defaulted
    exports and pass `undefined`→sentinel per param type. This fixes conformance
    without a codegen wrapper.
  - Recommend the dev spike (a)-vs-(b) for ≤30 min and escalate the
    representation choice (widen i32 export params?) back to architect if (a)
    needs a signature change. Slice 3 is **independently shippable** — Slices 1+2
    already clear the bulk of the test262 default-param family (the falsy-arg
    cases), which are the high-count failures.

### Regression matrix (must all hold after Slices 1+2; Slice 3 adds the `f()` export rows)

| form                  | `f(false)` / `f(0)` | `f()` omitted | explicit `f(NaN)` (f64) | explicit `f(undefined)` |
|-----------------------|---------------------|---------------|-------------------------|--------------------------|
| boolean export fn     | false / —           | default (S3)  | —                       | default                  |
| boolean arrow         | false               | default       | —                       | default                  |
| boolean method        | false               | default       | —                       | default                  |
| i32-native export fn  | 0                   | default*      | —                       | default                  |
| i32-native arrow      | 0                   | default       | —                       | default                  |
| f64 export fn         | 0                   | default (S3)  | NaN preserved           | default                  |
| f64 arrow             | 0                   | default       | NaN preserved           | default                  |
| f64 method            | 0                   | default       | NaN preserved           | default                  |

\* i32-native export `f()` already returns the default in the current matrix
(runner passes literal). Verify Slice 1's `__argc==-1` guard does not regress it.

### Test files to verify

- `test262/test/language/statements/function/dflt-params-arg-val-not-undefined.js`
  — explicit `false`/`''`/`NaN`/`0`/`null`/obj must NOT run initializers (the
  headline test; exercises every value type).
- `test262/test/language/statements/function/dflt-params-arg-val-undefined.js`
  — explicit `undefined` MUST run initializer.
- `test262/test/language/expressions/arrow-function/dflt-params-arg-val-not-undefined.js`
  — arrow form (Slice 1 closures.ts path).
- `test262/test/language/expressions/function/dflt-params-arg-val-not-undefined.js`
- `test262/test/language/statements/async-function/dflt-params-arg-val-not-undefined.js`
- The 50-file `dflt-params-arg-val*` family (`find test262/test -name 'dflt-params-arg-val*.js'`).
- Add a focused equivalence test `tests/issue-1818.test.ts`: boolean/i32/f64
  params with falsy explicit args, omitted args, and explicit `NaN`, across
  function-decl / arrow / method / export forms (the full matrix above).

### Risk / conflicts

- **`__argc` save/restore discipline**: the closure path already does
  `emitResetArgcExtras` after `call_ref` (`calls-closures.ts:152-162`). The new
  direct-call argc sets must NOT leak into a subsequent defaulted callee — but
  since the prologue clears `__argc` to -1 immediately after caching it, a
  callee that sets argc then calls another defaulted fn in an initializer is
  safe (the inner call sets its own argc just before it runs). Verify no path
  reads `__argc` after the prologue cache without re-setting it.
- **Interaction with `emitArgumentsVecBody`**: that consumer also reads+clears
  `__argc`. A function that BOTH has defaults AND reads `arguments` will have two
  readers. Order matters: the default-init loop runs first (lines 678-796), the
  arguments object is built later (line 815+). The default-init cache must read
  argc, and the arguments builder must read the **same** cached value, not the
  already-cleared global. **Fix:** when both features are present, cache argc
  once into a shared local and have `emitArgumentsVecBody` read that local
  instead of re-reading the global. Thread the cached-local index via a new
  optional `FunctionContext.argcCachedLocal?: number` field. This is the one
  cross-cutting subtlety — flag it prominently for the dev.
- **No new host imports** — argc is a module global, standalone-safe. ✓
- File overlap: touches `function-body.ts`, `closures.ts`, `class-bodies.ts`,
  `calls.ts` — check the merge queue for in-flight PRs on these (the param/dstr
  family #1529/#1543/#1553 area). Coordinate ordering with tech lead.

## Implementation (2026-06-07, codex-developer)

Implemented Slices 1 and 2 of the architect plan.

PR: https://github.com/loopdive/js2/pull/1275

- Added a cached `__argc` local for default-parameter prologues and reused it
  when building `arguments`, so initializer calls cannot clobber the call-site
  arity before either consumer reads it.
- Set `__argc` at internal call sites for callees with optional/defaulted
  params, not only for callees that read `arguments`.
- Replaced i32/boolean value-sentinel checks with an omitted-argument check
  based on cached arity across declarations, nested functions, arrows, class
  constructors, methods, setters, `new`, and `super` call paths.
- Switched inline f64 checks to the explicit sNaN sentinel and ORed them with
  omitted-argument arity, preserving explicit `NaN` while defaulting omitted
  f64 arguments.
- Registered class constructor/method/setter optional-param metadata so their
  direct call sites know to send `__argc`.

Validation:

- `pnpm exec prettier --check src/codegen/context/types.ts src/codegen/statements/nested-declarations.ts src/codegen/function-body.ts src/codegen/closures.ts src/codegen/class-bodies.ts src/codegen/expressions/calls.ts src/codegen/expressions/new-super.ts tests/issue-1818.test.ts`
  passed.
- `git diff --check` passed.
- `pnpm test tests/issue-1818.test.ts` passed: 5 tests.
- `pnpm test tests/default-params.test.ts tests/issue-1025-param-default-null.test.ts tests/issue-1224.test.ts tests/issue-1818.test.ts`
  passed: 26 tests across 4 files.
- `TEST262_PATH_FILTER='language/statements/function/dflt-params-arg-val-not-undefined.js|language/expressions/arrow-function/dflt-params-arg-val-not-undefined.js|language/expressions/function/dflt-params-arg-val-not-undefined.js|language/statements/function/dflt-params-arg-val-undefined.js' TEST262_REPORTER=dot pnpm run test:262 -- --official-scope-only`
  ran the scoped official paths after initializing the shallow `test262`
  submodule. The run completed but those broader conformance files remain
  failing: the three `not-undefined` forms stop at the empty-string assertion,
  and the `undefined` form stops at explicit-`undefined` defaulting. The focused
  Slices 1/2 i32/boolean/f64 regressions are covered by `tests/issue-1818.test.ts`;
  the remaining official-file failures need the broader representation work
  described by Slice 3 / follow-up default-parameter conformance work.

## Refresh (2026-06-07, codex-developer attempt 30)

PR #1275 was open and ready, but the sharded standalone guard reported 21
`dflt-params-trailing-comma` method/class regressions. The common pattern was an
explicit `undefined` f64 argument in a defaulted parameter slot; the stricter
sNaN default check preserved explicit `NaN` correctly, but generic
`compileExpression(..., expected f64)` still emitted an ordinary NaN for literal
`undefined`.

Adjusted numeric-context `undefined`/`void` lowering to emit the existing f64
sNaN default sentinel. This keeps arithmetic behavior as NaN while allowing
default-param receive checks to distinguish explicit `undefined` from explicit
`NaN`.

Additional validation:

- `pnpm test tests/issue-1818.test.ts` passed: 6 tests.
- `pnpm exec prettier --check src/codegen/expressions.ts src/codegen/literals.ts tests/issue-1818.test.ts`
  passed.
- `git diff --check` passed.
- `TEST262_PATH_FILTER='language/expressions/class/method/dflt-params-trailing-comma.js|language/statements/class/method/dflt-params-trailing-comma.js|language/expressions/object/method-definition/meth-dflt-params-trailing-comma.js' TEST262_REPORTER=dot pnpm run test:262 -- --official-scope-only`
  completed with a 3/3 pass report for the selected paths. Vitest still printed
  `No test suite found` diagnostics for empty generated local shards, but the
  runner exited 0 and wrote `3 pass / 3 total`.

Post-merge validation after merging `origin/main` at `28c668ab4`:

- `pnpm test tests/issue-1818.test.ts` passed: 6 tests.
- `pnpm test tests/default-params.test.ts tests/issue-1025-param-default-null.test.ts tests/issue-1224.test.ts tests/issue-1818.test.ts`
  passed: 27 tests across 4 files.
- `pnpm exec prettier --check src/codegen/context/types.ts src/codegen/statements/nested-declarations.ts src/codegen/function-body.ts src/codegen/closures.ts src/codegen/class-bodies.ts src/codegen/expressions/calls.ts src/codegen/expressions/new-super.ts src/codegen/expressions.ts src/codegen/literals.ts tests/issue-1818.test.ts`
  passed.
- `git diff --check` passed.
- `TEST262_TARGET=standalone TEST262_PATH_FILTER='language/expressions/class/method/dflt-params-trailing-comma.js|language/statements/class/method/dflt-params-trailing-comma.js|language/expressions/object/method-definition/meth-dflt-params-trailing-comma.js' TEST262_REPORTER=dot pnpm run test:262 -- --official-scope-only`
  completed with a 3/3 pass report for representative standalone method/class
  forms from the CI regression cluster. The runner still printed empty-shard
  `No test suite found` diagnostics, but exited 0 and wrote `3 pass / 3 total`.
