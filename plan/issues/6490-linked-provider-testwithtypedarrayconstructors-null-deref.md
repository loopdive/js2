---
id: 6490
title: "Linked harness provider: testWithTypedArrayConstructors dereferences null on every call — ~1,340 TypedArray rows differ"
status: done
sprint: current
created: 2026-09-16
updated: 2026-09-16
completed: 2026-09-16
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: typed-arrays
goal: test262-conformance
depends_on: [3451]
related: [3451, 6486, 6487, 1941, 4616, 5342]
# 2026-09-16 — the fix is one new predicate in `calls.ts` (+35 lines, 33 of
# which are the comment that records WHY the #1941 gate is wrong for a linked
# provider) and its 7-line wiring into the `hostCallFallback` disjunction in
# `call-identifier.ts`. Both files are the god-files that own the callable-param
# dispatch; the predicate belongs next to its siblings
# (`calleeIsPromiseExecutorParam`, `calleeMayBeHostCallable`), and the
# eligibility expression it joins is a single boolean in `compileIdentifierCall`.
# Moving either out would split a decision that has to be read as one.
loc-budget-allow:
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
---

# #6490 — `testWithTypedArrayConstructors` null deref in the provider

## Problem (first full-corpus run, 2026-09-16, run 35116762391)

Parity buckets `dereferencing a null pointer [in testWithAllTypedArrayConstructors() ← testWithT…]`
700 and `… ← __fn_tram…` 639: every row that calls the `testTypedArray.js`
helper through the provider fails. Minimal repro (smoke, `.tmp/p6490`,
2026-09-16, current main incl. #6487):

```js
/*--- includes: [testTypedArray.js, compareArray.js] ---*/
var n = 0; testWithTypedArrayConstructors(function () { n++; }); assert.sameValue(n > 0, true);
```

fails `dereferencing a null pointer` in the linked lane; `typedArrayConstructors.length`
read from the body passes, so the provider's list exists. Passing an explicit
consumer array or the provider's own `typedArrayConstructors` back changes
nothing. #6487 did not change it.

## What the provider's WAT shows (wasm-dis of the propertyHelper+testTypedArray provider)

`testWithTypedArrayConstructors(param $0..$3 externref)`; the body starts by
materialising `constructors || typedArrayConstructors` through
`__make_iterable(extern.convert_any(global $global$4))` → `__array_from_iter`
→ `ref.cast (ref null $5)` into a fresh `array.new_default $1` filled via
`__extern_get(…, __box_number(i))`. The null deref is somewhere after that
materialisation — the first suspect is the element read: `__extern_get` on the
provider-side vec through the HOST returns the constructor as an externref
mirror, and the following `ref.cast` to the provider's closure/struct type for
the `f(TA)` call (or the `TA.prototype`/`new TA(…)` access inside
`testWithAllTypedArrayConstructors`) sees null.

## Implementation Plan (2026-09-16, Fable lane; implementation: Opus)

1. Reproduce with the body above via `scripts/test262-linked-harness-smoke.mts`
   (delete `.tmp/linked-smoke` first — #6488) and get the trap's function
   trace (`JS2WASM_DEBUG_*` / wasm-dis of the provider: `node_modules/binaryen/bin/wasm-dis`).
   Name the exact instruction that traps.
2. Determine whether the trap is (a) a provider-internal lowering that is wrong
   whenever the helper is called with fewer than 4 args from the host bridge
   (`__call_fn_N` dispatcher passing `undefined`/null for missing externref
   params — check `__extern_is_undefined` handling of a null externref), or
   (b) a cross-module value (the consumer callback `f`) cast to a provider
   type. Test (a) by compiling the harness+body honest with the helper called
   through a function value (`var g = testWithTypedArrayConstructors; g(cb)`)
   and by calling the provider export directly from Node with 1 arg.
3. Fix at the root (codegen or runtime dispatcher), not in the harness.
4. Measure: the repro, then `built-ins/TypedArray/prototype/fill` first 20 via
   the smoke, then the next `linked_lane` dispatch (expect both buckets → 0).

## Root cause (2026-09-16, Opus lane — plan step 2, answer (b))

Neither of the plan's two candidates exactly: not missing-arg handling, and not
a cast of the constructor VALUE. It is the cast of the **callback `f` itself**,
and the trapping instruction is the `struct.get` of the closure record.

Trace (`node --stack-trace-limit=60`, provider `wasm-function[76] 0x59df`):

```
testWithAllTypedArrayConstructors  ← testWithTypedArrayConstructors
  ← __fn_tramp_testWithTypedArrayConstructors_cached ← __call_fn_method_4
```

and the WAT at `f(constructor, boundArgFactory)` (harness line 282:9):

```wat
(local.set $60                             ;; (ref null $0) — provider closure root
 (if (result (ref null $0))
  (ref.test (ref $0) (local.tee $62 (any.convert_extern (local.get $0))))
  (then (ref.cast (ref null $0) (local.get $62)))
  (else (ref.null none))))                 ;; ← consumer closure: test MISSES
...
(if (ref.is_null (local.tee $67 (local.get $60)))
 (then (if (ref.is_null (local.get $62))   ;; raw value is NOT null → no throw
        (then (throw … TypeError)))))
(struct.get $0 0 (local.get $67))          ;; ← TRAPS: $67 is null
```

The provider is its own wasm module, so a callback minted by the **consumer**
carries a closure struct from the consumer's type group. The provider's guarded
`ref.test`/`ref.cast` to ITS wrapper root therefore misses and yields
`ref.null`, while `emitNullCheckThrow` deliberately rethrows only when the value
was nullish *before* the cast (#789: a wrong struct type is meant to fall
through to a dispatch). A live callback is not nullish, so control reaches
`struct.get` on null and the module traps. A wasm trap is not catchable by wasm
exception handling, so it kills the whole program rather than failing one test.

`call-identifier.ts` already owns the right escape hatch — the #1712/#2928
`__call_function` arm — but its eligibility is gated by #1941 on the premise
that *"pure local closures / function params are always wrapped into the closure
struct, so the arm would be dead code"*. **That premise is false by construction
for a linked provider: the value did not come from this module.** This is the
residual `src/codegen/expressions/callable-property-host-value.ts` names in its
own header ("a host function that arrives dynamically through a parameter",
#5342), and the same reasoning #4616 applied to host-reachable *method* params.

## Fix

`calleeIsLinkedProviderParam` (new, `src/codegen/expressions/calls.ts`): a
callable **parameter** in a module compiled with `exportsConsumedByWasm` (the
linker-only flag, #5247, set at `src/package-linker.ts:1893`) may hold a
foreign-module closure, so the host-call arm is emitted. Wired as one more
disjunct of `hostCallFallback` in `compileIdentifierCall`.

Deliberately **not** narrowed to exported functions: `testWithTypedArrayConstructors`
forwards `f` to `testWithAllTypedArrayConstructors`, so reachability, not
export-ness, is the real condition — and in a provider every function exists to
be reached from outside. Blast radius is bounded the other way instead: the flag
is set only by the package linker, so **every single-module compile — the honest
lane, the CLI, the playground, npm packages — is byte-identical.**

## Measurements (2026-09-16, this worktree)

Repro (`.tmp/p6490/repro.js`, smoke with `runDeferredInit: true`):

| | before | after |
|---|---|---|
| minimal repro | `fail: dereferencing a null pointer` | **pass** |

`test262/test/built-ins/TypedArray/prototype/fill`, first 20 via
`scripts/test262-linked-harness-smoke.mts` (both runs executed here, base
restored by file copy from `HEAD`):

| linked verdict | before | after |
|---|---|---|
| `dereferencing a null pointer` | **14** | **0** |
| pass | 1 | 9 |
| other fail (detach/resize semantics, pre-existing) | 2 | 8 |
| compile_error / provider fail | 3 | 3 |

The smoke's "honest" column is not usable as the agreement oracle on this
directory: 15 of 20 honest rows fail `Function.prototype.bind: target cl…`,
an unrelated honest-lane defect, and that column instantiates with a plain
import object (no runner sandbox). The meaningful result is that the trap class
is gone and no linked row regressed.

Honest lane: `node scripts/equivalence-gate.mjs` → `22 failing, 1720 passing,
22 known-failures in baseline` — **"No new equivalence regressions"**, i.e. the
honest lane is unchanged, as the `exportsConsumedByWasm` gate predicts.

Test: `tests/issue-6490-linked-callback-param.test.ts` (3 cases: the repro, the
constructor argument arriving, and an explicit constructor list) — 3 passed.

## Residual

The sibling dispatch in `src/codegen/expressions/calls.ts`
(`compileReceiverMethodCall`, ~L10026) has the same closure-root cast and is
*not* touched here: no measured provider row reached it, and #4616 already
admits the host arm for host-reachable method params. If a
`provider.method(consumerCallback)` shape shows up in a later linked-lane run,
it is the same one-disjunct fix there.

## Acceptance

- [x] Repro passes linked; `TypedArray/prototype/fill` first 20: 14 null-deref
      traps → 0, 1 → 9 pass, no linked row regressed. (Agreement against the
      smoke's honest column is not measurable on this directory — see above.)
- [x] Honest lane byte-identical by construction (linker-only flag) and
      confirmed green: equivalence gate reports no new regressions, 22 known.
