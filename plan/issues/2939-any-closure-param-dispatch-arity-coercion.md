---
id: 2939
title: "codegen: dynamic dispatch of an any-typed closure param (fn(...)) must honor JS arity semantics + coerce arg kinds (blocks #2940, unblocks 468+ BigInt tests)"
status: ready
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: closures, dynamic-dispatch
goal: host-independence
related: [2940, 2903]
created: 2026-07-02
updated: 2026-07-02
origin: "2026-07-02 spun out of #2940 yield-gate analysis (dev-callback). origin/main @ 4d5287afc."
---

# #2939 — dynamic `fn(...)` on an any-typed closure param: arity + kind tolerance

> **Provenance / id history**: Formerly #2923; merged PR #2441 (the
> implementation of THIS issue) cites #2923 in its title — at merge time that
> id referred to this dispatch-arity issue; the id was subsequently taken on
> main by the eval compile-away issue
> (`plan/issues/2923-eval-constant-string-compile-away-broaden.md`), so this
> file was re-id'd to #2939 (allocated via `claim-issue.mjs --allocate`,
> tech-lead decision 2026-07-02).

## Problem

When a closure is held in an `any`-typed **parameter** and invoked
(`fn(a, b)`), the compiler's dynamic-dispatch path only invokes the closure
when the **call-site arg count AND each arg's Wasm type-kind exactly match**
the closure's declared parameter list. On any mismatch the call is **silently
dropped** (graceful fallback compiles the args for side-effect and returns
`ref.null.extern`) — the closure body never runs. This violates JS call
semantics (extra args ignored, missing args `undefined`) and silently
no-ops a large class of higher-order code.

This is the blocker under #2940: the test262 `testWith*TypedArrayConstructors`
harness wrapper calls `fn(ctor, makeCtorArg)`, but the callback declares
`function(TA)` (1 param) or its params are `any`/externref while the shim
passes a constructor value + a funcref — either way the kinds/arity don't match
and the whole test body is dead (a _vacuous_ pass). Fixing this unblocks
**468+ BigInt TypedArray tests** and is a **general** correctness fix beyond the
harness class.

## Isolated repro (standalone; `.tmp` probes)

```ts
function __ta_passthrough(x: any): any {
  return x;
}
function testWithBigIntTypedArrayConstructors(fn: any): void {
  const constructors = [BigInt64Array, BigUint64Array];
  for (let i = 0; i < constructors.length; i++) {
    fn(constructors[i], __ta_passthrough); // <-- call SILENTLY DROPPED
  }
}
testWithBigIntTypedArrayConstructors(function (TA: any) {
  log(999);
});
// log(999) never fires -> body vacuous
```

Truth table (call → callback params → invoked?):

| call                   | callback params     | invoked?                               |
| ---------------------- | ------------------- | -------------------------------------- |
| `fn(x)`                | `(TA)`              | YES                                    |
| `fn(x, y:number)`      | `(TA, m)`           | YES                                    |
| `fn(x)`                | `(TA, m)`           | **NO** (arity: fewer args than params) |
| `fn(x, y)`             | `(TA)`              | **NO** (arity: more args than params)  |
| `fn(ctor[i], namedFn)` | `(TA, makeCtorArg)` | **NO** (arg kinds != externref params) |

## Exact sites

`src/codegen/expressions/calls-closures.ts`:

- **L688** `if (info.paramTypes.length !== sigParamCount) continue;` — the
  exact-arity gate that skips a matching closure whose declared param count ≠
  the call-site arg count.
- **L693–698** per-parameter `sigParamWasmTypes[i].kind !== info.paramTypes[i].kind`
  loop — requires each arg's Wasm kind to match the param kind exactly, with no
  coercion.
- Note: the same file already contains arity-padding helpers for OTHER paths
  (e.g. L724–738 `Math.min(args, paramCount)` truncate + `pushDefaultValue`
  fill), so the intended semantics exist elsewhere — this identifier/any-param
  path just needs to adopt them.

## Required behavior (JS §7.3.14 Call / OrdinaryCallBindThis)

1. **Arity**: match a candidate closure regardless of arg-count vs param-count.
   Truncate extra args (compile for side-effect + drop), and `undefined`-fill
   missing params (`pushDefaultValue`).
2. **Kind coercion**: coerce each passed arg to the closure param's kind
   (`coerceType`) rather than requiring exact-kind equality — a constructor
   value / funcref / number passed into an `any`(externref) param must box to
   externref, etc. Choose the candidate by param **count is no longer a hard
   filter**; disambiguation among multiple registered closure types will need a
   rule (prefer exact-arity, else nearest; or route via the generic
   `__call_fn_N` dispatcher if one exists for the arg count).
3. Preserve existing exact-match fast paths for byte-inertness on the js-host/gc
   lanes.

## Part-1 prototype (from #2940, NOT to ship alone)

The runner shim gap that surfaces this: `tests/test262-runner.ts`
`needsTestTypedArray` gate regex `/testWithTypedArrayConstructors/` misses the
`BigInt` variant; no `testWithBigIntTypedArrayConstructors` shim; shim passes
only 1 arg. Prototype (add BigInt wrapper + passthrough `makeCtorArg` + regex
`/testWith(?:BigInt)?TypedArrayConstructors/`) removes the `__make_callback`
import and instantiates host-free — but MUST land together with this dispatch
fix, else it produces **dishonest vacuous host-free passes** (durable project
rule: leak-elim must prove bodies execute, not just that the import disappears).

## Acceptance / measurement

- The repro above invokes the body (`log(999)` fires) in standalone.
- Then re-measure the #2940 BigInt corpus: with shim + this fix, sample ~30 and
  **compare standalone runtime OUTPUT vs js-host** (a vacuous host-free pass
  must be scored as a FAIL by the harness, not a pass). Report genuine-pass
  fraction. BigInt TypedArray semantics coverage is **unmeasured** — expect
  partial; real fails that surface are honest, not regressions.
- Byte-inert for js-host/gc lanes (sha256); gate any standalone-specific
  behavior on `ctx.standalone`.
- Full `merge_group` net-positive.

## Re-measurement post PR #2441 (dev-f2, 2026-07-02) — NEW sub-gap: nested-scope callbacks

Task #16 attempted the runner shim now that PR #2441 (the arity half) landed.
Measured on current main (`compile(..., {target:"standalone"})`, inject-throw
discipline throughout):

**1. Top-level dispatch works post-#2441** (minimal repro, callback function
expression at module top level): 1-param and 2-param callbacks both INVOKE
(counter=2, inject-throw traps), host-free. The arity fix is real.

**2. NEW BLOCKER — a callback function-expression defined INSIDE another
function is not a dispatch candidate.** The exact same shim + call, moved
inside `export function test() { try { … } catch … }` (the test262 runner's
wrap shape), silently drops the `fn(...)` dispatch:

| shape                                                      | invoked?   |
| ---------------------------------------------------------- | ---------- |
| top-level `tw(function(TA){hit++}, null, ["passthrough"])` | YES (2)    |
| same call inside `export function test()`                  | **NO** (0) |
| 1-arg variant inside `test()`                              | **NO** (0) |

Since the runner wraps EVERY test body inside `test()`, all real-corpus
callbacks are nested → with the shim the wrapper compiles host-free but the
body is dead. Deterministic 24-file corpus sample
(`TypedArray/prototype/**/BigInt`, every-20th): control (main, no shim) =
21/21 non-CE files honestly leaky (`env::__make_callback`); with shim =
9 host-free + **9/9 VACUOUS by inject-throw**, 12 still leaky via secondary
imports (`Uint8ClampedArray_*` HOF paths, `WeakMap_set`), 3 CE.
**Genuine flips = 0. The shim was NOT shipped** (revert kept; shim text below
for when this lands).

**3. Also measured:** calling a function VALUE held in an any param
(`makeCtorArg(7)` where the passed arg is a top-level named function) returns
`undefined` — the 1-arg dynamic call finds no candidate (graceful fallback),
independent of the nested-scope gap.

So the remaining scope here is (a) **nested-scope function-expression
candidate registration** — the closure registry/`tryEmitInlineDynamicCall`
candidate scan must see function expressions created in inner scopes — plus
(b) the original kind-coercion half, plus (c) 3.

### Deferred runner-shim text (do NOT ship before (a) lands; then re-measure)

The corpus needs the 3-arg harness signature — ~200 files call
`testWithBigIntTypedArrayConstructors(fn, null, ["passthrough"])`; with a
1-param shim even the DIRECT call is arity-dropped (measured: that alone made
9/9 sampled files vacuous):

```ts
// gate: includes testTypedArray.js && /testWithBigIntTypedArrayConstructors/
// (the existing needsTestTypedArray regex does NOT match the BigInt-infixed name)
function __ta_makeCtorArgPassthrough(x: any): any {
  return x;
}
function testWithBigIntTypedArrayConstructors(fn: any, ctors?: any, argFactories?: any): void {
  let constructors: any = ctors;
  if (constructors == null) {
    constructors = [BigInt64Array, BigUint64Array];
  }
  for (let i = 0; i < constructors.length; i++) {
    fn(constructors[i], __ta_makeCtorArgPassthrough);
  }
}
```

## Notes

Spun out of #2940 (blocked_on this). Repro scripts were under `.tmp/` during the
#2940 investigation (dyncall / genuine probes); regenerate from the table above.
Re-measurement probes: `.tmp/probe-2937-{dispatch,twoparam,nested,imports,control}.mjs`
(gitignored; regenerate from this file — filenames predate the 2937→2940 re-id).
