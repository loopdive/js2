---
id: 6645
title: "standalone: a spread into a member callee mis-binds formals — the `era` `SameValue(«null», «undefined»)` on four Temporal rows"
status: in-progress
assignee: ttraenkler/sendev-s68
sprint: current
priority: high
horizon: m
goal: standalone
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-09-20
# (2026-09-20) Both splices are guard-and-delegate blocks in the ONE function
# that owns member-call dispatch (`compileReceiverMethodCall`); the mechanism
# itself lives in `src/codegen/standalone-dynamic-spread-call.ts`. Putting them
# anywhere else would either miss the resolved-method arm (which claims every
# object-literal method) or claim spread-free calls.
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
---

## Problem

Four test262 rows fail with `Test262Error: Expected SameValue(«null»,
«undefined») to be true`, raised inside `temporalHelpers.js`:

- `test/built-ins/Temporal/PlainDate/from/argument-object-valid.js`
- `test/built-ins/Temporal/PlainDate/from/argument-string.js`
- `test/built-ins/Temporal/PlainDate/from/subclassing-ignored.js`
- `test/built-ins/Temporal/Duration/from/subclassing-ignored.js`

The issue was scoped as "an `undefined` → `null` resurrection on the provider's
`era` read". **It is not.** Measured against the real standalone provider
through eight different routes — `C.from(s)`, `C.from(var)`,
`C.from.apply(undefined, args)`, `C.from.apply({}, args)`, `C["from"](...args)`,
`C.from(...args)`, `C[m].apply(…)`, and a `class Sub extends C` —
`PlainDate.prototype.era` answered `undefined` **every time**, with
`typeof === "undefined"`, `=== undefined` true, `=== null` false, no own
property and `"era" in date` false (`.tmp/s68/probes/e4.js`).

## Root cause — two argument-binding defects in the member-call dispatch

Both are in `compileReceiverMethodCall`, on the host-free lane, and both need a
SPREAD at the call site.

### 1. A positional argument that FOLLOWS a spread

`o.m(a, ...src, b)`. The resolved-method arm IS spread-aware (#6616), but it
binds formals through `compileSpreadCallArgs`, whose own header states the
model: "each spread is assumed to cover exactly the parameter slots left over
after the trailing positional args are reserved (#2053)". That accounting is a
COMPILE-TIME one; `src.length` is a runtime number, so with a trailing argument
present the binding shifts. Measured (`.tmp/s68/probes/e2.js`, `EXP = [2000, 5,
"M05", 2]`):

| call | answer |
| --- | --- |
| `TemporalHelpers.assertPlainDate(D, ...EXP, "desc")` | `year result: Expected SameValue(«2000», «"desc"»)` — the `year` formal got the TRAILING argument |
| `TemporalHelpers.assertPlainDate(D, 2000, 5, "M05", 2, "desc")` | ok |
| `TemporalHelpers.assertPlainDate(D, 2000, 5, "M05", 2)` | ok |

`assertPlainDate(date, year, month, monthCode, day, description = "", era =
undefined, eraYear = undefined)` — a shifted binding puts a value in `era`, and
`canonicalizeCalendarEra`'s `assert.sameValue(eraName, undefined)` is what
reports it. Rows 1 and 2 write exactly
`TemporalHelpers.assertPlainDate(result, ...expected, desc)`.

### 2. A spread into a callable PROPERTY

The arm that claims a method the compiler cannot resolve to a struct function
(`compileCallablePropertyCall`) marshals one local per AST argument node on
BOTH of its paths, so the spread's source array arrives as formal ZERO.
Measured with a controlled fake constructor (`.tmp/s68/probes/ea.js`):

| call | result | log |
| --- | --- | --- |
| `TemporalHelpers.checkThisValueNotCalled(F, "from", ["x"], fn)` | ok | `from(4,x)`, `RA` |
| `TemporalHelpers.checkThisValueNotCalled(...[F, "from", ["x"], fn])` | `SameValue(«null», «undefined»)` | **empty** |
| `TemporalHelpers.checkStaticInvalidReceiver(...[F, "from", ["x"], fn])` | `TypeError: Cannot read properties of undefined (reading 'apply')` | **empty** |

The last row names the mechanism outright: `construct[method]` was evaluated on
the ARRAY. The `SameValue(«null», «undefined»)` in the middle row is the
helper's `assert.sameValue(Object.getPrototypeOf(result), construct.prototype)`
— `construct` being an array makes `.prototype` `undefined`, and the
never-called `MySubclass[method](...)` makes `result` null.

Rows 3 and 4 reach this through `checkSubclassingIgnoredStatic(...args) {
this.checkStaticInvalidReceiver(...args); … }`. The per-helper asymmetry (some
helpers surviving a spread, others not) is why the three helpers called
DIRECTLY all passed (`.tmp/s68/probes/p7.js`) while the ENTRY failed
(`.tmp/s68/probes/e5.js`) — the reduction that pointed at the call shape rather
than at the provider.

## Fix

Two guard-and-delegate splices in `compileReceiverMethodCall`, both routing to
`src/codegen/standalone-dynamic-spread-call.ts` (the #6646 leaf), whose terminal
builds a runtime `__objvec` argv through #6616's shared spread expander and
invokes `__apply_closure(callee, receiver, argv)`:

1. `tryEmitStandaloneTrailingSpreadCall` — **before** the resolved-method arm,
   because that arm claims the call whenever `funcIdx` is defined, which is the
   case for every object-literal method. Gated on a non-spread argument
   FOLLOWING a spread: the one shape the static accounting provably cannot
   express. A spread-only list keeps its existing (correct, cheaper) lowering.
2. `tryEmitStandaloneDynamicSpreadCall` — before `compileCallablePropertyCall`,
   gated on a spread being present at all, because that arm is fixed-arity for
   every spread.

Both inherit the leaf's gates: host-free lane only, and a side-effect-free
receiver spelling (`this`, an identifier, or a property-access chain over
those), since the terminal reads the receiver for `this` and then compiles the
callee expression, which reads it again. Everything is wrapped in
`withSpeculativeCompile`, so a decline emits nothing.

## Rows — before / after

Measured with a fresh provider prewarmed from HEAD (`--target both`,
`cacheHit=false`), `JS2WASM_TEMPORAL_CACHE=…/s68-4`:

| row | S67 head | splice 2 only | both splices |
| --- | --- | --- | --- |
| `PlainDate/from/argument-object-valid.js` | `SameValue(«null», «undefined»)` | same | **pass** |
| `PlainDate/from/argument-string.js` | `SameValue(«null», «undefined»)` | same | **pass** |
| `PlainDate/from/subclassing-ignored.js` | `SameValue(«null», «undefined»)` | **pass** | **pass** |
| `Duration/from/subclassing-ignored.js` | `SameValue(«null», «undefined»)` | **pass** | **pass** |

The middle column is the intermediate measurement that attributes each row to
its own defect.

## Residuals measured, NOT fixed

1. **A spread with NO trailing argument does not apply a DEFAULT to the
   unfilled formal.** `NS.take(1, ...[2000, 5])` against `take(a, b, c, e =
   "DEF")` answers `number/2000/5/NULL` on BOTH trees (`.tmp/s68/r/t2.mts`) —
   the unfilled formal gets a typed null instead of `"DEF"`. Same
   null-for-undefined family as the row symptom, in the arm this slice
   deliberately does not claim (splice 1's gate requires a trailing argument).
   Nothing in the four rows depends on it.
2. **`this.<m>(…)` where `m` reads `arguments` answers `null`** — with or
   without a spread. Recorded in #6646; it is what made S67's residual 1 look
   like a spread defect.
3. **`var NS = { f: someFunction }; obj.fwd(...args) → NS.f(...args)` traps**
   (`dereferencing a null pointer`) — hit twice while writing probes
   (`.tmp/s68/probes/e7.js`, `e8.js`, both removed from the committed probes).
   A stored-function-property call through a rest forward; orthogonal, not
   reached by any row here.
4. **A function declaration with a DEFAULT parameter, declared in a test file
   that also includes `temporalHelpers.js`, returns `null`** — `defp(1)` with
   `function defp(a, b = undefined)` answered `null` inside the harness module
   but `b:UNDEF` in a harness-free module (`.tmp/s68/probes/e1.js` vs `e3.js`).
   Module-scale dependent; not reduced further.
