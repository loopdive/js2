---
id: 5334
title: "Rest-param function value reached through a fixed-arity callable param casts arg0 to the rest vec (illegal cast)"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-06
completed: 2026-09-06
assignee: ttraenkler/senior-dev
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
# 2026-09-06: the mechanism (runtime rest disambiguation: identity guards, the
# value test, the pack, the eager pure-rest wrapper, the externref views) lives
# in the NEW subsystem module `src/codegen/expressions/callable-rest-bridge.ts`
# and the rest-marker registry helpers in `closures/funcref-wrapper-types.ts`.
# What remains in the three god-files is the hook: the ladders' candidate
# admission now asks `candidateFixedFormalCount`/`bridgedRestFixedCount`, and
# each arm's vec slot is one `restSlotMarshalInstrs` call. call-identifier.ts
# +20 (its inline rest-pack block was replaced, not added to), calls.ts +4 (one
# pre-registration call inside `ensureFuncValueWrappersRegistered`),
# calls-closures.ts +57 (the property ladder never had ANY rest handling: the
# candidate scan, the arm, the argument views and the speculative pure-rest
# wrapper are all new hook sites, each a few lines plus its rationale).
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/calls-closures.ts
# 2026-09-06: same change-set. compileIdentifierCall +14 (the marshal call and
# the eager pure-rest candidates, in the ladder that owns the candidate list),
# ensureFuncValueWrappersRegistered +3 (the one place the exact declaration ABI
# is known, hence the one legitimate writer of the rest-marker registration),
# compileCallablePropertyCall +6 (the argument views must be emitted between
# argument evaluation and the ladder, inside this function).
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/expressions/calls.ts::ensureFuncValueWrappersRegistered
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
---

## Symptom

`RuntimeError: illegal cast` at runtime. In the jest dogfood suite this is
`jest-watcher/src/lib/__tests__/prompt.test.ts` (0/4) and two of
`jest-matcher-utils/src/__tests__/Replaceable.test.ts` — **6 tests**. The
original triage described it as "a `jest.fn()` mock passed as a callback into
compiled library code"; that is a symptom, not the mechanism. `jest.fn()` is not
a host object here — the dogfood shim's `vi.fn()` returns a **compiled**
`function spy(...args) { … }`, and the rest parameter is the whole story.

## Reduction (no jest, no mocks)

```ts
function spy(...args: any[]): void {}

class Box {
  private _v = "x";
  private _n = -1;
  private _cb: () => void;
  constructor() { this._cb = () => {}; }
  enter(onChange: (pattern: string, options: { max: number; offset: number }) => void): void {
    this._v = "";
    this._cb = () => onChange(this._v, { max: 10, offset: this._n });
    this._cb();
  }
}
new Box().enter(spy);        // RuntimeError: illegal cast
```

Controls, measured on the same harness: an arity-2 arrow, an arity-0 arrow and a
plain non-rest function expression in the same slot are all clean. Only the
callback slot whose value is a REST function traps, and only that slot (a rest
function in `onSuccess`/`onCancel` — never invoked with 2 args — is clean).

## Mechanism

From the emitted WAT, the arm that runs is:

```wat
local.get <self>
local.get <arg0-as-externref>     ;; this._v — a STRING
any.convert_extern
ref.cast null (ref null $__vec_externref)   ;; <-- traps
local.get <funcref>
ref.cast (ref $spyType)
call_ref $spyType
```

so the single trailing **vec** formal of `spy` is being marshalled as an
ordinary positional parameter, and argument 0 is cast straight to it.

Why: the ladder in `src/codegen/expressions/call-identifier.ts` decides
rest-ness from `info.hasRestParam` (falling back to
`ctx.__restFuncTypeIdxs`). An instrumented dump of the candidate scan for this
fixture shows `spy`'s record as

```
info.funcTypeIdx=27 struct=26 params=[{"kind":"ref_null","typeIdx":2}] rest=false infoRest=undefined
```

— `hasRestParam` is **absent**. `src/codegen/closures/funcref-as-closure.ts`
does set it (it reads the source declaration), but that path does not run for a
top-level function used as a value: the wrapper comes from
`ensureFuncValueWrappersRegistered` via `getOrCreateFuncRefWrapperTypes` /
`getOrCreateConstructibleFuncRefWrapperTypes`
(`src/codegen/closures/funcref-wrapper-types.ts`), and **neither constructs
`hasRestParam`**.

With `hasRestParam` false, `fixedParamCount` becomes 1, the scan compares
`sigParamWasmTypes[0]` (`externref`, because `pattern: string` lowers to
externref) against the vec formal, and `scalarBridgePlan`'s "erased generic ref
carrier" row admits it with `any.convert_extern` + `ref.cast`. That row exists
for a genuinely erased type parameter whose runtime value IS the carrier; here
the value is a string and the cast is a guaranteed trap on a LIVE arm.

`ctx.__restFuncTypeIdxs` — the registry the ladder reads at
`call-identifier.ts:2352` to recover rest-ness — has **no writer anywhere in the
tree**. The escape hatch exists but was never wired.

## Why this is not a two-line fix

Marking rest-ness on the wrapper is ambiguous, and the ambiguity is real:
`function spy(...args: any[])` and `function g(xs: any[])` lower to the SAME
funcref type, and when both are captureless declarations they share the same
wrapper struct too. A `funcTypeIdx`-level "this is rest" flag would make the
dispatcher pack arguments into a fresh vec for the genuine array-parameter
callee as well — silently wrong in the other direction. #4616 met the same
ambiguity in `calls.ts` and answered it by keeping a separate rest arm guarded
on the CONCRETE struct type; that guard does not separate these two.

## Proposed design (runtime disambiguation, no metadata needed)

Make the argument bridge decide at runtime instead of guessing at compile time:
`ref.test` the incoming value against the vec carrier and

- on a **hit**, pass it through — the fixed reading, which is what a real
  `g(xs)` call site produces;
- on a **miss**, pack every call argument into a fresh vec — the rest reading.

Both readings then get their correct answer, and no arm can trap. The cost is a
guarded branch on an arm that today is one unconditional `ref.cast`.

## Notes for whoever takes this

- The whole bridge family is HOST-lane only (`scalarBridgePlan` returns null
  under `standalone`/`wasi`), so the change cannot affect standalone.
- Two adjacent shapes fail differently and are probably the same root cause seen
  through a different arm: a rest function expression, and a nested function
  returned from a factory, both answer
  `TypeError: Cannot access property on null or undefined` rather than trapping.
- `jest-jasmine2/src/__tests__/queueRunner.test.ts` (6 more tests) is blocked
  behind a **host-callback** failure of the same family —
  `TypeError: Cannot convert object to primitive value` out of
  `invokeNativeFunctionCallback` — after
  [#5329](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5329-tuple-rest-carrier)
  made its module valid. Worth re-checking once this lands.

## Implementation Plan

The design above ("runtime disambiguation, no metadata needed") is the plan;
this section orders it and fixes the evidence bar.

1. **Reproduce both halves before editing.** (a) `spy(...args)` reached
   through a fixed-arity callable param → `illegal cast` on arg0; (b) the
   control that must keep working: `g(xs)` where `xs` is a genuine array
   parameter sharing the same funcref/struct type. The whole difficulty is
   that (a) and (b) are indistinguishable by signature — any fix that keys on
   a flag will break one of them. Capture `.tmp/*.orig.ts` for every file you
   touch (`src/codegen/closures/funcref-as-closure.ts`,
   `src/codegen/expressions/call-identifier.ts` ladder, and the
   `getOrCreate(Constructible)FuncRefWrapperTypes` sites).
2. **Confirm the dead registry.** `ctx.__restFuncTypeIdxs` has no writer in
   the tree. Either give it a writer at the one place rest-ness is known
   (the wrapper mint in `ensureFuncValueWrappersRegistered`) — accepting that
   it can only mark *the wrapper*, not disambiguate a shared signature — or
   delete it so the next reader is not misled. The design says the bridge
   must not depend on it; make the code agree.
3. **Implement the runtime-disambiguating bridge** as designed: when the
   ladder marshals into a callee whose trailing formal is a vec, and the
   arity of the *call site* exceeds the wrapper's declared fixed arity, pack
   the surplus positionally into the rest vec; when it does not, pass through.
   The decision is made from call-site arity vs callee arity at runtime, not
   from a stored flag.
4. **Regression test** (`tests/`), untyped `.js` two-file fixtures:
   `spy(...args)` via callback param with 1, 2, 3 args (values pinned, not
   just "no trap"); `g(xs)` with an array as the anti-vacuity control; a
   `jest.fn()`-shaped spy recording its calls. Fails on parent, passes with
   fix.
5. **A/B** at one HEAD, 17 suites, per test file. jest `prompt` 0/4 and
   `Replaceable` are the expected movers (+6). Anchors in #5338.
6. Gates including `pnpm run check:dogfood-validation`; one PR.

## Dispatch

Model: **fable** (`reasoning_effort: max`, `feasibility: hard`). The
signature-sharing ambiguity is genuine; this needs the strongest reasoning
available, not more hands.

## Implementation notes (2026-09-06, Claude Fable 5.1)

### What landed, and where

- **`src/codegen/expressions/callable-rest-bridge.ts` (new)** — the runtime
  bridge. `restSlotMarshalInstrs` is the one instruction sequence that fills a
  candidate's trailing `$__vec_externref` formal; `collectRestDispatchPlans`
  gathers the identity guards; `restShapedWrapperCandidates` makes sure the
  pure-rest shape `(...args) -> R` has an arm at every typed callable call;
  `candidateFixedFormalCount` / `bridgedRestFixedCount` are what the two ladders
  now ask instead of reading a flag; `argumentExternViews` gives the property
  ladder the externref views its pack needs.
- **`src/codegen/closures/funcref-wrapper-types.ts`** — `ensureRestFnWrapSubtype`
  moved here from `method-trampolines.ts` (it was private to #4616's singleton),
  plus `isSharedSignatureWrapperStruct` and `registerRestDeclarationWrapperShapes`.
- **`src/codegen/expressions/calls.ts`** — `ensureFuncValueWrappersRegistered`
  registers the rest-marker subtype for every rest DECLARATION used as a value,
  at pre-scan time. This is the "one legitimate writer" the plan asked for —
  per struct, not per funcref type (see below).
- **`src/codegen/expressions/call-identifier.ts`** — the identifier ladder
  (`onChange(this._value, opts)` on a captured param): candidates are admitted
  on their FIXED formals, the vec slot is marshalled by the bridge, the eager
  pure-rest wrappers are added next to #4616's prefix wrappers, and the dead
  `ctx.__restFuncTypeIdxs` read is gone.
- **`src/codegen/expressions/calls-closures.ts`** — the callable-PROPERTY
  ladder (`this._onSuccess(v)` / `this._onCancel()`), a second site the issue
  did not name. jest's prompt tests 2–3 go through it (measured: `promptSuccess`
  trapped `illegal cast`, `promptCancel` ended in the TypeError terminal, with
  the identifier ladder already fixed). Same bridge; the deferred all-scalar
  helper (`__call_cprop_deferred_N`) only sees padded declared formals, so it
  takes the rest reading only when the vec is provably empty.

### Why the decision is made at runtime, and why in two layers

- **Canonical identity is structural — measured, not assumed.** A hand-written
  module (`wasm-as` + node, 2026-09-05): two sibling subtypes of the wrapper
  root with identical fields `ref.test` as the SAME type (`a_is_b = 1`); one
  extra field makes them distinct (`a_is_c = 0`); two siblings that both carry
  the extra field are again the same (`c_is_d = 1`). So a struct `ref.test`
  proves rest-ness only for a structurally marked struct: #4616's
  `__rest_fn_wrap` (an f64 marker) and capture structs qualify; the shared
  signature wrapper never does, and neither does a same-layout sibling.
- **Layer 1, identity.** Every registered `hasRestParam` struct that qualifies
  is a guard; a hit packs unconditionally. This is the only thing that can get
  `spy(["ab", "c"])` right: the one argument IS a vec, so no value test can
  tell it from `g(["ab", "c"])`. Parent answered `args.length === 2`; the value
  test alone still answers 2; with the pre-registered marker it answers 1.
- **Layer 2, the value's shape.** For a closure whose struct the ladder cannot
  know — jest's `vi.fn()` spy is a nested, capturing rest function in the test
  module, compiled AFTER the library whose `onChange(...)` dispatches it —
  `ref.test` the erased argument against the vec carrier: hit → the fixed
  reading (pass through), miss → pack. A scalar or closed-reference slot can
  never be the vec and packs without a test; no argument → an empty vec
  (`onCancel()`); a statically array-typed slot keeps its projection unless a
  guard proves rest.
- **Why the ladder had no arm at all for the jest spy.** Ladder dump at the
  reduction's call site: the only vec-bearing candidate was the pre-registered
  plain wrapper `(vec)->void rest=false min=0`. The singleton's marker subtype
  is minted at the FIRST VALUE READ, after the call site compiled, and the
  ladder deduped by funcref type anyway. For the nested spy nothing at all was
  registered (`ensureFuncValueWrappersRegistered` admits only all-externref
  shapes), so the parent ended in the TypeError terminal, not a trap. The
  eager pure-rest wrapper — same get-or-create family as #4616's prefix
  wrappers, so the later closure reuses the identical funcref type — is what
  gives that closure an arm.
- **The plan's step 3 as written does not hold.** "Call-site arity exceeds the
  declared fixed arity → pack" would pack `g(["ab", "c"])` as well (1 > 0) and
  fail the anti-vacuity control. The "Proposed design" section (test the
  value) is what was implemented, refined with the static slot knowledge above.

### `ctx.__restFuncTypeIdxs`

Deleted, together with its only reader. A per-funcref-type "this is rest" set
is exactly the wrong granularity — that IS the ambiguity. Its replacement is
per-STRUCT: `registerRestDeclarationWrapperShapes` registers the marker
subtypes (both the plain-based and the constructible-based one, because the
singleton's callers do not all agree on constructibility, #4491 T12), and the
bridge reads them through `collectRestDispatchPlans`. Anything not provable
that way is decided from the value.

### Anti-vacuity control, and what "genuine array parameter" must mean

An untyped `g(xs)` lowers `xs` to externref and never shares `spy`'s funcref
type; the ambiguity needs a TYPED `g(xs: any[])`, and the callable slot must be
typed too (an untyped `cb` param has no call signature and never reaches
either ladder — it goes down `calls.ts`'s dynamic path). Hence the test's
`dep.ts` + `main.js` split, which is also the dogfood shape (TS library, JS
shim). `controlGStr` (`g(["ab", "c"])` through `(xs: any) => unknown`) answers
202 on parent and fix alike.

### Residuals, measured

- `g(xs: any[])` called with a NUMBER-literal array through an `any` slot:
  parent trapped `illegal cast`; now the value test misses (`$__vec_f64` is not
  `$__vec_externref`) and packs, so `g` answers NaN. Wrong rather than a trap;
  a typed vec crossing an erased slot needs an element-wise re-boxing bridge,
  out of scope here. (`spy([1, 2, 3])` is correct by the same miss.)
- Two nested functions with identical capture layouts, one rest and one not,
  canonicalize together; the guard over-matches and the non-rest one gets
  packed. Same class as #4616's guard.
- Property ladder: surplus call-site arguments beyond the field's declared
  arity are not in the pack (they travel through `__extras_argv`, not locals).
- Standalone lane: unchanged by design — the flag-driven reading is kept
  (`candidateFixedFormalCount` honours the flag off the host lane and
  `bridgedRestFixedCount` answers null there).

### Pre-existing failures met on the way (A/B'd on the parent, not mine)

- `tests/issue-3214-callable-abi.test.ts` › "runs a legacy captured closure
  through a genuine-IR callee in both wrapper orders": fails on the parent
  identically (the `() -> f64` wrapper is `__fn_wrap_0`, the root, before and
  after).
- `tests/issue-4616-nullish-spread-source.test.ts` (2 tests): `illegal cast`
  on the parent identically.

### Regression test

`tests/issue-5334-rest-param-callable-runtime-bridge.test.ts` — parent
(`2257b950ee`, this branch's base, files swapped back by copy): **6 failed /
1 passed** — the one pass is the anti-vacuity control, which must pass on both
sides; fix: **7 passed / 7**. Both counts measured 2026-09-06.

### A/B at one HEAD (2257b950ee = upstream/main at branch time, 2026-09-06)

Same tree, this change-set toggled by copying the six touched files in and
out (`.tmp/*.orig.ts` captured before the first edit); one suite at a time.

| suite | parent | fix | per-file movement |
| --- | --- | --- | --- |
| webpack | 16/16 | 16/16 | none |
| three | 17/18 | 17/18 | none |
| clsx | 32/32 | 32/32 | none |
| cookie | 63740/63740 | 63740/63740 | none |
| lodash | 53/62 | 53/62 | none |
| redux | 61/82 | **63/82** | `test/createStore.spec.ts` 34/42 → 36/42 |
| axios | 200/231 | 200/231 | none |
| stylelint | 108/108 | 108/108 | none |
| tailwindcss | 13/13 | 13/13 | none |
| jsdom | 6/6 | 6/6 | none |
| styled-components | 9/9 | 9/9 | none |
| uuid | 75/75 | 75/75 | none |
| marked | 9/30 | 9/30 | none |
| moment | 10/10 | 10/10 | none |
| prettier | 101/151 | 101/151 | none |
| jest | 329/356 | **335/356** | `__tests__/Replaceable.test.ts` 15/17 → 17/17; `__tests__/prompt.test.ts` 0/4 → 4/4 |
| hono | 244/324 | 244/324 | none |

Every suite ran once per side, one at a time; a run that printed no `admitted`
headline (uuid words it differently) was read from its report JSON. The two
movers are the expected jest files; redux `createStore.spec.ts` also moved
34/42 → 36/42 (see the note below).

redux movers, attributed: "notifies all subscribers about current dispatch
regardless if any of them gets unsubscribed in the process" and "notifies only
subscribers active at the moment of current dispatch". Both subscribe `vi.fn()`
listeners and `createStore.ts` invokes them as `listener()` through a typed
`() => void` slot — a ZERO-argument call of a rest spy, which on the parent had
no admitted arm (the `(vec)` wrapper was excluded for a shorter signature) and
ended in the TypeError terminal. The empty-vec arm is exactly the `onCancel()`
case this change adds; the other 40 tests in that file are unchanged.
