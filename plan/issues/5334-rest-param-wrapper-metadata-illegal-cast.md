---
id: 5334
title: "Rest-param function value reached through a fixed-arity callable param casts arg0 to the rest vec (illegal cast)"
status: ready
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
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
