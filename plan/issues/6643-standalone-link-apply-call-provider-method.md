---
id: 6643
title: "standalone: `Function.prototype.apply`/`.call` on a PROVIDER-OWNED method value returns `null` — the `__apply_closure` peer arm claims the consumer's OWN `%Function.prototype%` glue closure"
status: in-progress
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
goal: standalone-gap
parent: 5383
requested_by: ttraenkler/fable-lead
created: 2026-09-19
# (#5383 S65, 2026-09-19) Grants restated HERE, not left to #5383: CI diffs the
# merge preview against `main`, where #5383's grant does not cover this path
# (stranded-grant class). +29 LOC in `object-runtime.ts` is this change-set's
# own, measured at the branch base 32967877d8 (12710).
loc-budget-allow:
  - src/codegen/object-runtime.ts
func-budget-allow:
  # The one existing decision point the new conjunct must splice into: the
  # `__apply_closure` peer-dispatch arm added by #6420 lives inside this
  # builder, and the #6643 predicate has to be evaluated there, as part of it.
  # Splitting the builder is a refactor of long-standing code this change does
  # not otherwise touch.
  - src/codegen/object-runtime.ts::fillApplyClosure
---

# #6643 — `apply`/`call` on a linked-provider method value answered `null`

## Target (S65 dispatch)

`test/built-ins/Temporal/PlainDate/from/subclassing-ignored.js` and
`test/built-ins/Temporal/Duration/from/subclassing-ignored.js`, whose first
assertion is `TemporalHelpers.checkStaticInvalidReceiver`'s
`construct[method].apply(value, methodArgs)`.

## Root cause (fully reduced, real provider, no speculation)

`__apply_closure`'s #6420 peer arm is unshifted **ahead** of the module's own
closure dispatch and fires on `peer.callableKind(fn) & 1`. That predicate is
**not a statement about ownership**: the provider's `__is_callable` answers `1`
for a CONSUMER-owned closure that crossed into it too.

So for `f.apply(thisArg, args)` in a consumer where `%Function.prototype%` is
materialized *and* `.apply` has been read as a value, the ladder resolves
`apply` to the consumer's own #6630 glue, `__closure_method_call` hands that
**glue closure** to `__apply_closure`, the peer arm claims it, and the whole
operation is shipped to the provider — which cannot run a consumer closure and
answers the null sentinel.

Measured against the real `@js-temporal/polyfill` provider (probes under
`.tmp/s65/probes/`, `JS2WASM_TEMPORAL_CACHE=.test262-cache/s65-2`):

- **The peer arm IS taken.** An `unreachable` spliced into it traps with
  `__apply_closure ← __closure_method_call ← __extern_method_call ←
  __call_m_apply_2` (p13).
- **The provider function is never entered.** `Temporal.PlainDate.from.apply(
  undefined, ["not-a-date"])`, which MUST throw a RangeError, answered `null`
  instead; so did every other argument kind — string, object, two-argument,
  literal and variable (p18). With the peer arm disabled the same probe
  throws the RangeError and every other case answers correctly (p18 under
  `JS2WASM_DBG_NOPEERARM`), which is the one-bit proof that argument
  marshalling was never the issue.
- **The trigger is a `.apply` VALUE read, not `%Function.prototype%` itself.**
  p16 (`typeof Function.prototype.apply` present, no `.apply` read off a
  provider callable) passes everything; p18 (p16 + `typeof C.from.apply` +
  `C.from.apply === Function.prototype.apply`) fails everything; p17 (p13
  minus those two lines) passes everything.
- **`.call` failed differently and for a second reason.** `%Function.prototype%
  .{call,apply,bind}` guard their receiver with `__typeof_function`, which only
  knows THIS module's carrier shapes, so a provider-owned receiver was rejected
  with `Function.prototype.call called on non-callable receiver`.

## The fix

Three parts, each independently guarded so a module off the linked-consumer
lane emits identical bytes:

1. **`object-runtime.ts::fillApplyClosure`** — the #6420 peer arm additionally
   requires `__is_callable(fn) == 0`. The glue then takes its own local
   dispatch, and the `__apply_closure(target, …)` **inside** it — where
   `target` really is provider-owned and locally not callable — takes the peer
   arm as #6420 intended. Absent `__is_callable` the conjunct is omitted and
   the arm keeps its pre-#6643 shape.
2. **`closures/transferred-native-proto.ts`** — the variadic native-proto arm
   admitted an `$ObjVec` carrier and then re-wrapped its data array with a
   **bare `ref.cast`**. Newly reachable once (1) stops the peer arm from
   short-circuiting, that turned `<provider callable>.call(…)` into an
   **uncatchable `illegal cast` trap**. The admission predicate now asks
   whether the cast is sound (`ref.test` on the data array) and declines
   otherwise, leaving the ordinary arity dispatch to answer.
3. **`function-proto-invokers.ts::pushIsCallableGuard`** — §20.2.3 step 2 gains
   the peer's `callableKind` bit 0 as a **disjunct** (new helper
   `linkedForeignCallableBitInstrs` in `standalone-link-boundary.ts`), so a
   provider-owned receiver is no longer rejected outright.

## Witness — `tests/issue-6643-link-apply-call-provider-method.test.ts`

File-copy revert of the four changed files to `32967877d8` (2026-09-19), same
fixture, base → fix:

| expression | base | fix |
| --- | --- | --- |
| `NS.id.apply(undefined, [3])` | `null` | `3` |
| `NS.id.call(undefined, 3)` | `null` | `3` |
| `NS.id.apply(7, [3])` | `null` | `3` |
| `NS.from.apply(undefined, [3]).get()` | `!Cannot read properties of undefined (reading 'get')` | `3` |
| `NS.from.call(undefined, 3).get()` | same | `3` |
| `callOnNonCallable()` (§20.2.3 step 2) | `no-throw` | `Function.prototype.apply called on non-callable receiver` |
| `NS.get.apply(new NS.Base(4), [])` | `null` | `!Cannot read properties of undefined (reading a class field)` |

Controls that must not move — and did not: `NS.id(3)`, `NS.from(3).get()`,
`new NS.Base(4).get()`, `NS.id.bind(undefined)(3)`, `lf.apply/.call/.bind`,
`L.prototype.inst.apply(new L(0), [1])`, `new L(9).get()`, and the #6493
`CreateListFromArrayLike called on non-object` TypeError.

## Real rows — they MOVE, none flips to pass

`JS2WASM_TEMPORAL_CACHE=.test262-cache/s65-{2 base, 4 fix}`, four-file run:

| row | base | fix |
| --- | --- | --- |
| `PlainDate/from/subclassing-ignored.js` | `Test262Error: Expected SameValue(«null», «null»)` | `TypeError: Cannot access property on null or undefined at 199:27365` |
| `Duration/from/subclassing-ignored.js` | `Test262Error: Expected SameValue(«null», «null»)` | `Test262Error: instanceof` |
| `Duration/prototype/abs/subclassing-ignored.js` | `TypeError: called value is not a function` | `Test262Error: instanceof` |
| `ZonedDateTime/prototype/add/subclassing-ignored.js` | `TypeError: called value is not a function` | `Test262Error: epochNanoseconds result Expected SameValue(«0n», «15n»)` |

The provider compiles to **byte-identical** output (3 334 356 B at both base and
fix) — this slice is consumer-side only.

## Why they still fail — two blockers, neither this slice

1. **`instanceof` across the link answers `false`, always.** Measured directly
   (p21/p22): `Temporal.Duration.from({days:1}) instanceof Temporal.Duration`
   is `false` for a DIRECTLY constructed provider instance, with or without
   `%Function.prototype%` materialized, while
   `Object.getPrototypeOf(…) === Temporal.Duration.prototype` is `true`. This
   is exactly the residual #6640 pins in its own CONTROLS
   (`(new NS.Base(3)) instanceof NS.Base` → `"false"`, "PRE-EXISTING, pinned
   deliberately"). `TemporalHelpers.assertDuration` opens with
   `assert(duration instanceof Temporal.Duration)`, so the two `Duration` rows
   cannot pass until cross-link `instanceof` lands.
2. **`PlainDate.from` / `PlainDateTime.from` fail INSIDE the provider when
   entered through `__apply_closure`** — `TypeError: Cannot access property on
   null or undefined at 199:27365` — for every argument kind and every
   receiver (p19/p20). `Duration.from` and `PlainTime.from` through the same
   route answer correctly, so it is specific to those two statics, not to the
   route. Newly *exposed* by this slice (the base answer was a silent `null`
   because the provider was never entered), not newly *created*.

## Next step

Cross-link `instanceof` (the #6640/#6625 residual) is the blocker for two of
the four rows; the `PlainDate.from`-under-`__apply_closure` failure at provider
`199:27365` is the blocker for the third. Both want their own slice. Reduce (2)
by dumping the provider WAT around the `PlainDate_from` static and comparing
the `__current_this` / calendar-default reads on the `__call_fn_method_N` entry
against the `__call_m_from_1` entry.
