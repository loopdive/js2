---
id: 6773
title: "ES2015 standalone: Iterator.prototype.{chunks,windows,join} residue (21 rows) — class-instance source admission, §7.4.4 result check, helper `.return()` forwarding, %IteratorHelperPrototype% identity, `new <undefined>` IsConstructor, `join` as a value"
status: done
completed: 2026-10-02
assignee: ttraenkler/opus-6773
sprint: current
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-6773
related: [5147, 2903, 3100, 3119, 3146, 5131, 5144, 5254, 6484, 6492, 6612, 6617, 6630, 6651, 3249, 3484]
loc-budget-allow:
  # 2026-09-30 (#6773 plan): four at-ceiling files each grow by one arm or one
  # helper — the §7.4.4 result check + `__iter_return_result` + the
  # getter-aware USER close (iterator-native.ts), the `.return()` carrier arm
  # (closed-method-dispatch.ts), three seeded members on %IteratorPrototype%
  # (array-object-proto.ts), and one finalize call (index.ts). The bulk of the
  # new code (helper-proto singleton, predicate, close semantics) lands in
  # iter-lazy-native.ts / iter-hof-native.ts / object-runtime-prototype.ts,
  # all under the 1,500 threshold today (1249 / 933 / 990).
  - src/codegen/iterator-native.ts
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/index.ts
func-budget-allow:
  # 2026-09-30 (#6773 plan): each over-limit function gains one arm in the
  # same one-function ladder shape it already has (S1 open arm, S2 result
  # check, S3 close arm + return-result mint, S3 dispatcher arm, S4 getPrototypeOf
  # arm). `fillIterHofSteppers` / `buildIteratorReturnBody` are listed
  # defensively — they sit near the 300 ceiling and S1/S3 add ~20 lines each.
  - src/codegen/iterator-native.ts::buildIteratorNextBody
  - src/codegen/iterator-native.ts::buildIteratorReturnBody
  - src/codegen/iterator-native.ts::fillNativeIteratorLateArms
  - src/codegen/iter-lazy-native.ts::ensureLazyStepper
  - src/codegen/iter-hof-native.ts::fillIterHofSteppers
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  - src/codegen/index.ts::generateModule
  # 2026-09-30 (#6773 S3, opus-6773): one line — the standalone
  # `__call_get_return` accessor dispatcher (`emitMethodDispatch("get_return",
  # …)`) next to the `__call_return` method one, for the getter-aware USER
  # IteratorClose; the function sits exactly at its 622 ceiling.
  - src/codegen/index.ts::emitIteratorMethodExport
---

# #6773 — ES2015 standalone: `Iterator.prototype.{chunks,windows,join}` residue (21 rows)

## Problem

21 rows under `built-ins/Iterator/prototype/{chunks,windows,join}` are counted
in the ES2015 standalone bucket (see the classification note below) and all
21 fail. Measured on `origin/main` `2ef807a68e` (2026-09-30) with
`flock /tmp/claude-0/t262.lock npx tsx scripts/run-test262-paths.mts
.tmp/6773/rows.txt --isolate --standalone` → `{ fail: 21 }`
(`.tmp/6773/base-verdicts.txt`); the promoted standalone baseline
(`.test262-cache/test262-standalone-current.jsonl`, 2026-09-30 18:49, sha
`dd38a24abf`) agrees row for row. `chunks`/`windows` themselves exist natively
(#5147, `src/codegen/iter-lazy-native.ts` kinds 5/6); every failure is
protocol-level. The same 45 sibling rows under `{map,filter,take,drop,flatMap}`
(ES2025, not in this bucket) fail with byte-identical signatures
(`.tmp/6773/sibling-rows.txt`), so every step below is kind-agnostic and
those rows are expected collateral gains.

The whole family is 78 rows (chunks 38 + windows 40): 36 pass today and must
stay green; 42 fail, of which these 21 carry an ES2015 tag.

### Rows by mechanism (21)

| # | Mechanism (measured cause) | Rows | Base signature |
| --- | --- | --- | --- |
| A | A `class X extends Iterator` instance is never admitted as the helper's source: `__iter_hof_open` answers the null sentinel, so the wrapper is empty and the class's `next()` is never called | `{chunks,windows}/next-method-throws`, `next-method-returns-throwing-value`, `next-method-returns-throwing-done` (6) — and a prerequisite of B, C | `Expected a Test262Error to be thrown but no exception was thrown at all` |
| B | §7.4.4 IteratorNext step 3 — a non-Object `next()` result must throw TypeError; the USER step arm degrades it to `done` instead | `{chunks,windows}/next-method-returns-non-object` (2) | `Expected a TypeError … no exception` |
| C | `helper.return()` does not exist on the `$LazyIterHelper` wrapper (the dispatcher has a `.next()` carrier arm, #5147, but no `.return()` one), so IteratorClose is never forwarded, never once-only, and never suppressed after exhaustion; a class GETTER named `return` is not consulted by the USER close | `{chunks,windows}/get-return-method-throws`, `iterator-return-method-throws`, `return-is-forwarded-to-underlying-iterator`, `return-is-not-forwarded-after-exhaustion` (8) | `TypeError: called value is not a function` / `Expected a Test262Error but got a TypeError` |
| D | The wrapper has no `[[Prototype]]`: `Object.getPrototypeOf(w) === null`, so `w instanceof Iterator` is false | `{chunks,windows}/result-is-iterator` (2) | `… must return an Iterator` |
| E | `new iter.chunks(1)` where the member read yields the canonical `undefined` singleton constructs an object instead of throwing (`new o.nope(1)` no-throw; `new u(1)` with a stored `undefined` literal throws) | `{chunks,windows}/non-constructible` (2) | `Expected a TypeError … no exception` |
| F | `Iterator.prototype.join` reads as `undefined` (the root `%IteratorPrototype%` singleton owns only `[Symbol.iterator]`, and `join` is not an `Iterator` glue member) | `join/not-a-constructor` (1) | `isConstructor invoked with a non-function value` |

Probe evidence (all in `.tmp/6773/`, run with `npx tsx .tmp/6773/probe.mts <file…>`
from the worktree — the runner returns `__r` char-by-char through `rlen`/`rat`
exports because standalone strings are `$NativeString` structs):

- `p1-admission-A/B.js`, `p10-admission-C.js`: `.chunks(1).next()` and
  `.map(fn).next()` on a `class T extends Iterator` whose `next()` throws
  answer `{done: true}` — with or without a `{value, done}` literal in the
  module, with or without `[Symbol.iterator]` on the class (A).
- `p13-admission-D.js`: the closed `.next()` dispatch on the same instance works
  (`T.dyn-next: object done=false value=1`), `T.toArray()` throws `called value
  is not a function`, and **every ladder consumer yields nothing**: `[...new
  T()]` → 0, `Array.from(anyT)` → 0, `for…of` → 0 iterations.
- `p15a/b`, `p16a–f`, `p17a–c`: the identical class-iterator program iterates
  correctly (`k=2, len=2, calls=3`) until the module contains ONE dynamic
  `Object.getPrototypeOf(<any-typed object>)` (`p17a`: `Object.getPrototypeOf(id({}))`
  alone) — then `for…of` throws `iterator result is not an object`, spread
  gives `len=0`, and the class's `next()` is invoked **zero** times. The runner
  injects exactly such a call into every row that names `Iterator`
  (`Iterator.prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))`,
  `scripts/test262-iterator-binding.mjs:44-59`, wired at
  `tests/test262-runner.ts:2315-2326`). Mechanism, from the source: that call
  compiles through `tryEmitDynamicCallableGetPrototypeOf`
  (`src/codegen/expressions/object-get-prototype-of.ts:596`), which
  materialises `%Function.prototype%` and thereby bootstraps the object runtime
  (#6630's documented side effect); with the object runtime present, the
  GetIterator ladder's OBJ arm (`iterator-native.ts:4055`, `objArm`) runs
  before the USER tail and its unguarded "(#3146) next-property fallback"
  (`iterator-native.ts:4124-4145`) claims a closed class instance because
  `__extern_get(inst, "next")` answers the class method (truthy, `p14`:
  `nextFn=function`) — but the OBJ *step* (`__forof_next_method` /
  `buildIteratorNextBody`'s OBJ arm) reads `next` carrier-branched
  (`objCarrierTest ? __extern_get : __sget_next`) and misses on the
  non-`$Object` carrier, so the step applies `undefined` and reports a
  non-object / done. `__iter_hof_open` (`iter-hof-native.ts:797-806`) reaches
  the same ladder, which is why the helper's source is empty (A).
- `p6-getter-return.js`: a dynamic `any.return` read on a class instance DOES
  invoke a class getter (`dyn-read: threw GETTER`) — via the compile-time
  member-get dispatcher, not via `__extern_get`.
- `p12-member-new.js`: `new iter.chunks(1)` / `new o.nope(1)` / `new
  (class{}).nope(1)` / `new Iterator.chunks(1)` → no throw; `new u(1)` (`var u =
  undefined`), `new o2.nope(1)` (`{nope: undefined}`), `new iter.next()` → TypeError (E).
- `p3-instanceof.js`: `gpo(chunks) === null`, `chunks instanceof Iterator = false` (D).
- `p4-join.js`: `typeof Iterator.prototype.join = undefined`,
  `isC(Array.prototype.join) = false` (a native-proto method closure is already
  non-constructible for `Reflect.construct`), `new [].values().join()` → TypeError (F).
- `p5-return.js`: `typeof it.return = undefined`, `it.return()` → `called value
  is not a function` (C).

## Classification note (record only — no classifier change in this issue)

`scripts/generate-editions.ts` `classifyEdition` (L497-515) has no `es5id`/`es6id`
for these rows, so it takes priority 3: the maximum `FEATURE_EDITION` year over
`features:`. `iterator-chunking` and `Iterator.prototype.join` are **absent**
from `FEATURE_EDITION` (L63-…; only `"iterator-helpers": 2025` L272 and
`"iterator-sequencing": 2026` L294 exist for this family), so the maximum is
taken from the co-tags: `generators: 2015` (L67), `class: 2015` (L69), and for
`join/not-a-constructor.js` `"Reflect.construct": 2015` (L98) → **2015**. The
runner's `PROPOSAL_FEATURES` (`tests/test262-runner.ts:272`) lists only
`import-defer` / `source-phase-imports`, so the rows run and score.

Upstream `test262/features.txt` lists `iterator-chunking` under
**"Standard language features"** (line 152) — a published edition, not a
proposal — and `Iterator.prototype.join` under **"Proposed language features"**
("Iterator Join", `https://github.com/tc39/proposal-iterator-join`, line 78).
A correction would be one `FEATURE_EDITION` entry
(`"iterator-chunking": <year of the edition that finished it — check
tc39/proposals finished-proposals.md, as L285-294 does for ES2026>`), and for
`Iterator.prototype.join` either a proposal tag (`PROPOSAL_FEATURE_TAGS` L613 +
runner `PROPOSAL_FEATURES`, which would also make the runner SKIP the 18
`join/**` rows) or a draft-edition entry. Effect: these 21 rows leave ES2015
(denominator 11,704 → 11,683, the arithmetic #6651 L1892-1905 already records),
`scripts/test262-edition-ratchet-baseline.json`'s ES2015 `total` changes (a
hand-reviewed edit, since `--update` never lowers a number), and the other 21
non-ES2015-tagged `chunks/windows` failures stay where they are. This is a
project-lead decision; the plan below fixes the rows where they are counted
today.

## Implementation Plan (2026-09-30, Fable lane; Opus implements)

Order: S1 → S2 → S3 → S4 → S5 → S6 → S7. S1 is the prerequisite of S2/S3 (their
rows need the class instance to be the live source). S4/S5/S6 are independent
of each other and of S1–S3. Every step is measured on its rows before the next
starts (Step 0 keeps the base copies for that).

### Step 0 — base copies and the before-state

- `mkdir -p .tmp/6773/base-src && cp src/codegen/{iter-lazy-native,iter-hof-native,iterator-native,closed-method-dispatch,object-runtime-prototype,array-object-proto,construct-is-constructor-guard}.ts .tmp/6773/base-src/`
  (A/B by file copy, never `git stash`).
- Re-run the 21 rows + the 45 siblings once on the fork point
  (`.tmp/6773/all-rows.txt`) and keep the log; expect `{ fail: 66 }`.
- Keep the probes: `p13` (admission), `p5` (return), `p3` (instanceof), `p12`
  (member-new), `p4` (join), `p17c`/`p17a` (the ladder control pair).

### S1 — a closed class instance is a live helper source (GetIteratorDirect) — 6 rows + prerequisite of B/C

**Rows:** `{chunks,windows}/next-method-throws`, `next-method-returns-throwing-value`,
`next-method-returns-throwing-done`.

**Where:** `src/codegen/iter-hof-native.ts` `fillIterHofSteppers` (L570), the
`openFn` arm builder (L732-810).

**Change (a) — mint the record directly, never through `__iterator`.** For every
type in `collectIterableStructTypeIdxs(ctx)` (L530-548: structs with a
`<Struct>_next` or `<Struct>_@@iterator` funcMap entry — class instances with a
compiled `next` method), replace the current `call __iterator` arm
(L797-806) by a direct §7.4.2 GetIteratorDirect record:

```wasm
;; open(recv): recv is a closed struct whose `next` the closed dispatcher can drive
local.get $any  ref.test $T
if
  i32.const 1                 ;; ITER_KIND_USER
  ref.null $Vec               ;; vec
  i32.const 0                 ;; idx
  local.get 0                 ;; userIter = recv (NOT the result of @@iterator)
  i32.const 0                 ;; ITER_FAMILY_UNKNOWN (5th field, #6484 S1)
  struct.new $__IterRec
  extern.convert_any
  return
end
```

Read `__IterRec`'s type index from `ctx.structMap.get("__IterRec")` (the
record type is registered by `ensureNativeIteratorRuntime`, which
`reserveIterHofSteppers` already calls) and mirror the operand order used at
`iterator-native.ts:4270-4276`; export the tiny operand-list builder from
iterator-native.ts rather than restating five constants (the `family` field
is load-bearing, #6484 S1). This is the spec behaviour for
`%Iterator.prototype%.chunks` (GetIteratorDirect reads `next` off `this`, it
never calls `@@iterator`) and it sidesteps the poisoned OBJ arm described in
the Problem section entirely. Keep the canonical-vec arm exactly as it is.

**Change (b) — relax the admission gate.** `userArmAvailable` (L699-704)
demands `__call_@@iterator`, `__sget_value` and `__sget_done`; the ladder's
own USER deps (`fillNativeIteratorLateArms`, `iterator-native.ts:2629-2650`)
require only `__call_next` and `__is_truthy` (the getters are optional since
#3146/#4447). Use the same two-symbol gate here. Rationale measured in
`p1-admission-A/B`: the rows' modules often have no `{value, done}` closed
struct at all (`next()` throws, or its result has an accessor), so the stricter
gate excluded exactly these classes.

**Why the step then works:** `__iter_hof_next(rec)` falls through to
`__iterator_next` (L861-863) whose USER arm calls `__call_next(userIter)`
(`iterator-native.ts:5885-5889`) — the closed dispatcher that `p13` shows
working — and reads the result carrier-branched: a closed `{done, value}`
literal through `__sget_done`/`__sget_value` (`userReadStructArm` L5836),
an open object with accessors through `__extern_get` (`userReadObjArm`), so a
throwing `done`/`value` getter propagates. A throwing `next()` propagates
through `__lazy_iter_step` untouched (no `try` on that path; a throw must NOT
trigger IteratorClose — the rows' `get return()` throws a *different* error
class to catch exactly that).

**Ordering / risk:** `fillIterHofSteppers` runs after `fillNativeIteratorLateArms`
(index.ts L6241-6247 / L11490-11492) — unchanged. The arm only fires for
receivers the ladder previously either refused (null sentinel → empty helper)
or, in a poisoned module, mis-drove; a receiver that already worked (generator
frame, `$__IterRec`, lazy wrapper, canonical vec) is matched by an earlier arm.
ES5: no ES5 row reaches `__iter_hof_open` (no iterator helpers in ES5).

**Acceptance:** the 6 rows pass; `p13` prints `T.map-next: done=false value=1`;
the 36 passing `chunks/windows` rows stay green; `tests/issue-2903-r3.test.ts`,
`tests/issue-2903-r4*.test.ts` unchanged.

### S2 — §7.4.4 step 3: a non-Object `next()` result throws TypeError — 2 rows

**Rows:** `{chunks,windows}/next-method-returns-non-object`.

**Where:** `src/codegen/iterator-native.ts` `buildIteratorNextBody` (L4848),
the USER step `userStep` (L5885-5896).

**Change:** immediately after `res = __call_next(userIter)` (`local.set 6`), and
before the carrier-branched read, splice `local.get 6` followed by the existing
#5144 helper — `notAnObjectThrowInstrs(ctx, 6)` (L3740; it CONSUMES the
externref on top of the stack, message `"iterator result is not an object"`,
shared string global) — reusing local 6 (`res`) as its scratch (the helper
stores the stack value into the scratch and re-reads it, so passing the same
local is a no-op store). The helper needs
`ctx` at build time; `buildIteratorNextBody` already receives `strictCtx`
for the strict variant — pass `ctx` through the existing `strictCtx` slot from
the non-strict call site at L3003-3015 (it is only read for the strict
dispatch when `strictProtocol` is true, so passing it always is safe), or add
one optional trailing parameter. Apply to the USER arm only. Do NOT touch the
OBJ arm: `forof-iterator-step.ts:16-31` documents that its falsy→done
degradation is load-bearing for the GetIteratorFlattenable bridge; the for-of
statement already has its own strict OBJ step (#6651 G4), which is why
`language/statements/for-of/iterator-next-result-type.js` passes today.

`__typeof_object` answers 1 for any closed struct (only boxed primitives,
closures and `$Symbol` are excluded — `typeof-natives-finalize.ts:353-372`),
so a closed `{done, value}` literal is never mis-rejected; `null`
(`ref.null.extern`) and the canonical `undefined` singleton fail
`__typeof_object ∧ __is_truthy` and throw, which is the spec answer.

**Ordering / risk:** the USER arm is reached by for-of / spread / `Array.from` /
destructuring over closed class iterators as well. A class `next()` that
returns a primitive or `null` is a spec TypeError everywhere, so the only
behavioural change is silent-done → TypeError. ES5 has no user iterators.
Pins: `language/statements/for-of/**` (182), `language/expressions/call/spread-err-*.js`
(16), `built-ins/Array/from/**` (47), `tests/issue-5131-es2015-strict-spread-iterator.test.ts`,
`tests/issue-6651-g4-forof-step-protocol.test.ts`, `tests/issue-3100-s5.test.ts`.

### S3 — `helper.return()`: forwarded once, not after exhaustion, getter-aware — 8 rows

**Rows:** `{chunks,windows}/get-return-method-throws`, `iterator-return-method-throws`,
`return-is-forwarded-to-underlying-iterator`, `return-is-not-forwarded-after-exhaustion`.

Spec: `%IteratorHelperPrototype%.return` (§27.1.2.1.2) — if the helper is
`suspended-start`, set it `completed` FIRST, then IteratorClose the underlying;
if `completed`, return `{undefined, true}` without touching the underlying; a
helper becomes `completed` when its underlying reports `done` or when a step
throws. IteratorClose (§7.4.9) does `GetMethod(iterator, "return")` — a getter
is invoked, and its throw propagates.

**(a) The wrapper's close, in `src/codegen/iter-lazy-native.ts`
`ensureLazyStepper`, `__lazy_iter_close` (L956-984):**

```wasm
;; __lazy_iter_close(helperExt)
helper = cast(any.convert_extern(p0))
if (helper.flags & 1) return            ;; completed ⇒ no forwarding (§27.1.2.1.2 step 5)
helper.flags |= 1                       ;; completed BEFORE the close: a throwing return() leaves it completed
src = helper.src
if (src != null) call __iter_hof_close(src)   ;; unchanged tail
```

Field `flags` is `F_FLAGS = 5`, bit0 "exhausted" (#5147). Read the FIELD
(`struct.get`), not the `FLG` local — that local is loaded only in the
chunks/windows prologue.

**(b) A generic completed check in the step, `stepBody` (L876-931):** right after
the null-source check (L884-887) add `if (helper.flags & 1) → doneReturn`.
This makes `next()` after `return()` answer done for every kind (the
chunks/windows prologue check at L718-724 becomes redundant but harmless).

**(c) Mark exhaustion for every kind:** in `pullStep` (L504-511) set bit0 in the
`done` branch before `doneReturn` (a `markExhaustedField()` helper that
`struct.get`s/`i32.or`s/`struct.set`s the field — reuse it in `markExhausted`
L743-749); also in `takeArm`'s `st <= 0` branch (L575-584) after the close, so
a later `return()` does not close twice. chunks/windows already mark
(L778, L819).

**(d) `.return()` on the wrapper, `src/codegen/closed-method-dispatch.ts`
`fillClosedMethodDispatch`:** next to the #5147 `.next()` carrier arm
(L1072-1096) add the twin for `methodName === "return" && arity === 0`, testing
`$LazyIterHelper` ONLY (not `__IterRec` — array/collection records have no
observable `return`), calling a new `__iter_return_result(recv) -> externref`.
Register it in `src/codegen/iterator-native.ts` `ensureNativeIterResultObject`
next to `__iter_next_result` (L1740-1780) with the same "spill, then one call"
discipline:

```wasm
;; __iter_return_result(recv) -> externref
local.get 0  call __iterator_return          ;; → lazy prepend (fillLazyIterLadderArms L1235) → __lazy_iter_close
i32.const 1  <undefined externref>  call __iter_result_obj   ;; {value: undefined, done: true}
```

`__iter_result_obj` already canonicalises a done result's `value` to the
`undefined` singleton (L1697-1712). `closed-method-dispatch.ts` L443-445
reserves the lazy machinery whenever a lazy form is compiled; `.return()` on
an `any` receiver reserves `__call_m_return_0` through the ordinary path, and
the arm is gated on `ctx.funcMap.get("__iter_return_result")` exactly like the
`.next()` arm is gated on `__iter_next_result` — a module that never built a
wrapper emits nothing new.

**(e) Getter-aware USER close, `src/codegen/iterator-native.ts`
`buildIteratorReturnBody` (L3366), USER close (L3578-3603):** `__call_return`
dispatches METHODS only (`index.ts:8311`, entries are `<Struct>_return`). Add
an accessor dispatcher in `emitIteratorMethodExport` (`index.ts:7794`):
`emitMethodDispatch("get_return", "__call_get_return")` — class getters are
registered under the flat key `<Struct>_get_return` (`classMemberFuncKey`,
`class-member-keys.ts:47-73`; the `tryCompileStandaloneFnctorLazyMethodMiss`
site at `call-receiver-method.ts:672-684` already probes `<owner>_get_next`
the same way). Then in the USER close, before `__call_return`:

```wasm
;; GetMethod(userIter, "return") — accessor first
(if __call_get_return exists)
  local.get 2  call __call_get_return  local.tee 3      ;; getter's VALUE; a getter that throws propagates here
  call __is_truthy
  if
    local.get 3  local.get 2  <empty args vec>  call __apply_closure   ;; validateClose result (§7.4.9 step 9)
    return
  end
;; then the existing __call_return(userIter) method dispatch, drop
```

Pass `deps.callGetReturnIdx` through `UserCarrierDeps` (L344-380) from
`fillNativeIteratorLateArms` (`ctx.funcMap.get("__call_get_return")`). The
`ret` (3) local already exists when `objDeps` is set (L3125-3132); declare it
unconditionally. A struct with neither answers null from both dispatchers →
NormalCompletion (unchanged).

**Sequence check (return-is-not-forwarded-after-exhaustion, chunks(1)):** 1st
wrapper: `return()` → bit0 set → `__call_return` throws Test262Error ✓;
`next()` → (b) done, underlying untouched ✓; `return()` → bit0 → nothing ✓.
2nd wrapper: `next()` → underlying `{done: true}` → chunks arm marks bit0 ✓;
`return()` → nothing ✓. `return-is-forwarded` (chunks(2)): first `return()`
forwards (count 1), second is suppressed ✓. `get-return-method-throws`
(chunks(1)): `next()` reads `{done: false, value: 1}` → done=false (boolean
`done` fields are boxed by `emitStructFieldGetters`, `struct-field-exports.ts:305-316`,
so `__is_truthy` sees a real boolean) → chunk `[1]` yields ✓; `return()` → (a)
→ `__iter_hof_close` → `__iterator_return` → (e) getter throws ✓.

**Ordering / risk:** `__iterator_return` is the close of every for-of `break`,
destructuring and spread over closed class iterators; (e) only adds the
accessor lookup ahead of the method lookup, so a class with a `return` METHOD
is unchanged. `fillLazyIterLadderArms` must keep running after
`fillNativeIteratorLateArms` (index.ts L6254) so the prepend sees the rebuilt
`__iterator_return`. ES5: unreachable. Pins: `language/statements/for-of/**`
(the `iterator-close-*` rows), `tests/issue-3100-s5.test.ts`,
`tests/issue-3119.test.ts`, `tests/issue-2903-r3.test.ts`.

### S4 — the wrapper's `[[Prototype]]` is `%IteratorHelperPrototype%` → `instanceof Iterator` — 2 rows

**Rows:** `{chunks,windows}/result-is-iterator`.

How `instanceof` resolves here: `Iterator` is the runner's shim function, its
own `prototype` is the root `%IteratorPrototype%` singleton
(`__native_iterator_prototype`, `array-object-proto.ts:4325`), so
`__instanceof_dynamic` (`native-dynamic-instanceof.ts:441-462`) ends in
`__isPrototypeOf(root, wrapper)`, whose class-instance seed
(`object-runtime-prototype.ts:310-320`) asks `__getPrototypeOf(wrapper)` for the
first link. Today every non-`$Object` arm of `__getPrototypeOf` (L586-611)
declines for a `$LazyIterHelper` → null → false (`p3`). One arm fixes
`instanceof`, `isPrototypeOf` and `Object.getPrototypeOf(wrapper)` together.

**Where / how — mirror the #6651 R1 `%Array.prototype%` pattern
(`object-runtime-prototype.ts:235-271`):**

1. In `src/codegen/iter-lazy-native.ts` reserve two defined functions at the
   same point `gatherLazyDeps` registers the rest (append-only, reserve-then-fill):
   `__lazy_iter_is_helper(externref) -> i32` (body `i32.const 0`) and
   `__lazy_iter_helper_proto() -> externref` (body `ref.null.extern`). Fill both
   in `fillLazyIterLadderArms` (L1205): the predicate becomes
   `any.convert_extern; ref.test $LazyIterHelper`; the singleton becomes a
   lazily-initialised `mut externref` global `__native_iterator_helper_prototype`
   built like `emitIteratorPrototypeSingleton` (`array-object-proto.ts:4165`):
   `__new_plain_object`, own `@@toStringTag = "Iterator Helper"` (data property,
   flags `0x04`, symbol id 4 via `__box_symbol` — the same shape as L4198-4210),
   then `__object_setPrototypeOf(obj, <root>)`. Obtain the root by calling
   `emitIteratorPrototypeSingleton(ctx, scratchFctx, "Array")` once inside the
   init (its one-shot init links and creates `__native_iterator_prototype`,
   L4292-4300) and then `global.get` that root global
   (`ctx.builtinObjectGlobals.get("__native_iterator_prototype")`); if the
   dev prefers, factor the `rootInit` block of `emitIteratorRootPrototypeInit`
   (L4340-4360) into an exported `emitIteratorRootPrototypeValue` — either is
   fine, but do not mint a second root.
2. In `src/codegen/object-runtime-prototype.ts` add `lazyHelperGetPrototypeArm`
   next to `arrayGetPrototypeArm` (L235): `local.get 0; call __lazy_iter_is_helper;
   if → call __lazy_iter_helper_proto; local.tee $slot; ref.is_null; i32.eqz; if →
   local.get $slot; return` and splice it into the non-`$Object` `else` branch of
   `__getPrototypeOf` (L598-600) after the array arm, with its own scratch local
   appended after `arrayProtoLocal` (L271). Both helpers must be reserved before
   `buildObjectPrototypeHelpers` bakes the body, so reserve them from
   `ensureObjectRuntime`'s registration order the way `reserveArrayProtoSingleton`
   is (L262-266) — or, simpler and equivalent, reserve them unconditionally in
   `ensureNativeIteratorRuntime` (which `ensureObjectRuntime` reaches through
   `reserveNativeGeneratorProtocolLookup`'s neighbours) and read them by name
   here; a module that never builds a wrapper leaves the predicate at
   `i32.const 0`, so the arm is dead and the answer unchanged.
3. `object-proto-tostring-carriers.ts:123` already lists `$LazyIterHelper` as a
   declined carrier; leave it (the `@@toStringTag` seeded above is what the
   spec row for `toString` would read, out of scope here).

`%IteratorHelperPrototype%.next` / `.return` closures are NOT part of this step
(the rows only test the chain); note them as a follow-up.

**Ordering / risk:** the arm is behind a predicate that is 0 unless the module
built a wrapper; `isPrototypeOf`/`instanceof` for every other carrier are
byte-identical. ES5: `built-ins/Object/getPrototypeOf/**` and
`built-ins/Object/prototype/isPrototypeOf/**` pins (unchanged). Pins:
`tests/issue-6484-iterator-prototypes.test.ts`, `tests/issue-6612-dynamic-new-is-constructor.test.ts`.

### S5 — `new <undefined-from-a-missing-property>(…)` throws TypeError (§13.3.5.1 step 5) — 2 rows

**Rows:** `{chunks,windows}/non-constructible`. All three assertions of each row
end in `new <undefined>(1)`: `iter.chunks` on a generator, `Iterator.prototype.chunks`
on the root singleton, and `(class extends Iterator {}).chunks` (a STATIC read on
the class value, which inherits from the shim function) all read as `undefined`
today; after S6 the first two become real non-constructible closures (already
handled by the guard, `p12`: `new iter.next()` throws), the third still resolves
to `undefined` — so this step is required regardless of S6.

**Where:** `src/codegen/construct-is-constructor-guard.ts`
`constructIsConstructorGuard` (L128-171). Narrowing 1 (L157-160) fires the
throw only for a callee `__typeof_function` accepts; a missing-property read
answers the canonical `$undefined` singleton (`any-helpers.ts:122-129`,
`undefinedExternInstrs`), which is neither null nor a function, so the driver
falls into its ordinary tail (`native-construct.ts:402-412`) and constructs an
object (`p12`: `new o.nope(1)` no-throw).

**Change:** widen the condition to
`(isNullish ∨ isProvenPrimitive) ∨ (typeof_function ∧ ¬isConstructor)`, where
nullish = `ref.is_null` ∨ `__typeof_undefined`, and proven-primitive =
`__typeof_number ∨ __typeof_string ∨ __typeof_boolean ∨ __typeof_bigint`
(the same positive classifiers `native-dynamic-instanceof.ts:394-399` uses —
register them through `ensureLateImport` in `armConstructIsConstructorGuard`
alongside `ensureReflectIsConstructor`, BEFORE the call site spills its callee,
which is the #1839 discipline that function already follows). Keep narrowing 2
(runtime-eval marker) and the no-JS-host gate. Do not widen to "any non-function
object": an unclassifiable carrier keeps its previous result, exactly as the
module header's narrowing 1 argues.

**Ordering / risk — ES5 is `completed`:** `language/expressions/new/S11.2.2_A2.js`,
`S11.2.2_A3_T1-5.js`, `S11.2.2_A4_T1-5.js` (all pass today; `p12` shows `new u(1)`
and `new o2.nope(1)` already throw, so those rows go through a path the widening
does not change) — run all 59 rows of `language/expressions/new/**` as the ES5
pin; the standalone baseline has 57 of them passing and every one of those 57
must stay. Pin `tests/issue-6612-dynamic-new-is-constructor.test.ts`.

### S6 — `Iterator.prototype.join` (and `chunks`/`windows`) are function values — 1 row

**Row:** `join/not-a-constructor.js` (`isConstructor(Iterator.prototype.join)`
must be `false` — the read must be a function; then `new [].values().join()`
must throw).

**Where:** `src/codegen/array-object-proto.ts` `ITERATOR_PROTO_METHODS`
(L407-419) — add `"chunks"`, `"join"`, `"windows"` (alphabetical; `PROTO_METHOD_LENGTH`
default 1 is the spec `length` for all three: `join/length.js` verifies 1). And
`emitIteratorRootPrototypeInit` (L4315-4372): after the `@@iterator` own
property, seed the three names as own data properties (`writable: true,
enumerable: false, configurable: true`, flags `0x01 | 0x04`) whose value is
`ensureStandaloneNativeMethodClosure(ctx, brand, name, "method", { refusalBodyFallback: true })`
(`native-proto.ts:908`) pushed via `pushBuiltinFnSingletonValueInstrs` — the
exact sequence L4344-4356 uses for `@@iterator`. The refusal body throws a
catchable TypeError when CALLED, which no row in this bucket does; `.name` /
`.length` meta come from the glue. `[].values().join` already resolves through
`__iter_rec_proto` + the glue member arms (`p4`: `[].values().map` is a
function) once `join` is a member. `__reflect_is_constructor` answers 0 for a
native-proto closure (`p4`: `isC(Array.prototype.join) = false`), so
`Reflect.construct(function(){}, [], join)` throws and `isConstructor` returns
false; `new it.join()` reaches the driver's guard with a callable, non-constructor
callee → TypeError (S5's widening is not needed for this assertion).

**Ordering / risk:** the glue CSV feeds `hasOwnProperty`/gOPD of
`Iterator.prototype` reads that go through the `$NativeProto` object; the root
singleton is a separate `$Object` (the identity split between the shim's
`Iterator.prototype` and the glue object is pre-existing, #6484 S1, and not
changed here). ES5 pin: `built-ins/Array/prototype/join/**` (the Array glue
owns its own `join`; the arm is brand-keyed). Pins: the 18 `join/**` rows (6
pass today, must stay), `built-ins/Iterator/prototype/Symbol.iterator/**`.

### S7 — measure, controls, gates, record

1. Rows: `flock /tmp/claude-0/t262.lock npx tsx scripts/run-test262-paths.mts .tmp/6773/rows.txt --isolate --standalone` → expect `{ pass: 21 }`.
2. Family control (must not lose a row): `built-ins/Iterator/prototype/chunks/**` + `windows/**` (78 rows; 36 pass on base) and `built-ins/Iterator/prototype/{map,filter,take,drop,flatMap}/**` (184 rows; base passes 12/11/9/12/14 = 58) — report the delta; the 45 sibling protocol rows are expected gains.
3. ES5 control (zero regressions — the edition is `completed`): `language/expressions/new/**` (59), `built-ins/Object/getPrototypeOf/**`, `built-ins/Object/prototype/isPrototypeOf/**`, `built-ins/Array/prototype/join/**`.
4. ES2015 control: `language/statements/for-of/**` (182), `language/expressions/call/spread-err-*.js` (16), `built-ins/Array/from/**` (47), `built-ins/GeneratorPrototype/**`, `built-ins/Iterator/prototype/join/**` (18).
5. vitest pins (`VITEST_FORK_MAX_OLD_SPACE_SIZE=1024 npx vitest run <files>`): `tests/issue-2903-r3.test.ts`, `tests/issue-2903-r4.test.ts`, `tests/issue-2903-r4b.test.ts`, `tests/issue-2903-r4c.test.ts`, `tests/issue-3100-s5.test.ts`, `tests/issue-3119.test.ts`, `tests/issue-5131-es2015-strict-spread-iterator.test.ts`, `tests/issue-5254.test.ts`, `tests/issue-6484-iterator-prototypes.test.ts`, `tests/issue-6612-dynamic-new-is-constructor.test.ts`, `tests/issue-6651-g4-forof-step-protocol.test.ts`.
6. Gate chain (see Lane protocol), then record per-step commits and the three
   tables (rows / family / controls) under `### 2026-xx-xx — #6773 implementation`.

### Optional follow-up (not required for the 21 rows; do NOT bundle unless measured green): closed class iterators under a poisoned module

`p17a` is a 10-line reproducer of a module-level defect outside this bucket:
any `Object.getPrototypeOf(<any-typed object>)` makes `for…of` / spread /
`Array.from` over a `class` iterator (compiled `next` method) stop at step 1.
The fix shape is in `buildIteratorBody` (`iterator-native.ts:4055` `objArm`,
tail L4229-4282, `strictTail` L4330): test the `collectUserIterableStructTypeIdxs`
set (L3328) FIRST and take the USER tail for those carriers, leaving the OBJ
arm to `$Object`/`$Proxy` and closed `{next: fn}` field literals (which the
OBJ step reads through `__sget_next` and must keep). Its pin set is the full
for-of / spread / Array.from / destructuring slice plus every
`built-ins/Iterator/**` row (they all carry the shim). File it as its own
issue if the dev has budget after S7; it is the lever behind the remaining
`class X extends Iterator` failures across `built-ins/Iterator/prototype/**`.

## Acceptance criteria

- The 21 rows in `.tmp/6773/rows.txt` pass on `--isolate --standalone`.
- No row of the 78-row `chunks/windows` family, the 59 `language/expressions/new`
  rows, or the S7 ES5/ES2015 control lists goes pass → fail (ES5 is
  `completed`: one regression parks the PR).
- Sibling `{map,filter,take,drop,flatMap}` deltas reported (gains expected, no losses).
- All S7 vitest pins green; gate chain green with `LOC_GATE_BASE=$(git rev-parse origin/main)`.
- `## Classification note` left as a record; `scripts/generate-editions.ts` untouched.

## Lane protocol

- Worktree: `git worktree add /home/user/js2/.claude/worktrees/issue-6773 -b issue-6773-iterator-chunks-residue origin/main`,
  then `ln -s /home/user/js2/node_modules <wt>/node_modules` and, if
  `<wt>/test262/test` is missing, `rm -rf <wt>/test262 && ln -s /home/user/js2/test262 <wt>/test262`.
  Never edit `/home/user/js2` itself.
- One test262 runner at a time on this 4-core box: every
  `run-test262-paths.mts` invocation goes through `flock /tmp/claude-0/t262.lock …`
  (paths relative to `test262/test/`). No eval provider is needed for these rows;
  if a control row reports "provider is not built", run
  `npx tsx scripts/build-quickjs-eval-provider.mjs` once.
- New `src/` files (none planned; if the dev splits the S4 singleton out) must
  be registered in `scripts/compiler-boundaries.json` as a textual insert next
  to the `src/codegen/iter-lazy-native.ts` entry: `path`, `state: "unmigrated"`,
  `layer: "mixed-needs-split"`, `destination: "backend-wasmgc"`,
  `owner: "3518-coordinator"`, `nextBoundary` (copy the neighbour's text).
- Gate chain before every commit, bare (never piped):
  `LOC_GATE_BASE=$(git rev-parse origin/main) node scripts/check-loc-budget.mjs && LOC_GATE_BASE=$(git rev-parse origin/main) node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports && node scripts/check-compiler-boundaries.mjs --mode inventory --base origin/main && npm run -s typecheck`.
  Growth allowances live in THIS file's frontmatter (restate any grant that a
  step needs in a file this PR touches; never edit `scripts/*-baseline.json`).
- vitest pins with `VITEST_FORK_MAX_OLD_SPACE_SIZE=1024`; pushes with
  `NODE_OPTIONS=--max-old-space-size=4096 VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`.
- Commits: `GIT_AUTHOR_NAME="Thomas Tränkler" GIT_AUTHOR_EMAIL="git@thomas.traenkler.com"`,
  subject ends with ` ✓`, trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
  `Model: Claude Opus 5.5 High`, `Claude-Session: https://claude.ai/code/session_01FEGi3DmyPRPD5dx4kWU8hs`.
  Never `--no-verify`. Push the branch early (`git push -u origin <branch>`),
  do not open a PR and do not enqueue — the lead verifies the pushed head.
- No `git stash`; A/B by file copy from `.tmp/6773/base-src`.

## Overlaps and related work

- #5147 (in-review) built `chunks`/`windows` and planned this exact tail
  ("protocol-fidelity tail … `class X extends Iterator` … fix in
  `iter-hof-native.ts`'s open/step helpers, not per-kind", its plan items 4-5);
  nothing of it is in flight on a branch. #6484 S1-S4 (iterator prototypes,
  `$__IterRec` family tag, `__iter_rec_proto`) landed on main and are reused
  by S4/S6; no open `6484` branch exists. #6651 slice G2 explicitly scoped these
  21 rows OUT (L1892-1905) — this issue picks them up; no `6651-*` branch touches
  the files above (checked `git branch -r`). #6492 round 4b/4c is the JS-host
  lane's `chunks`/`windows` and the shim redesign (`scripts/test262-iterator-binding.mjs`);
  not touched. #3249 (GetIteratorDirect ladder cast trap) and #3484 (host lane
  helpers) are adjacent but not overlapping. #6612 owns the guard S5 widens;
  #6630 documents the object-runtime bootstrap side effect the Problem section
  measures. `node scripts/pre-dispatch-gate.mjs 6773` → CAUTION (gh offline;
  no claim, no PR).
