---
id: 5201
title: User-defined instance method of a builtin-derived class is dispatched as a builtin proto method — `__clzmsd is not a function` blocks Temporal module init
status: done
completed: 2026-08-29
assignee: ttraenkler/opus-dev-5201
sprint: current
priority: high
horizon: m
goal: standalone-gap
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-29
loc-budget-allow:
  # +6 lines: an import plus a 2-line call at the top of `resolveWasmType`'s
  # Object branch. The rationale comment and the predicate itself live in the
  # new subsystem module `src/codegen/externref-backed-class-rep.ts`; only the
  # dispatch point has to be inside the god-file, because the arm it must
  # outrank (`inheritedArrayElementType`) is there.
  - src/codegen/index.ts
func-budget-allow:
  # Same +5 lines, counted against the enclosing function. The check has to be
  # INSIDE `resolveWasmType`'s Object branch and ABOVE the array arm — that
  # ordering is the fix; moving it out of the function would move the bug.
  - src/codegen/index.ts::resolveWasmType
---

# #5201 — builtin-derived instance methods mis-dispatched to `Array.prototype`

## Problem

With the #5191 fix (class-object singleton) and the #5193 fix (init-window
marshalling, PR #5252) applied, the `@js-temporal/polyfill` + `jsbi@4.3.0`
linked ESM bundle advances further through module init and now stops at:

```
TypeError: __clzmsd is not a function
```

raised from `runtime.ts`'s `__proto_method_call` arm. `moduleInitRuns` stays
`false`; #4628 Option A remains gated on this.

## Mechanism (from dev-5193's isolation — needs a real reduction)

jsbi declares `__clzmsd()` as an **instance method** of
`class JSBI extends Array` and calls it as `_.__clzmsd()`. Codegen lowered
the call to the builtin-proto dispatch path — effectively
`Array.prototype.__clzmsd.call(receiver)` — i.e. a user-defined method of a
builtin-derived class was routed as if it were a built-in `Array.prototype`
method. `Array.prototype` has no such function, so the host runtime throws.

Same #5191 family: the builtin-parent classification bleeding into member
dispatch decisions.

**Important:** the obvious one-line repro (`class C extends Array { m() {
return 1 } } new C().m()`) does NOT reproduce, per dev-5193. The failing
shape involves something extra — plausibly the receiver flowing through a
variable of imprecise type, a `this`-call inside another method (`_` is
jsbi's convention for `this`-aliasing), or the #5193 init-window context.
Reduce from the bundle (harness slice lane / statement-prefix bisection) —
do not guess.

## Direction

Find the dispatch decision that routes member calls on builtin-derived
receivers to `__proto_method_call` with the builtin's proto, and make it
consult the class's own declared members first (or carry the class identity
through the imprecise-receiver path). Keep genuinely-builtin methods
(`push`, `slice`, …) on the fast path; measure both.

## Acceptance criteria

1. A reduced repro (checked into the new test file) that fails on base and
   passes with the fix, host and standalone.
2. jsbi's real shape works: an instance method declared on
   `class X extends Array`, called through a `this`-alias inside another
   method, at module-init time.
3. The Temporal harness advances past `__clzmsd`: run
   `node --import tsx tests/dogfood/temporal-polyfill-harness.mjs` — if a
   NEW later blocker appears, file it (coordinator allocates the id if the
   scan is degraded) and record it; if `moduleInitRuns` flips to `true`,
   say so loudly — that un-gates #4628's integration step.
4. No regressions in scoped class/array-method runs (name the files run);
   builtin proto methods on derived instances still dispatch correctly.

## Notes

- Found by dev-5193 while validating PR #5252 (see its "Temporal harness"
  section). Blocker chain so far: #5191 (class value null) → #5193 (init
  marshalling window) → this.
- Id #5201 reserved with a degraded PR scan (gh offline); manually verified
  against all 18 open PR head branches on 2026-08-29. The
  `check:issue-ids:against-main` gate arbitrates.

## Implementation notes (2026-08-29, opus-dev-5201)

### The mechanism was NOT proto dispatch — it was a lossy value representation

The filed hypothesis ("routed as `Array.prototype.__clzmsd.call(receiver)`")
turned out to be one layer off, so recording the measured chain matters more
than the title.

`resolveWasmType` (`src/codegen/index.ts`) decided the Wasm representation of
`class D extends Array` in its **array arm** — `inheritedArrayElementType`
matches anything that inherits an array element type — and answered
`ref_null $__vec_externref`. But `new D()` returns an **externref**:
`<Class>_new` builds a host object and installs `D.prototype` on it, and that
prototype is the only place the class's own methods live.

Those two answers disagree, and the disagreement is lossy in exactly one
direction. Every `externref → vec` coercion — `const d = new D()`, an argument
entering a `D`-typed parameter, a field write — **materialised a fresh vec by
copying elements** out of the host object (visible in the WAT as
`__extern_length` + a per-element `__extern_get` loop + `struct.new`). The copy
carries no prototype, so the method table is gone. Re-entering the host the
value is an opaque WasmGC struct, and `__extern_method_call` reports
`<name> is not a function`. It never reached `__proto_method_call` at all.

### What the "something extra" was

`f(new D())` **already worked on base**: the constructor's externref never
meets a `D`-typed slot, so nothing materialises. The defect needs the value to
pass through a **declared binding of the class's own type** first —
`const d = new D(); f(d)`. That single difference is why
`class C extends Array { m(){} } new C().m()` looked healthy. It is pinned as
a control in the test file.

Measured matrix on base (host lane), all with `class D extends Array`:

| shape                                        | base | fixed |
| -------------------------------------------- | ---- | ----- |
| `f(new D())` — free fn, arg is the `new`     | 7    | 7     |
| `const d = new D(); f(d)`                    | THROW | 7    |
| `static f(a)` on D itself, arg a `D` local   | THROW | 7    |
| instance method via a `this`-alias (`const _ = this`) | THROW | 7 |
| `static f(a)` on an unrelated class          | THROW | 7    |
| plain (non-derived) class, same shapes       | 7    | 7     |
| `push`/`length`/`d[0]`/`slice`/`for…of`/`instanceof` | ok | ok |

### The fix

The rule that prevents this **already existed** (#1366a: an externref-backed
user class resolves to externref) but sat at the named-struct lookup ~380 lines
*below* the array arm, so a builtin-derived class never reached it. Hoisted
above every structural / intrinsic-spelling arm; the predicate and the full
rationale live in the new `src/codegen/externref-backed-class-rep.ts`.

Blast radius is bounded by `classExternrefBackedSet` membership (populated only
for host-constructible builtin / extern-class parents), so a plain user class, a
user-derived class, and any lane that never joins the set resolve
byte-identically — confirmed by a 15-case control matrix that is bit-identical
before and after.

### Harness outcome — `moduleInitRuns` is still `false`, and the next blocker

Measured on `origin/main` + PR #5252 (issue-5193 branch merged into a local
probe tree only):

| tree                          | `moduleInitError`                                          |
| ----------------------------- | ---------------------------------------------------------- |
| main + this fix, no #5252     | `cannot marshal opaque compiled value to host Float64Array` |
| main + #5252, without this fix | `cannot marshal opaque compiled value to host Float64Array` |
| main + #5252 + this fix        | `__clzmsd is not a function`                                |

So **both** fixes are needed to clear the Float64Array blocker, and the bundle
then advances to `__clzmsd`. `moduleInitRuns` did **not** flip to `true`.

Instrumenting the failing call in the linked bundle shows the receiver is now
**correct** — `[object Array]`, `Object.getPrototypeOf(recv).constructor.name
=== "JSBI"`, own keys `0, sign` — but `JSBI.prototype` carries **only
`constructor`**. The methods were never installed on it.

**NEW BLOCKER (needs an id from the coordinator — the `--allocate` PR scan is
degraded here, gh is offline, and per the dispatch brief I did not pass
`--allow-unscanned`).** It is an **init-window** defect, not a dispatch one.
Same source, same wiring, only the call's timing differs:

```js
class D extends Array { constructor(n, s) { super(n); this.sign = s; }
                        __clzmsd() { return 7; } }
function f(a) { return a.__clzmsd(); }

const AT_INIT = f(new D(1, false));   // THROWS `__clzmsd is not a function`
export function test() { return f(new D(1, false)); }   // returns 7
```

The host runtime can only populate a compiled class's host prototype once it
has the instance's exports, and those are wired by
`result.importObject.__setInstance(instance)` — which by construction can only
be called **after** `WebAssembly.instantiate` returns, while module init runs
**during** it. Any top-level statement that dynamically dispatches to a
compiled class method is therefore unreachable. This is the same window #5193
addressed for value marshalling; this is its method/prototype facet.

Two consequences worth stating plainly:

- `tests/dogfood/temporal-polyfill-harness.mjs` never calls
  `result.importObject.__setInstance?.(instance)` (line ~218) — but adding the
  call would not help, because init has already thrown by then.
- The two import wirings behave differently on the SAME binary, which is worth
  knowing when reading any repro: `runtime.buildImports(...)` + `setInstance`
  answers `7` for the after-init shape, `result.importObject` alone throws.
  Equivalence-suite helpers use the former.

### Left open, deliberately

Under `--target standalone` a dynamic (`any`-receiver) member call on **any**
externref-backed builtin-derived instance — `extends Object` / `Error` /
`Array`, and equally with `arg=new` — fails to find user methods. Measured
**identical before and after this fix**, so it is a separate family-wide
standalone dynamic-dispatch gap, not this defect. The standalone lane in the
test file pins the shapes that do work.

### Validation

- `tests/issue-5201-builtin-derived-instance-method-dispatch.test.ts` — 16
  tests; exactly the 4 imprecise-receiver cases fail on base, all 16 pass with
  the fix. Host + standalone.
- Full `tests/equivalence/` directory, 217 of 218 files (the 218th,
  `multi-file-compilation.test.ts`, OOMs in this container on base too):
  **24 failures, every one reproduced on base** —
  `arguments-nested-and-loops`, `array-inline-return`, `delete-sentinel`,
  `logical-conditional-identity` (×3), `misc-small-patterns`,
  `new-non-constructor` (×2), `null-dereference-guards` (×5),
  `optional-direct-closure-call` (×2), `reflect-api`,
  `tdz-reference-error` (×6), `yield-as-expression`. Zero regressions.
- Scoped class/array runs, all green:
  `issue-5191-builtin-derived-class-value`, `array-methods`,
  `array-prototype-methods`, `classes`, `class-methods`, `class-method-calls`,
  `issue-2101a-externref-subclass-ownfield`,
  `issue-2917-standalone-extends-builtin`,
  `issue-2029-subclass-builtin-standalone-emit`,
  `issue-2623-promise-subclass-identity`, `issue-2158-class-identity-standalone`
  (144 tests).
- `typecheck`, `lint`, and the loc / func / coercion-sites / oracle-ratchet /
  dead-exports gates.
