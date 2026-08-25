---
id: 3920
title: "standalone: three of five reflective operations answer nothing once a closed-struct receiver arrives as `any`"
status: done
completed: 2026-08-08
assignee: "ttraenkler/opus-forin, ttraenkler/opus-forin-2"
sprint: 78
created: 2026-07-31
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
language_feature: objects, operators
goal: correctness
related: [2847, 2130, 3673, 3780, 3927, 4071, 4213]
loc-budget-allow:
  # The three reflective finalize passes must gain their arms where they are
  # (object-runtime), and index.ts gains one call at each of the two finalize
  # sites. The new predicate lives in its own module.
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
  # (#3920 second slice) +6 in object-ops: one import and the four-line call
  # site that hands `hasOwnProperty`/`propertyIsEnumerable`'s folded `1` to
  # the new module. The whole emission — presence resolution, scratch-compile,
  # operand confirmation — lives in `closed-struct-presence.ts`; what remains
  # here is the call itself, which cannot be moved out of the caller.
  - src/codegen/object-ops.ts
func-budget-allow:
  - src/codegen/object-runtime.ts::fillClosedStructHasOwnArms
  - src/codegen/object-runtime.ts::fillClosedStructOwnPropertyNamesArms
  # One line each: the new finalize pass must be called at both finalize sites.
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  # (#3920 second slice) The two folding call sites. Each gains its guarded
  # call plus, in `compileInOperator`, the one local that carries the
  # receiver's struct type from where it is resolved to where it is asked.
  # The emission itself is in `closed-struct-presence.ts`.
  - src/codegen/binary-ops-in.ts::compileInOperator
  - src/codegen/object-ops.ts::compilePropertyIntrospection
origin: "found while writing #3780 round 4's presence-packing regression test — the fixture disagreed across lanes and reproduced identically with the change disabled"
---

# #3920 — reflection over a closed compiler struct in the standalone lane

## Problem

**All reflective operations work on a *statically-typed* closed-struct
receiver; three of five break the moment the receiver is `any`.**
`hasOwnProperty` and `Object.getOwnPropertyNames` are the dynamic operations
still reaching a correct answer; `Object.keys`, `for…in` and `in` are not.

There is no throw and no refusal — a JavaScript program that enumerates a
compiled object's properties silently sees an empty object.

Measured on `main` @ `e9b290a3a`, standalone, three-property instances, every
fixture wholly constructor-assigned. Standalone value, host in parentheses,
`X` = wrong:

```
receiver spelling             keys      gopn        in     forin   hasOwn
class, typed at the use site  3(3)      3(3)      1(1)      3(3)     1(1)
class, via a local `any`     X0(3)      3(3)     X0(1)     X0(3)     1(1)
class, via a parameter       X0(3)      3(3)     X0(1)     X0(3)     1(1)
fnctor, via a local `any`    X0(3)      3(3)     X0(1)     X0(3)     1(1)
fnctor, via a parameter      X0(3)      3(3)     X0(1)     X0(3)     1(1)
object literal (control)      3(3)      3(3)      1(1)      3(3)     1(1)
```

**The discriminator is receiver *spelling*, not the operation.** A statically
typed receiver never enters the dynamic runtime at all — codegen resolves the
field set at compile time — so row 1 cannot exhibit the bug. That is worth
stating explicitly because measuring row 1 makes the defect read as "works",
which caused a transient cross-lane disagreement during triage (since
withdrawn; not an open question).

**It is not a "fnctor" defect.** Class instances and constructor-function
instances fail identically. The boundary is the dynamic path over **any closed
struct**.

## Root cause

`src/codegen/index.ts:4450-4452` wires exactly three closed-struct arm-filling
passes at finalize. Six dynamic helpers back the five reflective surfaces.
Three got arms; three never did — and the split matches the measured matrix
3-for-3:

| helper | closed-struct arms | surface | measured |
| --- | --- | --- | --- |
| `__object_hasOwn` / `__hasOwnProperty` / `__propertyIsEnumerable` | `fillClosedStructHasOwnArms` | `hasOwnProperty` | ✓ |
| `__getOwnPropertyNames` | `fillClosedStructOwnPropertyNamesArms` | `Object.getOwnPropertyNames` | ✓ |
| `__extern_get` | `fillClosedStructExternGetArms` | computed read `o[k]` | ✓ |
| `__object_keys` | **none** | `Object.keys` | ✗ 0 |
| `__object_keys_forin` | **none** | `for…in` | ✗ 0 |
| `__extern_has` | **none** | `in` | ✗ 0 |

Each of the three without arms treats a non-`$Object` receiver as having no
properties.

### ⚠ The trap: do NOT simply copy the working three onto the failing three

That is the obvious move and it is **wrong**. It was implemented, measured and
**reverted** (#4071, and the reasoning is preserved in `object-runtime.ts`).
`ctx.structFields` is the compiler's whole nominal struct set and includes
**builtin carriers** whose internal fields are not `$`/`__`-prefixed, so the
existing name-shaped filters do not remove them. Sharing the arms naively made
`Object.keys(new Date(0))` answer `["timestamp"]` and `Object.keys(/ab/)`
answer 7 internal RegExp fields.

**`Object.keys(new Date(0))` is correct on unfixed `main` only BY ACCIDENT** —
it answers `[]` because it enumerates nothing at all, and nothing happens to be
right for a Date. So the fix, at the exact moment it starts working, regresses
the builtin case unless the provenance predicate is already in place.

**And the leak is already live**, through the one surface that does have arms —
this row is a new finding, recorded nowhere before this issue:

| | standalone (`main`) | correct |
| --- | ---: | ---: |
| `Object.getOwnPropertyNames(/ab/g)` | **7** | 1 |
| `Object.getOwnPropertyNames(new Date(0))` | **1** | 0 |

Order is wrong too, not just membership: `gOPN(/ab/)[0]` does not start at
`lastIndex`.

The correct sequencing is therefore **predicate first, then share** — the
predicate is a *precondition*, not step 1 of 3. `isSyntheticStructName` is not
it and cannot be widened into it: it screens only `Wrapper*` / `$AnyValue` /
`__vec_*` / `__arr_*`, and `Date`/`RegExp` pass straight through.

## Why it blocks other work

#3927's emission slice and #4213. A per-type-layout receiver is *usually*
dynamic — the analysis pins a single label only where exactly one is provable,
so every unpinned receiver takes precisely this broken path. **While
enumeration is dead, no differential can distinguish a correct layout split
from a broken one**, and a green reflective check is not coverage.

The related retraction, so it is not rebuilt on: #4211's silent wrong-AST
divergence was attributed to acorn's `copyNode` (`for (var p in node) …`).
That attribution is **withdrawn** — a loop that enumerates nothing cannot copy
anything, and `copyNode` was separately measured executing zero times on the
corpus. The three reflective passes #4211 wired did fix the divergence, but the
mechanism is unknown.

## Fix (this branch)

1. **`src/codegen/user-declared-structs.ts`** (new) — `isUserDeclaredStruct`,
   the predicate #4071 asked for by name. A **whitelist**, deliberately:
   ~40 `structFields.set` sites are overwhelmingly builtin carriers and grow
   continuously, so a blacklist is wrong by default and fails *silently* to a
   leak. A whitelist fails to *today's* behaviour — a missed registration costs
   a missing feature, never a wrong answer. Three admitted kinds: user `class`
   declarations (via `ctx.classDeclarationMap`, whose value type is
   `ts.ClassDeclaration | ts.ClassExpression` — user syntax by construction),
   `__fnctor_` structs, and `__anon_` object-literal/inferred shapes. Tuples are
   excluded on purpose: a tuple is a JS *array*, whose own keys are the index
   strings the vec arm already produces.
2. **One shared derivation and one shared emitter** —
   `collectClosedStructEnumerationEntries` / `buildClosedStructEnumerationArms`,
   so `getOwnPropertyNames`, `Object.keys` and `for…in` cannot drift apart
   again.
3. **`fillClosedStructEnumerationArms`** (new pass) on `__object_keys` and
   `__object_keys_forin`.
4. **`__extern_has` joins `fillClosedStructHasOwnArms` in a new `hasProperty`
   mode.** This is the own-vs-`in` semantic difference and it is why
   `__extern_has` could not simply be appended to the target list: for
   `hasOwnProperty` a shape match is the *final* answer, but `in` is §7.3.12
   HasProperty (own **or inherited**), so a miss must **fall through** to the
   prototype walk rather than return 0. Same for tombstones: `delete o.x` does
   not make `"x" in o` false when the prototype carries `x`.

### The non-obvious half: fixing the key source was measurably not enough

After `__object_keys_forin` was fixed, `Object.keys` went 0 → 3 but **`for…in`
was still 0**. The dynamic for-in loop (`statements/loops.ts`) performs a
per-visit liveness re-check through `__extern_has` on every key it enumerates.
With no closed-struct arm it answered "absent" for each of the names the key
vector had just correctly produced, so the loop skipped all of them. `in` and
`for…in` share a root cause; both halves are required.

### Layout-independence — the constraint from #3927, evaluated rather than accepted

The constraint as passed to this work was "derive the enumerable name list from
the base presence words, not the struct field list". **That does not hold as
written**: a presence word carries *bits, not names*, and only
*conditionally*-assigned fields get one at all — unconditional fields have no
presence bit. There is nothing to derive names from.

The defensible version, which is what the working `getOwnPropertyNames` arm
already did and what this change preserves: **names from the base struct's
field list; per-name liveness from the base presence words.** Presence words
live in the base struct at fixed indices, so a per-type layout split moves
*values* without moving the *answer*. That delivers the property the constraint
was actually reaching for.

## Results

**Enumeration denominator, `tests/dogfood/cold-tail-differential.mjs`
`PROBE_READ=reflect` on the standalone acorn self-parse** — the instrument's
own vacuity check, which prints a loud `VACUOUS` warning when enumeration
yields nothing:

| | objects walked | yielding ≥1 own key |
| --- | ---: | ---: |
| before | 32,506 | **15 (0.05 %)** — `VACUOUS` warning fires |
| after | 32,506 | **32,502 (99.99 %)** — warning gone |

The 15 were plain RegExp-ish objects, not AST nodes. Native acorn yields keys
on 32,487. This denominator is the whole point: a reflective differential that
reports "identical" while enumerating nothing is comparing `undefined` against
`undefined`.

**Surfaces**: the 6 × 5 matrix above is now correct in all 30 cells, standalone
matching host and Node.

**Builtin direction, pinned in both directions** (this is where a
user-class-only test would pass while internals leaked):

| | before | after | correct |
| --- | ---: | ---: | ---: |
| `Object.getOwnPropertyNames(/ab/g)` | 7 | 0 | 1 |
| `Object.getOwnPropertyNames(new Date(0))` | 1 | **0** | 0 |
| `Object.keys(new Date(0))` | 0 | **0** | 0 |
| `Object.keys(/ab/g)` | 0 | **0** | 0 |
| `for…in` over `new Date(0)` / `/ab/g` | 0 | **0** | 0 |

`gOPN(/ab/g)` going 7 → 0 against a correct 1 is an *under*-answer, not a leak:
the surviving `lastIndex` was never enumerated by standalone even before this
change. That is the safe direction and a strict improvement on 7, but it is a
residual gap, stated rather than papered over.

**Binary size**: standalone acorn **937,273 B → 957,086 B, +19,813 B
(+2.11 %)**. That is the real cost of this correctness fix — one arm per user
shape per helper, across three newly-armed helpers. Enumeration support costs
bytes; the alternative is a silently wrong answer.

**Gates**: typecheck 0. `tests/issue-3920-standalone-closed-struct-reflection.test.ts`
30/30. Dogfood canaries **2/3/4/5**, `functionImports: []`, exactly the 3
pre-existing IR-FALLBACKs. Adjacent suites (`issue-3780`, `issue-3486`,
`issue-2608`) — 6 failures, **all 6 identical on the unmodified baseline**,
verified by an A/B with file copies (never `git stash`): 4 in `#2586`
(`issue-2608`), `#3486` own-fields-and-enumeration, and `#3780`
packed-presence-layout-only. None introduced here.

## What is NOT fixed, stated plainly

**A property first written OUTSIDE the constructor is not stored on the closed
struct at all, in EITHER lane.** The issue's original repro
(`var bag = new Bag(1); if (bag.seed > 0) bag.p = 7;`) therefore still
under-reports: every surface agrees, and all of them miss `p`.

This is a **storage** gap (the #3537 expando carrier bag), not an enumeration
one, and it is why the acceptance criteria below are not all ticked:

- The **cross-lane divergence** this issue was filed on is gone — host and
  standalone now agree on that repro where they previously answered 1007 vs 7.
- The **absolute** answer still differs from Node in both lanes.

Because that shortfall is lane-symmetric and lives in a different subsystem, it
is deliberately not fixed here and the regression test asserts cross-lane
agreement for that shape rather than pinning a number — pinning one would
either encode a bug as expected or fail for a reason this change does not own.

Also deliberately out of scope, recorded so proximity does not merge it in: the
IR admission gap another lane found (a field-initialiser class laundered
through `id(x): any` fails to *compile* on `hasOwnProperty`) is a different
defect.

## Scope

- [x] Reduce to the minimal failing program and confirm which predicate the
      standalone `in` actually reaches.
- [x] **Check whether `for…in`, `Object.keys` and `hasOwnProperty` share the
      root cause or are three separate holes.** **Answered: one root cause.**
      Six helpers, three armed and three not, matching the measured matrix
      3-for-3 — the §Problem grouping was an observation; this is the
      diagnosis.
- [x] Flip `tests/issue-3780-allocation-lowerings.test.ts`'s standalone
      assertion to `EXPECTED_CROSS_WORD`. Was recorded here as **blocked** on
      the expando-storage gap; re-measured and it is not — see
      "the flip was not blocked" below.

## Acceptance criteria

- [x] `"p" in instance` agrees across the JS-host and standalone lanes for
      constructor-assigned properties.
- [x] …and for conditionally-assigned ones. The dynamic half landed in
      PR #4219; the **static-fold** half is the second slice below, without
      which three of the four spellings still disagreed across lanes.
- [x] The cross-word fixture asserts `EXPECTED_CROSS_WORD`.
- [x] Whatever of `for…in` / `Object.keys` / `hasOwnProperty` shares the root
      cause is fixed in the same change; anything that does not is split out
      with its own repro rather than left implied.
- [ ] No standalone test262 regression — CI `merge_group` owns this.

---

## Second slice — the COMPILE-TIME fold (2026-08-08, `ttraenkler/opus-forin-2`)

Found by an independent lane working the same issue id concurrently; PR #4219
landed mid-flight, so this is the non-overlapping residual, re-measured against
`upstream/main` @ `23ba5903b` **with #4219 already in**.

### The half above is the `any`-receiver half; there is a second, opposite one

#4219's summary says "a statically-typed receiver never showed the bug because
it never enters the dynamic runtime at all". True as far as the *dynamic* bug
goes — but a statically-typed receiver has the **opposite** defect, from a
different mechanism, and it also diverges across lanes. Measured after #4219, on
a 2-iteration loop where the honest answer is one hit per predicate:

| predicate | standalone | JS host | correct |
| --- | ---: | ---: | ---: |
| `"cond" in bag` | **2** | 1 | 1 |
| `bag.hasOwnProperty("cond")` | **2** | 1 | 1 |
| `bag.propertyIsEnumerable("cond")` | **2** | 1 | 1 |
| `Object.hasOwn(bag, "cond")` | 1 | 1 | 1 |

`Object.hasOwn` is the control that localises it: it never folded, so it was
right before and after. The other three fold to `i32.const 1` from
`structFieldNames.includes(key)` — the SHAPE's answer — for a field the instance
never got. A conditionally-assigned field has a physical slot AND a
`$presence_<w>` bit; the VALUE read consults the bit, the fold did not, so the
predicate contradicted the read on the same line and nothing ever noticed.

This is the more dangerous direction of the two: a bigger number bought with a
silent wrong answer.

### Fix

`src/codegen/closed-struct-presence.ts` — one derivation, used by
`binary-ops-in.ts` (`in`) and `object-ops.ts` (`hasOwnProperty` /
`propertyIsEnumerable`). The runtime presence test replaces **only a folded
`1`**; a folded `0`, and every unconditionally-assigned field, keep their
constant. The answer therefore narrows and never widens, so this cannot
manufacture a new `true` on a builtin carrier — which is why it needs no
`isUserDeclaredStruct` gate of its own.

**Name-list source (the #3927 constraint):** the presence WORD, never the field
list — `presenceTestInstrs` on `$presence_<w>`, or `coldFieldPresenceInstrs`'
`$cold` hop for a hot/cold-split field, resolved per owning struct via
`presenceSlotOf`. A field-list derivation is layout-dependent and is already
wrong today for a split field, which is not in the main struct's field list at
all.

**Commit-only-on-confirmed-operand:** the checker-resolved receiver type and the
compiled operand can disagree (widened binding, subtype, externref-slotted
variable), and committing a mismatch is an **invalid module**, not a wrong
answer. Both call sites scratch-compile their operands via `pushBody`/`popBody`
and commit only when `isClosedStructOperand` confirms the reference; the scratch
local is always `(ref null $S)` so nullability cannot mismatch either.

### The #3780 flip was not blocked

This file recorded the flip as blocked on the expando-storage gap. Re-measured:
`CROSS_WORD_PRESENCE` answers **830,660 = `EXPECTED_CROSS_WORD` exactly** on
upstream/main with #4219 in. The storage gap is real but does not reach that
fixture — its properties are `this`-flow-grown onto the closed struct, so they
are stored. What was actually true is that
**`tests/issue-3780-allocation-lowerings.test.ts` is RED on `main`**: the
behaviour moved and the pinned `EXPECTED_CROSS_WORD - 820 * 1000` did not. The
credit for the behaviour is #4219's; this slice repairs the stale pin.

### Attribution (kill-switch A/B)

`tests/issue-3920.test.ts`, 8 tests, reverting **only** `binary-ops-in.ts` and
`object-ops.ts` to `upstream/main` and changing nothing else:

| | this slice | upstream-only |
| --- | --- | --- |
| positive control (instance is observable) | pass | **pass** |
| struct-typed receiver, absent field | pass | fail `222` vs `111` |
| the other 6 | pass | pass |

The positive control passing on both arms is what makes the one failure
attributable rather than an instrument defect. Six of the eight passing on the
upstream-only arm is the honest statement that **#4219 fixed most of this
issue**; this slice is the remaining row.

Every presence assertion pins the FULL 4-way answer (present/absent ×
conditional/unconditional), so a predicate that has degenerated into a constant
fails in either direction — an enumeration-shaped differential over this
receiver class otherwise passes vacuously by comparing "nothing" to "nothing".

### The two cells this does NOT close — split out as issue #4219

The same surface matrix that attributes this slice also measures two cells it
leaves untouched (verified: reverting only the two source files moves exactly
the three `in`/`hasOwnProperty`/`propertyIsEnumerable` cells and nothing else):

- **`for (k in bag)` on a STRUCT-TYPED receiver enumerates nothing** in
  standalone — scores `0`, not `2`, so it is a different path
  (`compileForInStatement`'s static-unroll fallback) failing open, not the
  shape fold. It is also presence-BLIND, so sourcing its names from the struct
  without gating each on its bit would convert this under-report into the
  over-report just removed. Directly blocks #3927.
- **Host-lane `Object.keys` under-reports** — the only cell where host is worse
  than standalone. Opposite lane, `src/runtime.ts` marshalling.

Filed together in issue id **#4219** (not to be confused with GitHub PR #4219,
which is this issue's dynamic half), stated as two mechanisms rather than one
bucket — repeating the original filing's grouping here is what made the first
diagnosis take three passes.

### Process note

Two lanes worked id #3920 concurrently. The `issue-assignments` claim ref was
held by `ttraenkler/opus-forin-2` and did not prevent the `claude/` lane from
landing #4219 — the claim book does not cover that lane.

## See also

`plan/agent-context/session-2026-08-07-acorn-perf-handoff.md` (landing via
PR #4216).
