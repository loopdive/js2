---
id: 2669
title: "ES2015: destructuring correctness residual umbrella (~696 fails — iterator-close, defaults, holes, rest across for-of/assignment/binding/params)"
status: ready
created: 2026-06-25
updated: 2026-06-30
priority: low
feasibility: hard
model: fable
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: destructuring
goal: spec-completeness
related: [1642, 2566, 1556, 1454, 2203, 2032, 796]
sprint: current
---
# #2669 — ES2015 destructuring correctness residual umbrella

## Edition / impact

- **Edition:** ES2015.
- **Fail count:** **~696** — the single largest ES2015 cluster (and the largest
  cross-cutting theme in the whole suite).
- Sub-breakdown (by `/dstr/` path + `destructuring-*` feature tag):
  - `for-of/dstr` — **247**
  - `expressions/assignment` (assignment destructuring) — **131**
  - binding patterns (`let`/`const`/`var` dstr) — **91**
  - function-param dstr — **63**
  - generator/yield-in-dstr — **63**
  - object-method (`expressions/object/dstr`, class method params) — **55**
  - arrow-function dstr — **30**
  - other — **16**

Residual after a long line of done destructuring issues (#1454, #2203, #2032,
#796, #2587). Each landed a slice; this umbrella tracks the remaining tail so it
can be sliced and burned down deliberately rather than rediscovered ad hoc.

## Problem — recurring sub-patterns

1. **IteratorClose on abrupt completion** — when a destructuring step throws or
   an array pattern doesn't consume the whole iterator, `IteratorClose` must run
   the iterator's `return()`. Tests:
   `for-of/dstr/array-*-iter-*-close-*.js`, `array-elem-iter-nrml-close-err.js`.
   (Overlaps the open #1642 — for-of body-throw IteratorClose.)
2. **Default-init evaluation** — initializer evaluated **only** when the element
   is `undefined`, exactly once, with correct `initCount`/side-effect order.
   Tests: `*-ptrn-elem-id-init-skipped.js`, `*-dflt-*`.
3. **Elision / holes** — `[, , x]` must advance the iterator past elided slots
   without binding. Tests: `*-ary-ptrn-elem-ary-elision-*`.
4. **Rest element** `[...r]` / `{...r}` — must drain remaining iterator / copy
   remaining own-enumerable props; nested rest patterns.
5. **Generators as the iterated value** — eager-buffer over-consumption gives
   wrong yield/side-effect counts (open #2566).
6. **Function/method/arrow param patterns** — struct-field type mismatches and
   null-deref in param destructuring (open #1556).

Failure signatures: `assert.sameValue(initCount, 0)`, `throw new Test262Error()`
after a close assertion, `Cannot destructure 'null' or 'undefined'`,
`it.next is not a function`, null-deref in `test()`.

## Failing-test cluster (examples)

> **2026-06-26 re-sweep (current `origin/main`, post-#2692).** 2 of the 6 below
> now PASS and are struck through; the remaining 4 are all **iterator-protocol
> semantic gaps** routed to #1642 (IteratorClose) / #2566 (generator
> over-consumption) — NOT the codegen-default family. See "## Slice landed".

```
language/statements/for-of/dstr/array-elem-iter-nrml-close-err.js            # FAIL — IteratorClose (#1642)
# PASS (#2692): language/statements/for-of/dstr/let-obj-ptrn-prop-id-init-skipped.js
# PASS (this slice): language/statements/for-of/dstr/const-ary-ptrn-elem-ary-elem-init.js
language/expressions/assignment/dstr/array-elem-trlg-iter-elision-iter-abpt.js  # FAIL — trailing-elision over-consumption (#2566)
language/expressions/object/dstr/meth-ary-ptrn-elem-ary-elision-init.js      # FAIL — generator over-consumption (#2566)
language/statements/class/dstr/private-meth-ary-ptrn-elem-ary-elision-init.js  # FAIL — generator over-consumption (#2566)
```

## Acceptance criteria

- Net reduction of the destructuring `/dstr/` failing set by **≥ 400 tests**
  across the sub-clusters above (umbrella target; slices below ship individually).
- IteratorClose runs on abrupt completion and on partial consumption.
- Default initializers evaluate iff element is `undefined`, exactly once.
- Elisions advance the iterator without binding; rest elements drain correctly.
- No regression in currently-passing destructuring tests.

## Slicing plan (route to architect for the iterator-protocol slice)

- **Slice A — IteratorClose / abrupt-completion** (folds in open #1642). hard.
- **Slice B — default-init evaluation + elision/hole iteration** (medium).
- **Slice C — generator-as-source over-consumption** (open #2566). medium.
- **Slice D — param-pattern struct-field type mismatch** (open #1556). medium.

Keep #1642, #2566, #1556 as the concrete sub-issues; this umbrella tracks the
aggregate and the remaining un-issued tail (binding patterns, object-method
params, arrow params).

## Verify-first investigation (sd-dstr, 2026-06-26) — premise correction

Branched off `upstream/main` @ `51134ae24`; fetched baseline jsonl; reproduced
samples with **fresh single-file processes** (not in-process batch).

### Verified fail count (path-based, `/dstr/` + `destructuring`)
**1499 non-pass** (not ~696): `fail` 1427, `compile_timeout` 56, `compile_error`
16. The ~696 in the title was a feature-tag-filtered subset; the path-based count
is ~2× larger. By pattern kind from the test basename: ARRAY-pattern 1043,
OBJECT-pattern 208, neither/other 247, mixed-nested 1.

### KEY FINDING — the binding-pattern codegen is already CORRECT
Minimal fresh-process probes (via `runTest262File` harness, both strict modes):

| probe | result |
|-------|--------|
| `let [a=7,b=9]=[undefined,undefined]` (default FIRES) | **pass** |
| `let [a=7,b=9]=[1,2]` (default SKIP) | **pass** |
| `var c=0;function k(){c+=1;return 5} let [a=k()]=[undefined]; assert c==1` | **pass** |
| `let [a,...r]=[1,2,3]` (rest) | **pass** |
| `let [,a,,b]=[1,2,3,4]` (elision) | **pass** |

So array default-init / rest / elision / value-present / value-skip lowering is
spec-correct. The umbrella's premise ("default-init / holes / rest binding-pattern
codegen is broken") is **largely wrong** for the WasmGC host path.

### ROOT CAUSE of the dominant failure cluster — closure-capture box lazy-init
The standard test262 dstr template declares a **captured counter**:
`var initCount=0; function counter(){ initCount += 1 }`. `initCount` is captured
& mutated by a nested function, so it is boxed into a ref cell
(`$__ref_cell_f64`). The box (`struct.new` + `local.tee __boxed_initCount`) is
materialized **lazily at the first call site** of `counter`, in
`src/codegen/expressions/calls.ts` (the `nestedFuncCaptures` mutable-capture
branch, ~L12359–12383): it does `local.get <outer>; struct.new <refCell>;
local.tee <box>` and then re-aims `localMap[name]` to the box for **all**
subsequent reads/writes.

The bug: that `struct.new` is emitted into **whatever body buffer is active**,
which for a destructuring default is the conditional `then`-branch of the
`__extern_is_undefined` / sNaN check (`emitDefaultValueCheck`,
`src/codegen/statements/destructuring.ts`). When the element is present the
default arm does **not** execute at runtime → the box is never created → it
stays `ref.null` → every later read of the captured var (incl. the test's final
`assert.sameValue(initCount, 0)` and even plain value reads) dereferences a null
ref cell and yields the sNaN→`NaN` sentinel. Test fails.

**This is NOT destructuring-specific.** Confirmed minimal repro with a plain
conditional, no destructuring at all:
```ts
export function test(): number {
  var c = 0;
  function k() { c += 1; }
  if (c > 100) { k(); }   // not-taken branch — only call site to k
  return c;               // reads through the never-created box → NaN
}
// returns NaN, should return 0
```
The dstr default-init tests are simply the **largest surface** of a general
closure ref-cell materialization defect: *a mutable captured variable's box is
created lazily at the first capturing call site; when that site is a
conditionally-skipped branch, the box is never created and all reads corrupt.*

### Fix direction (and why it needs care — prior regressions)
Correct fix: materialize the box **eagerly at the variable's declaration** (or at
the nested-function-declaration point, which is where `ctx.nestedFuncCaptures` is
populated — `src/codegen/statements/nested-declarations.ts:764`), unconditionally,
so `localMap`/`boxedCaptures` re-aim and the box exist before any conditional use;
the call site then just `local.get`s the existing box. **This is the exact area
that regressed before** — the in-code comments at calls.ts:12361 document
#1177 Stage 1 (the `localMap.get ?? outerLocalIdx` attempt) causing **100+
test262 regressions**, and PR#166 a type-only guard causing **net −25 / 33
wasm-change regressions**. Hoisting interacts with `var`/function hoisting order
and per-iteration `for`-let box identity (closures.ts:1699–1705). So this needs
an architect spec + full `merge_group` validation, not an inline patch.

### Recommendation
- This is a **distinct, high-value, independent** (NOT substrate-gated) codegen
  root cause — recommend carving a **dedicated issue** (closure-capture box
  eager-materialization) via `claim-issue.mjs --allocate`, routed through
  architect given the #1177/#PR166 regression history. It likely unblocks a
  large fraction of the 1499 (every dstr test using the captured-counter
  template, plus general closure correctness).
- The genuinely destructuring-specific residual buckets remain the existing open
  sub-issues: **#1642** (for-of IteratorClose on abrupt completion, ~129
  iterator-protocol sigs), **#2566** (generator-as-source eager-buffer
  over-consumption — e.g. `let [[,]=g()]=[]` over-runs the generator), **#1556**
  (param-pattern struct-field type mismatch, ~153 null-deref sigs).
- Umbrella Slice B ("default-init evaluation + elision/hole iteration") should be
  **closed as already-correct** for the host path per the probes above; its
  apparent failures are the closure-box bug.

Repro driver + probes used: `.tmp/runsrc.mts`, `.tmp/runwasm.mts` (gitignored).

## Slice landed (dev-dstr2669, 2026-06-26) — nested-array-default codegen family

Verify-first re-sweep of the 6-sample cluster on current `origin/main` (post-#2692):
**2 PASS, 4 FAIL**. The single `let-obj-ptrn-prop-id-init-skipped` was already
fixed by #2692 (the closure-box surface). The verify-first sweep then root-caused
the `const-ary-ptrn-elem-ary-elem-init` failure to **three distinct codegen
defects** in the array-destructuring *default-init* family (NOT the closure box,
NOT an iterator-protocol gap) — all fixed in this slice with guard test
`tests/issue-2669.test.ts` (9/9 green):

1. **Malformed Wasm — `extern.convert_any` on an already-externref `array.get`.**
   A `ref_*` keyed vec (nested arrays/objects, e.g. `number[][]`) lowers its
   backing store to `(array (mut externref))` — its elements are *already*
   externref. The element-conversion loop in `destructureParamArray`
   (`src/codegen/destructuring-params.ts`, `boxToExternref`) and the host-boundary
   `__vec_get` helper (`src/codegen/index.ts`) keyed off the `"ref_*"` STRING and
   emitted `extern.convert_any` (operand must be `anyref`) on the externref slot →
   invalid Wasm, module failed to instantiate (`const [[x,y,z]=[4,5,6]] = []`).
   Fix: decide boxing from the **real backing-array element kind** — an externref
   store is a straight pass-through.
2. **for-of identifier default never fired (externref source).** A for-of element
   with a default over an externref source was coerced to the (numeric) binding
   type BEFORE the default check (`src/codegen/statements/loops.ts`), unboxing
   `undefined` to a plain NaN that never matched the f64 sNaN sentinel the check
   looks for (`for (const [a=9] of [[]])` kept NaN). Fix: run
   `emitDefaultValueCheck` on the RAW externref (`__extern_is_undefined`), then
   coerce the survivor.
3. **for-of nested-pattern default ignored.** The for-of nested-pattern branch
   dropped `element.initializer` entirely, so a short/empty source left the nested
   slot null and the recursive destructure threw "Cannot destructure 'null' or
   'undefined'" (`for (const [[x,y,z]=[4,5,6]] of [[]])`). Fix: apply
   `emitNestedBindingDefault` (with the externref OOB→undefined sentinel) before
   recursing — **scoped to the SYNC for-of path AND PURE (non-call) default
   initializers** (array/object literals, identifiers). See the CI-FIX note below.

### CI-FIX (merge_group floor) — scope narrowed (2026-06-26)

The first cut of fix #3 applied the nested default for **all** initializers in
**both** for-of and for-await. The #2097 merge_group floor (full test262, not the
scoped sweep) flagged **15 `for-await-of` regressions** (`async-{func,gen}-dstr-…
ary-ptrn-elem-ary-elision-{init,iter}` + 3 `…ary-empty-init` flake timeouts): a
**CALL-expression** default (generator `g()`, capturing helper, IIFE) compiled
inside the conditionally-skipped default arm materialised its capture box **only
on the not-taken branch**, corrupting later reads of the captured variable
(#2692 closure-box-lazy territory; the generator case also over-consumes,
#2566). On clean main fix #3 didn't exist so those defaults were ignored and the
tests passed by coincidence (the element was present, so the default must not
fire anyway). Net was +9 but the regression **ratio** (12/24 = 50%) tripped the
gate. Fix: gate the nested-default application to `!stmt.awaitModifier &&
!ts.isCallExpression(initializer)`. Pure literal/identifier defaults have no side
effect or capture box, so they are safe to evaluate conditionally; call-default
nested cases (and all for-await nested defaults) revert byte-for-byte to the
pre-fix behaviour and stay tracked under the umbrella tail (#2566 / #2692).
Result: all 15 for-await regressions cleared, 12 sync improvements retained
(`ary-elem-init`, `ary-rest-init`, `obj-id-init`, `obj-prop-id-init`),
`ary-empty-init` (IIFE default) deliberately forgone. Guard
`tests/issue-2669.test.ts` extended with the capturing-call present-element
poison signature.

**Validation:** 10/10 guard tests; `hardError=0` across 1781 dstr files (no new
malformed-Wasm); all 15 floor-regressed `for-await-of` tests verified back to
PASS via fresh single-file runs; 12 sync improvements re-verified PASS.

**Remaining umbrella tail (NOT this slice):**
- The 4 still-failing cluster samples are iterator-protocol semantics → **#1642**
  (IteratorClose on abrupt completion) and **#2566** (generator / trailing-elision
  over-consumption). Keep those as the concrete sub-issues.
- A separate **in-bounds `undefined`/hole** default-init sub-bug remains: a literal
  `undefined`/elision element of a *typed* nested vec is not carried as a
  recognizable "undefined" through the default check (`for (let [x=23] of
  [[undefined]])` / `[[,]]` → `x` stays the value, default never fires;
  `[a=1,b,c=3] = [..., , undefined]` assignment likewise). Distinct from the three
  fixes above (those are the externref/OOB and malformed-Wasm paths); the typed
  in-bounds sentinel-propagation is the next carve.
- The nested **object**-default (`[{a}={a:1}]`) over an empty/externref source also
  still mis-binds — same default-init family, follow-up carve.

This slice keeps the umbrella OPEN (status stays `ready`) — it burns down the
nested-array-default codegen corner, not the iterator-protocol tail.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — broad umbrella. The referencing PR landed the nested-array default-init codegen family (3 defects). The umbrella stays OPEN: iterator-close, defaults, holes, rest across for-of / assignment / binding / params (~696 fails) need further concrete slices carved.

## CARVE (sd-dstr-objdefault, 2026-06-28) — verify-first re-sweep on current main (#2201)

Re-swept the **1745** non-pass `/dstr/` tests from the fresh s67 baseline against
current `origin/main` (#2201). Three prior sub-issues are **done** (#1642
IteratorClose, #1556 param struct, #2692 closure-box var/param), one **blocked**
(#2566 generator over-consume, blocked_by #2662 eager-buffer host generator). The
umbrella's earlier "dominant cluster = closure-box" premise is now mostly resolved
by #2692. Partition of the residual:

- **~871** use a **generator source/default** (`function* g()` / `yield` in the
  destructured value) → **#2566** (blocked on #2662). NOT carved.
- **~358** use a **custom iterable** (`obj[Symbol.iterator]` → `{next,return}`),
  signature `it.next is not a function` / `-iter-no-close` / `-iter-close`. Correct
  no-over-consume semantics need **lazy iterator stepping** → shares the **#2662 /
  #2566** blocker. NOT carved as a ready dev slice (substrate-gated); tracked here.
- **~516** plain array/obj source → **clean, non-blocked codegen slices**, carved:

| sub-issue | 1-line | est. recover |
|-----------|--------|-------------|
| **#2756** (taken: sd-dstr-objdefault) | array-pattern identifier element with an **object-literal / class-expression default** null-derefs (`[c={a:1}]=[]` traps; the `fn-name-class` family). Array-literal & object-*pattern* defaults already work. | **~120–180** |
| **#2757** | **assignment**-destructuring (`expressions/assignment/dstr/`) rest element + undefined/hole binds wrong value / "array too large" trap. Independent file. | **~40–60** |
| **#2758** | object/array-pattern **default-init side-effect on init-skipped** (`obj-ptrn-id-init-skipped`: present falsy values fire the default / corrupt `initCount`). Closure-box param-path residual — **route architect** (#1177/#2692 regression history). | **~40–96** |

Independence: #2756 = `statements/destructuring.ts` default arm; #2757 =
`expressions/*` assignment lowering; #2758 = `destructuring-params.ts` + `calls.ts`
closure-box. Different files → safe to parallelize. #2756 and #2758 both touch the
default-init concept but in **different files/paths** (binding default arm vs param
closure-box) — mild care, not a hard serialize. The custom-iterable (~358) and
generator (~871) tails stay under #2566/#2662.

**Update (#2756 landed, 2026-06-28):** the largest clean slice **#2756**
(array-pattern object/class default null-deref + the `fn-name-class` NamedEvaluation
cluster) is **done** — recovers the binding/function/method/generator/async/
for-await `fn-name-class` family. #2757 / #2758 remain ready/architect.

## Carve (2026-06-28) — typed in-bounds undefined/hole for-of default → #2769 (architect)

The **typed in-bounds `undefined`/hole default-init** slice (`for (const [x = 23]
of [[undefined]])` / `[[,]]` — default never fires because the iterable's inner
`undefined[]` lowers to `vec_i32` and `undefined` is lost as i32 `0` at
construction) is carved to **#2769** and routed to **architect**. A dev attempt
(PR #2226) was closed: widening `undefined[]`→externref in `resolveWasmType` is
GLOBAL (type-deterministic) so it broke array construction (`array.new_fixed`
i32.const) + i32/f64 consumers (`.length`/`sort`/`reduceRight`/`for-in`) — +35
wins and −5 regressions are inseparable in that approach; the correct fix is
representation-level. Key asymmetry captured in #2769: the identical **binding**
pattern already passes (TS infers a TUPLE → f64 sNaN sentinel), only the **for-of**
ARRAY-typed path fails. The #2216 nested-array-default slice stays done. Umbrella
remains OPEN/`ready` — #2757 (assignment-rest) and #2758 (init-skipped side-effect)
remain dev/architect-tractable.
