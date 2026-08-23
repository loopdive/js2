---
id: 4643
title: "standalone: raw callable reaches $proto at C1-reconstructed arg-only sites — one write, three wrong answers (w.marker undefined, isPrototypeOf false, getPrototypeOf false); canonicalize at the write"
status: done
completed: 2026-08-23
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: prototype-chain
goal: standalone-gap
related: [4637, 4639, 4506]
origin: "2026-08-23 cross-lane verification thread (#4637/#4639): dev-4639 found an UNCATCHABLE illegal-cast trap on the merged head; dev-4637 verified and isolated it to this shape with controls. The lead removed the trap (test-before-cast in __extern_get's fnctor-proto-start arm) — this issue is the CORRECTNESS half."
---

# #4643 — canonicalize the callable-into-$proto write

## Problem (measured 2026-08-23 on the merged campaign head, three lanes)

```js
var P = function () {};
P.marker = "m";
function G() {}
G.prototype = P;
function H(x) { this.wrapped = x; }
var h = new H(new G());
var w = h.wrapped;
```

| observable | before the lead's mitigation | after | spec |
| --- | --- | --- | --- |
| `w.marker` | **UNCATCHABLE trap** (`illegal cast in __extern_get`) | `undefined` | `"m"` |
| `P.isPrototypeOf(w)` | `false` | `false` | `true` |
| `Object.getPrototypeOf(w) === P` | `false` | `false` | `true` |
| `w instanceof G` | `true` | `true` | `true` |

Established facts (each measured, none guessed — full chain in #4637's and
#4639's issue files):

- The shape needs BOTH ingredients: a FUNCTION-valued prototype AND
  arg-only instantiation. Swap `P` for an object literal and everything is
  correct. The reachability came from #4639's C1 (`NewExpression`-argument
  escape-gate classification); the trap predated nothing — the tip
  answered the same three wrong values minus the trap.
- All three wrong answers share ONE upstream cause: a raw CALLABLE is
  already sitting in `$proto` before any consumer runs, written by a path
  that BYPASSES `__object_create` — #4637's A1 canonicalization choke
  point. `__getPrototypeOf`/`__isPrototypeOf` ref.test and answer false;
  `__extern_get`'s fnctor-proto-start arm ref.cast and trapped (now
  test-before-cast, the lead's mitigation — `object-runtime.ts` ~L2079).
- The write path is NOT identified. Both lanes explicitly declined to
  guess. Candidates to check first (unverified): the S2 fnctor-prototype
  store that `__fnctor_proto_start` reads (`emitFnctorProtoGet` land),
  and the `_fnctorProtoLookup` registration.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding) — including
   methodology item 7 (this issue exists because of that blind spot).
2. TRACE the write: instrument `__fnctor_proto_start`'s store side for the
   repro; find where `G.prototype = P` (P callable) lands the raw closure.
   WAT decode before designing. Do not fix the consumers — three of them
   already disagree; fix the WRITE so all consumers see a canonical
   `$Object` (reuse #4637's `proto-function-value.ts` canonicalize + its
   reverse map so `getPrototypeOf` answers the real function).
3. Acceptance: the three-row table above all-spec-correct; the
   `SUCCESSOR (see #4643)` it.fails pin in tests/issue-4639.test.ts flips
   positive; #4637's CROSS-LANE PREDICTION pin becomes meaningful (score
   31 for the var-then-arg twin is already banked — re-measure the inline
   shape).
4. Verify: #4637's 1,372-row sweep scope re-run before/after (own runs,
   both arms); pins 4637 (19) + 4639 (17) green; zero regressions. Pin
   discipline per the thread's rules: every new pin verified to FAIL on
   base, and pins must EXERCISE the read, not just assert identity
   relations.

## Correction to the problem statement above (measured, 2026-08-23)

**The "Established facts" bullet claiming all three wrong answers share ONE
upstream cause is WRONG, and the control that shows it costs one probe.** Swap
the function-valued `P` for an object literal and run the SAME arg-only shape on
the campaign head `52cb0a6a6`:

| observable | fn-valued `P` (base) | OBJECT-valued `P` (base) |
| --- | --- | --- |
| `w.marker` | `undefined` | **`"m"`** |
| `P.isPrototypeOf(w)` | `false` | **`false`** |
| `Object.getPrototypeOf(w) === P` | `false` (it is `null`) | **`false` (it is `null`)** |

Only the first row is about the callable. The other two are wrong for **every**
`__fnctor_<F>` instance whatever its prototype is, so the write-canonicalization
this issue is named for cannot move them — and a fix that stopped there would
have shipped one third of the table and reported three.

Both defects are real and both are fixed here; see `## Root cause`. The reason
they read as one is that they surface on the same shape: the arg-only site is
where a fnctor instance survives as a STRUCT (`new G()` in argument position is
not consumed as an externref, so it is not reconstructed as an `$Object`), and a
struct is simultaneously the receiver whose `[[Prototype]]` link is a raw
callable and the receiver the chain-walk helpers cannot start from.

## Root cause

Two independent defects, each measured on the campaign head.

**W — the WRITE.** `tryCompileFnctorPrototypeAssign` (`fnctor-prototype.ts`)
stored the RHS of `F.prototype = <value>` into the per-fnctor prototype global
verbatim. That global is not a general value slot: it is the `[[Prototype]]`
LINK for every `__fnctor_<F>` instance, and every consumer of it already assumes
an `$Object` —

- `__extern_get`'s fnctor arm casts `__fnctor_proto_start`'s answer to `$Object`
  to start its walk (the naked `ref.cast` there was #4639's uncatchable trap,
  since mitigated to a test-and-miss);
- `fillFnctorPrototypeDispatchArms`' per-key method caches bake
  `global.get <proto>; ref.cast $Object` in two more places;
- `__closure_proto_of` publishes it to `native-dynamic-instanceof`.

`F.prototype = <function>` was the one write that broke the invariant, so one
store made three consumers disagree.

**C — the CHAIN START.** `__getPrototypeOf` and `__isPrototypeOf`
(`object-runtime-prototype.ts`) resolve a `[[Prototype]]` by testing `$Object`
and reading field 0. An approved constructor's instance is a `__fnctor_<F>`
STRUCT with no `$proto` field at all — its link lives in the same per-fnctor
global, reachable through the `__fnctor_proto_start` ladder `__extern_get`
already uses. Both helpers missed the test and answered `null` / `false` for
every fnctor instance in the program.

## Fix

- `src/codegen/expressions/fnctor-prototype.ts`
  - the store is canonicalized (`__proto_from_function`, #4637's map) so the
    global always holds an `$Object`; the assignment still EVALUATES to the RHS
    (§13.15.2), held in a local so the identity is exact rather than dependent
    on registry state;
  - `emitFnctorProtoGet` — the single point every `.prototype` consumer funnels
    through — maps a registered proto-view back with `__function_from_proto`, so
    `F.prototype === P` and `F.prototype.marker` are unchanged and the internal
    bag is never published;
  - `ensureObjectRuntime` + one flush at the statement boundary, so a module
    whose FIRST touch of the global is the write still canonicalizes it.
- `src/codegen/object-runtime-prototype.ts` — `__getPrototypeOf` and
  `__isPrototypeOf` consult `__fnctor_proto_start` when the receiver/candidate is
  not an `$Object`. `__isPrototypeOf` compares that FIRST link explicitly before
  entering the walk, because the walk deliberately steps to `cur.$proto` before
  its first comparison (so an `$Object` candidate never matches itself,
  §20.1.3.3). Both arms are emitted only when the ladder exists, test before they
  cast, and answer only when the ladder answers non-null — a widening of a
  MISSING answer, never a replacement of a present one.
- `src/codegen/object-runtime.ts` — comment only: the test-before-cast
  mitigation stays and now says why (`G.prototype = 5` can still put a
  non-object there).

## Test Results

Every number below is from a run executed in this worktree, A/B by file-copy
revert of the three source files.

**Scoped standalone sweep, 531 rows** (`language/expressions/instanceof`,
`built-ins/Object/{getPrototypeOf,create,setPrototypeOf}`,
`built-ins/Object/prototype/isPrototypeOf`, `built-ins/Function/prototype/apply`,
`language/expressions/new`):

| arm | pass | fail | compile_error |
| --- | --- | --- | --- |
| base `52cb0a6a6` | 481 | 47 | 3 |
| branch | 481 | 47 | 3 |

**Zero regressions and zero flips** — per-row diff, not just totals. The shape
this issue fixes is not exercised by any row in that scope; the sweep is the
regression proof, and the pins + probes below are the demonstration.

**Eval-tier recheck (lead heads-up, stale quickjs adapter).** 41 of the 531 rows
mint through `eval(`/`Function(`. Rebuilt `compiler-bundle` + provider on BOTH
arms (base resolves to the lead's fresh adapter `222c4381985bb595`, branch to
`cdb85ab33cdbda90`) and re-ran those 41: `35 pass / 6 fail` on both arms, and
identical to the stale-adapter sweep row-for-row. The stale adapter did not
affect any measurement in this issue.

**Targeted rows** (every test262 row that assigns an identifier to `.prototype`),
branch: `S13.2.2_A1_T1`, `_A1_T2`, `S15.5.3.1_A4`,
`Function/prototype/Symbol.hasInstance/this-val-prototype-non-obj` pass;
`S13.2.2_A2`, `Function/prototype/{apply,call}/S15.3.4.{3,4}_A1_T1/T2` still fail
(see Residuals).

**Direct observables**, arg-only shape, base → branch:

| observable | base | branch | spec |
| --- | --- | --- | --- |
| `w.marker` | `undefined` | `"m"` | `"m"` |
| `P.isPrototypeOf(w)` | `false` | `true` | `true` |
| `Object.getPrototypeOf(w) === P` | `false` | `true` | `true` |
| `w instanceof G` | `true` | `true` | `true` |
| `G.prototype === P` | `true` | `true` | `true` |
| `w.constructor === G` | `true` | `true` | `true` |
| `'marker' in w` | `false` | `false` | `true` (residual) |

Robustness probe, base → branch (no trap on either arm): a function-valued
prototype's inherited METHOD CALL `null → "hi"`; a property written on `P` AFTER
the assignment `undefined → "L"`; reassignment `undefined → "two"`; three
repeated reads through the per-key cache `undefined×3 → "mmm"`; an OBJECT-valued
prototype's `getPrototypeOf` `false → true`. Unchanged: `G.prototype = 5` /
`"s"` / `null` (all still a graceful `undefined`), the classic
`F.prototype.x = …` chain, and a two-level chain through a function-valued
prototype (still `undefined` — see Residuals).

**Suites** (branch, counted "N passed" — not exit status):

| suite | result |
| --- | --- |
| `tests/issue-4643.test.ts` (new) | 11 passed |
| `tests/issue-4639.test.ts` | 17 passed (its `SUCCESSOR (see #4643)` `it.fails` flipped positive) |
| `tests/issue-4637.test.ts` | 19 passed (its `CROSS-LANE PREDICTION` `it.fails` reached the predicted **31** and is now an ordinary pin) |
| `tests/issue-4506.test.ts` | 22 passed |
| `tests/issue-4480.test.ts` | 19 passed (R3/R4/R5 retired — see that issue's Residuals note) |
| `issue-1472-es5-getprototypeof`, `es5-standalone-instanceof`, `instanceof`, `issue-3962-native-user-instanceof` | 42 passed |
| `issue-2660-{s2,s3,m3-closure-prototype-edge,fnctor-escape-gate}` | 45 passed, 1 failed — **pre-existing**, verified by running the same file on base (`non-reconstruct fnctor (no new) keeps existing prototype behaviour`) |
| `issue-3768`, `issue-2580-m3-{protochain,protoextend}`, `issue-3037` | 20 passed, 7 failed — **all 7 pre-existing**, identical list on base |
| `issue-4491-proto-index-constructor-shadow`, `issue-4623`, `issue-4194-instance-expando` | passed |

**Function-budget gate**: the two new arms were extracted to module-level
builders (`fnctorGetPrototypeArm`, `fnctorIsPrototypeOfSeed`,
`fnctorProtoLocal`, plus the pre-existing boundary fallback as
`boundaryGetPrototypeArm`) so `buildObjectPrototypeHelpers` and
`ensureObjectRuntime` both come in at budget with **no allowance**. The
extraction was verified BYTE-IDENTICAL — sha256 of the emitted binary for four
modules (the repro, a plain object read, the classic `F.prototype.k` chain, an
object-valued prototype) is unchanged across it, so the sweep measured above
still describes the committed tree.

**New pins verified to FAIL on base**: the 6 demonstrating pins in
`tests/issue-4643.test.ts` fail on base and pass on branch; the 4 labelled
REGRESSION GUARD and the 1 residual pin pass on both. Each pin EXECUTES the
operation it guards (reads the property, calls `isPrototypeOf`, calls
`getPrototypeOf`), and the discrimination pin's receivers come out of an array
indexed by a loop-carried counter so no fold can bypass the path under test.

## Residuals

| shape | measured | why | owner |
| --- | --- | --- | --- |
| `"marker" in w` | `false` (spec `true`) | `__extern_has` has no fnctor chain start — the third member of family C. NOT widened here: that helper also drives `for…in` liveness re-checks and sits beside the own-only predicates carrying the #4017 −684 warning. Measured `false` for an OBJECT-valued prototype too, so it is generic, not callable-specific. Pinned `it.fails`. | successor |
| `built-ins/Function/prototype/{apply,call}/S15.3.4.{3,4}_A1_T1/T2` | still fail | The cross-lane expectation was that these heal here. **They do not, and the reason is a different limitation:** they need `typeof obj.apply === "function"`, i.e. `%Function.prototype%` reachable THROUGH a function-valued prototype. #4637's bag has a null `$proto` by design, so the chain stops at the bag. Measured on branch: the OWN half now works (`o.k` through the same link reads `"v"`), `P.apply` direct is `"function"`, an OBJECT-valued prototype does reach `%Object.prototype%` (`typeof o.toString === "function"`), and `o.apply` through a function-valued prototype is still `undefined`. Linking the bag's `$proto` to `%Function.prototype%` changes every closure's own-property table and is its own issue. | successor (#4637 A1's stated non-claim) |
| `Object.setPrototypeOf(<fnctor instance>, X)` | silent no-op | the receiver is not an `$Object`; `getPrototypeOf` now reports the constructor's prototype rather than `null`, i.e. a stale answer where there was a missing one. Neither is right; not a regression of a correct answer. | successor |
| §9.1.13 snapshot semantics | reassigning `F.prototype` retro-changes EXISTING fnctor-struct instances | those instances resolve their link through the mutable global, not a per-instance field. Pre-existing, unchanged here, and the same thing #4480 R5's "condition 2" is about. | S3 (per-site capture) |
