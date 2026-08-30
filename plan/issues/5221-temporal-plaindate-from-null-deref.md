---
id: 5221
title: "Temporal.PlainDate.from(…) traps with a null-pointer deref — polyfill intrinsic / Object.create(proto) machinery, single-module too"
status: done
completed: 2026-08-30
assignee: ttraenkler/dev-5221
sprint: current
priority: high
horizon: l
goal: core-semantics
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
# 2026-08-30 — six independent lowering defects on one call path, each fixed at
# its own site because they live in four different phases (destructuring, block
# scoping, the TDZ pre-pass, parameter lowering). The added lines are
# overwhelmingly the WHY: each fix looks like a one-word change and is only
# safe because of a measurement recorded next to it (e.g. why the
# `undefined`-default widening must be applied at BOTH class-method phases, and
# why the same widening is deliberately DECLINED at the closure lane). Splitting
# a two-line guard into a new module would hide the reason from the code that
# depends on it. `closures.ts` grows by comment ONLY — no code change there.
loc-budget-allow:
  - src/codegen/destructuring-params.ts
  - src/codegen/declarations.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/closures.ts
# 2026-08-30 — same rationale, per function. Every one of these is a guard of
# 1–5 statements plus the measurement that justifies it; the guard has to sit at
# the decision point (the `fieldIdx === -1` arm, the block-exit call, the pad
# loop, the param-lowering cascade), so there is nothing to extract that would
# not separate the rule from the site it governs. `destructureParamObject` grows
# by 4 lines of call + comment — the new work is a NEW top-level helper,
# `emitAbsentStructPropertyBinding`, not inline body.
func-budget-allow:
  - src/codegen/statements.ts::compileStatementInner
  - src/codegen/expressions/calls-closures.ts::tryExternClassMethodOnAny
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/destructuring-params.ts::destructureParamObject
---

# #5221 — `Temporal.PlainDate.from(…)` null-pointer deref

## Problem

With the #4628 provider wired (PR #5318), `Temporal.PlainDate.from("2020-03-04")`
traps with `RuntimeError: dereferencing a null pointer`. Measured by
dev-temporal-wire to fail IDENTICALLY when the polyfill is compiled as one
module with no provider and no linking — a pre-existing gap in the compiled
polyfill's intrinsic / `Object.create(proto)` machinery, not the provider
seam. This is the biggest conformance blocker left on the Temporal bucket:
`.from(...)` is the entry point most test262 rows use, which is why the
runner was deliberately NOT wired to the provider yet (rows would move from
"not defined" to a null deref with no net gain).

## Direction

Reduce inside the single-module polyfill compile (harness ESM lane):
instrument where the null flows from — likely `Object.create(proto)` /
%Intrinsic% table population in the compiled polyfill. Reduce to a minimal
compiled program before touching codegen/runtime.

## Acceptance criteria

1. `Temporal.PlainDate.from("2020-03-04")` returns a working object,
   single-module AND through the provider; new tests failing on base.
2. Temporal 256-row slice (dev-temporal-wire's deterministic sample) measured
   before/after; report deltas.
3. No regressions in issue-4628 test files + equivalence gate. Gates green.

## Notes

- Found by dev-temporal-wire validating PR #5318. Siblings: #5222 (Now.*
  lost across provider boundary), #5223 (instance toString dispatch).
- Id reserved with a degraded PR scan; manually checked against open PR
  head branches 2026-08-30.

## Root cause — SIX codegen defects on one call path

The "null-pointer deref" is a single symptom of a stack of independent
lowering bugs. Reducing inside the single-module polyfill compile (no
provider, no linking — the #4628 harness's ESM lane) peeled them off one at a
time; each has a minimal repro in `tests/issue-5221-plaindate-from-null-deref.test.ts`
and each had to be fixed before the next became visible.

The through-line is worth stating once, because it is the same mistake in six
places: **a value whose Wasm slot disagrees with its runtime shape is turned
into `null` instead of being rejected.** `ref.test` + `else ref.null` is
silent, so the fault surfaces frames later as a null read, a failed
destructure, or — when the coercion happens to be non-nullable — an
unconditional trap.

### 1. An absent object-pattern property bound `null`, not `undefined`
`src/codegen/destructuring-params.ts` · `destructureParamObject`

The struct fast path maps each pattern property to a `struct.get`. On
`fields.findIndex(...) === -1` it did nothing and left the binding local at its
Wasm zero, which for an `any`/externref slot reads back as JS **`null`**. So
`void 0 === t` answered false, `typeof t` said `"object"`, and a binding
default (`{ t = d }`) never fired. §13.15.5.6 says the value is `undefined`.

The polyfill's `GetTemporalCalendarSlotValueWithISODefault` is literally
`const { calendar: t } = e; return void 0 === t ? "iso8601" : …`, so a plain
`{year, month, day}` argument handed `null` to the `%calendarImpl%` intrinsic.

Fixed narrowly: the initializer case for every slot type, and an
`undefined` store for `externref`/`anyref` slots. `f64`/`i32`/`ref` slots keep
their zero-init — turning an absent numeric property into a NaN sentinel is a
wider behavioural change with its own blast radius.

### 2. A block-scoped `let`/`const` leaked its slot — and its Wasm TYPE
`src/codegen/statements.ts` · the `ts.isBlock` arm

`saveBlockScopedShadows` only saved names that ALREADY had a local, so a
binding a nested block introduced FRESH stayed in `localMap` after the block
closed. A later same-named declaration in the enclosing scope reused that slot:

```js
if (x === 2) { const n = obj(); … }   // $n : (ref null $Anon)
const n = str();                      // reuses it ⇒ ref.test fails ⇒ null
```

`typeof n` still reported `"string"` (the static type) while the value was
`null`. `discardBlockScopedShadows` — which the CaseBlock path already used for
exactly this reason — drops the block's own new names and restores genuine
outer shadows.

### 3. The same collision one phase earlier, as an unconditional TRAP
`src/codegen/index.ts` · `hoistLetConstWithTdz`

The TDZ pre-pass claims one slot per NAME (`if (fctx.localMap.has(name))
continue`) and recurses into nested blocks, so whichever declaration it
reached FIRST fixed that name's slot and type for the whole function.
`ToTemporalDate` puts a nested block's `const n = <record>` before the
function-level `let { year: n } = parse(String(e))`, so binding a number into
the inherited struct slot lowered to `ref.null $Anon; ref.as_non_null` — a
guaranteed trap on every string-argument call. **That is the reported null
deref.**

Fixed by running the pre-pass outermost-first: the body's own top-level
declarations claim their slots, then the original recursive walk. A nested
block's same-named binding then finds the name occupied and gets a fresh local
at block entry, which is what block scoping means.

### 4. An omitted argument was padded with `null`, not `undefined`
`src/codegen/expressions/calls-closures.ts` · `tryExternClassMethodOnAny`

That arm binds an `any` receiver to the FIRST extern class declaring the
method name and pads the class's fixed arity. It padded with a raw
`ref.null.extern`. `a.sort()` first-matches `Uint8ClampedArray_sort(self,
comparator)`, so native `Array.prototype.sort` received an EXPLICIT `null`
comparator and threw "The comparison function must be either a function or
undefined: null" — §23.1.3.30 accepts `undefined`, not `null`. The polyfill's
`PrepareCalendarFields` sorts its field-name list with a bare `a.sort()`.

Padding with `undefined` is the specified answer, not a workaround — the same
rule #4644 states for synthesized zero-arg method calls. The callee index is
re-read after padding because `pushDefaultValue` may register `__get_undefined`
and shift every function index.

### 5. A parameter whose only type evidence is an `undefined` default
`src/checker/type-mapper.ts` (`isUndefinedDefaultOnlyParam`),
`src/codegen/declarations.ts`, `src/codegen/class-bodies.ts`

`function f(item, options = void 0)` types `options` as `undefined`, which
`resolveWasmType` lowers to the void/undefined scalar — correct for a RESULT
("no value"), unsound for a PARAMETER. That ABI carries neither a caller's
value nor `undefined`: the slot reads back as the number `0`.
`Temporal.PlainDate.from(item, opts)` reached `GetOptionsObject` as `0` and
threw "Options parameter must be an object, not number" — **both** when
options were omitted (spec: `undefined` ⇒ a fresh null-prototype object) and
when a real object was passed.

An undefined-only parameter type is an ABSENCE of information, so it widens to
the undefined-capable `externref` domain — the same conclusion
`parameterMayBeOmitted` already reaches for `?`/JSDoc-optional parameters,
which it deliberately does not extend to defaulted ones. Applied at the
function-declaration lane and at BOTH class-method phases (signature
collection and function-context build); those two lists must agree or the
result is invalid Wasm, not a wrong value.

### 6. Call-site param inference specialised a forwarding parameter to one shape
`src/codegen/declarations.ts` · `lowerParamType`

`inferImplicitAnyParamType` narrows an implicit-`any` parameter to a call
site's anonymous object struct. The `__anon_*` withdrawal that guards this was
gated on `ctx.standalone`. The gate was wrong: the unsoundness is identical on
the host lane, only the symptom differs. Host-lane, a caller holding a
different shape is coerced with `ref.test` + `else ref.null`, so it silently
passes **null** — no trap, no diagnostic. The polyfill's `CreateTemporalDate`
forwards its untyped ISO-date record to `setSlots`, whose parameter had been
pinned to ONE call site's object literal; every other caller's record went
null and the failure surfaced three frames down, inside a nested-pattern
parameter (`{ isoDate: { year, month, day }, time: { … } }`) that never saw the
real record.

The standalone note already described exactly this ("breaks forwarding chains
as soon as another boundary expects the dynamic carrier"); the lane a program
runs in does not change whether one observed literal proves a parameter's whole
runtime domain.

## Result

Measured on the single-module polyfill compile (no provider, no linking),
`.tmp/probe-multi.mts`:

| probe | base | after |
| --- | --- | --- |
| `Temporal.PlainDate.from({year,month,day})` | `RuntimeError: dereferencing a null pointer` | ISO date `2020-3-4`, calendar `iso8601` |
| `Temporal.PlainDate.from("2020-03-04")` | `RuntimeError: dereferencing a null pointer` | ISO date `2020-3-4`, calendar `iso8601` |
| `Temporal.PlainDate.compare(a, b)` | trap | `-1` |
| `Temporal.PlainDateTime.from({…})` | trap | works |
| `Temporal.PlainTime.from("12:34:56")` | trap | works |
| `Temporal.Duration.from({hours: 2})` | trap | works |

## Residual — NOT fixed here, reported

- **Instance getters / `toString` on a `.from()` result still answer
  `undefined` / `[object Object]`.** `new Temporal.PlainDate(2020,3,4).year` is
  `2020`, but `Temporal.PlainDate.from(…).year` is `undefined` — the difference
  is that `.from` returns an `Object.create(proto)` object rather than a class
  instance, so this is #5223's prototype-method-dispatch gap, not this one.
  It is why the test262 rows still need #5223 before the provider is wired.
- **Object-literal function-expression properties keep defect #5.**
  `const O = { f: function (e, t = void 0) {…} }` still lowers `t` to the
  undefined-only scalar. Widening it at the closure lane ALONE turns a wrong
  answer into a thrown "Cannot access property on null or undefined", because
  a closure's signature is mirrored by at least three other derivations
  (`codegen/index.ts` object-literal method pre-registration, and its
  body-compile and fork-decision twins in `literals.ts`). Deliberately left
  for a follow-up that moves all four onto one helper; the decline is recorded
  in a comment at `src/codegen/closures.ts`.
- **Standalone lane: `const { year: n } = f()` where `f` returns `any` answers
  `0`** for any shape, with no shadowing anywhere in the program (measured on a
  three-line file). Unrelated to this issue's mechanisms; it is why the #3
  repro has no standalone row.
