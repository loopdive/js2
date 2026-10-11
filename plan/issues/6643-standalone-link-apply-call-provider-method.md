---
id: 6643
title: "standalone: `Function.prototype.apply`/`.call` on a PROVIDER-OWNED method value returns `null` — the `__apply_closure` peer arm claims the consumer's OWN `%Function.prototype%` glue closure"
status: done
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
goal: standalone-gap
parent: 5383
requested_by: ttraenkler/fable-lead
created: 2026-09-19
completed: 2026-09-19
# (#5383 S65, 2026-09-19) Grants restated HERE, not left to #5383: CI diffs the
# merge preview against `main`, where #5383's grant does not cover this path
# (stranded-grant class). +33 LOC in `object-runtime.ts` is this change-set's
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
   requires that the callee is **not one of this module's own transferred
   native-prototype method closures**. The glue then takes its own local
   dispatch, and the `__apply_closure(target, …)` **inside** it — where
   `target` really is provider-owned — takes the peer arm as #6420 intended.
   The predicate is the *exact* claim test
   `buildTransferredNativeProtoCallInstrs` already uses (`ref.test` on the
   per-(brand, member) meta subtype plus the `bfnid` exact-identity re-check,
   a MODULE-LOCAL type index, which is what makes it an ownership answer and
   not a structural one); it is exported as
   `buildTransferredNativeProtoOwnedBitInstrs`. No such closures ⇒ the
   conjunct is omitted and the arm keeps its pre-#6643 shape.

   **A broader predicate does not work, and this cost a measurement.** The
   first cut asked `__is_callable(fn) == 0` ("this module does not recognise
   the callee"). It fixes every #6643 case, and it BREAKS the reverse
   direction: an ORDINARY consumer closure invoked inside the provider is
   locally callable there too, so `tests/issue-6605-link-reverse-method-call`
   and `tests/issue-6616-static-objlit-spread-rest-abi` (LINKED case) both
   went `7` → `null`. The narrow predicate keeps them green and additionally
   fixes the `X.prototype.m.apply(instance)` shape the broad one did not.
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
| `NS.get.apply(new NS.Base(4), [])` | `null` | `4` |
| `NS.get.call(new NS.Base(4))` | `null` | `4` |

Controls that must not move — and did not: `NS.id(3)`, `NS.from(3).get()`,
`new NS.Base(4).get()`, `NS.id.bind(undefined)(3)`, `lf.apply/.call/.bind`,
`L.prototype.inst.apply(new L(0), [1])`, `new L(9).get()`, and the #6493
`CreateListFromArrayLike called on non-object` TypeError.

## Real rows — they MOVE, none flips to pass

`JS2WASM_TEMPORAL_CACHE=.test262-cache/s65-{2 base, 6 fix}`, four-file run:

| row | base | fix |
| --- | --- | --- |
| `PlainDate/from/subclassing-ignored.js` | `Test262Error: Expected SameValue(«null», «null»)` | `TypeError: called value is not a function` |
| `Duration/from/subclassing-ignored.js` | `Test262Error: Expected SameValue(«null», «null»)` | `TypeError: called value is not a function` |
| `Duration/prototype/abs/subclassing-ignored.js` | `TypeError: called value is not a function` | unchanged |
| `ZonedDateTime/prototype/add/subclassing-ignored.js` | `TypeError: called value is not a function` | unchanged |

The provider compiles to **byte-identical** output (3 334 356 B at base and
fix) — this slice is consumer-side only.

## What the slice DOES buy on the real provider, and what still blocks the rows

`TemporalHelpers.checkSubclassingIgnoredStatic` runs three helpers in order.
Probe `.tmp/s65/probes/p23.js` replicates the first two inline against the real
provider and, on the fix tree, **every one of their cases now answers
correctly** — all eight `checkStaticInvalidReceiver` receivers (`undefined`,
`null`, `true`, `"test"`, `Symbol()`, `7`, `7n`, `{}`), the
`checkStaticReceiverNotCalled` function receiver, and
`Object.getPrototypeOf(result) === construct.prototype`, `calendarId`,
`monthCode`. On the base tree the very first of those answered `null`.

Two things still block a pass, neither of them this slice:

1. **The third helper, `checkThisValueNotCalled`**, builds
   `class MySubclass extends construct` and calls `MySubclass[method](…)` — a
   static INHERITED from a provider class object. Replicated inline against
   the real provider (`.tmp/s65/probes/p24.js`, fix tree):
   `typeof MySubclass.from` → `undefined`, `MySubclass.from("2000-05-02")` →
   `TypeError: called value is not a function` (the exact row text),
   `MySubclass["from"](…)` → `null`,
   `Object.getPrototypeOf(MySubclass) === Temporal.PlainDate` → `false`,
   `new MySubclass(2000,5,2)` → `null`, while `Temporal.PlainDate.from(…)` in
   the same module answers `2000`. That is the static half of the
   #6640 / #6644 extends-a-linked-provider-class work — a derived class object
   gets no [[Prototype]] link to its provider parent, so no static is
   inherited — and it is what all four rows now stop on.
2. **`instanceof` across the link answers `false`, always.** Measured directly
   (p21/p22): `Temporal.Duration.from({days:1}) instanceof Temporal.Duration`
   is `false` for a DIRECTLY constructed provider instance, with or without
   `%Function.prototype%` materialized, while
   `Object.getPrototypeOf(…) === Temporal.Duration.prototype` is `true`. #6640
   already pins this in its own CONTROLS as a deliberate pre-existing
   residual. `TemporalHelpers.assertDuration` opens with
   `assert(duration instanceof Temporal.Duration)`.

## Validation

- **Full four-family + regression battery, 3 684 rows** (`.tmp/s65/battery/`,
  `JS2WASM_TEMPORAL_CACHE=.test262-cache/s65-6`), every group diffed against
  the S64 head: **0 pass→fail, 0 fail→pass, 0 missing, in all thirteen** —
  `PlainDate` 120, `Duration` 120, `PlainDateTime` 120, `ZDT` 120, `A` 1250,
  `B` 205, `C` 349, `D` 300, `E-unlinked` 300, `E-linked` 300, `F-class` 250,
  `F-methoddef` 100, `F-objproto` 150. The four Temporal families hold at
  **459/480** (117 / 108 / 117 / 117), the S64 number.
- **Byte corpus A/B** (84 modules × {gc, standalone}) against a TRUE base run
  (the four touched files file-copy-reverted to `32967877d8`, re-measured,
  restored): **0 status flips, 0 sha flips** — `gc` byte-identical and
  standalone growth **0 bytes**. Every new instruction sequence sits behind a
  guard that is false unless the module CONSUMES a standalone provider, and no
  corpus module does.
- **Equivalence gate**: 22 failing / 1720 passing / 22 known-failures — no new
  regressions.
- **Witness sweep**, `tests/issue-66*` + `issue-6484-*` + `issue-6493-*` +
  `issue-6630-*`: **47 files / 273 tests, 0 failed** under Node **22.22.2**
  and Node **25.9.0**.
- Gates run green: `typecheck`, `check-loc-budget` and `check-func-budget`
  (both at the local merge-base and at `LOC_GATE_BASE=origin/main`),
  `check-coercion-sites`, `check:oracle-ratchet`,
  `check:speculative-rollback`, `check:issue-ids:against-main`,
  `update-issues --check`, `check-issue-spec-coverage`, `lint`,
  `prettier --check`, `check-compiler-boundaries --mode inventory`,
  `check:dead-exports` (exit 0; the pre-existing moved-runtime red on
  `optimize.ts` / `platform-capability-adapter.ts` is inherited, not this
  change-set's).

## Next step

Static-member inheritance through a linked-provider heritage clause
(`class S extends Temporal.PlainDate {}` ⇒ `S.from`) is the blocker for all
four rows and belongs with #6640/#6644. Cross-link `instanceof` is the blocker
behind it.
