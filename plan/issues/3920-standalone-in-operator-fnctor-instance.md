---
id: 3920
title: "standalone: `\"prop\" in fnctorInstance` answers false where the JS-host lane answers true"
status: done
completed: 2026-08-08
assignee: ttraenkler/opus-forin-2
sprint: current
created: 2026-07-31
updated: 2026-08-08
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
language_feature: objects, operators
goal: correctness
related: [2847, 2130, 3673, 3780]
origin: "found while writing #3780 round 4's presence-packing regression test — the fixture disagreed across lanes and reproduced identically with the change disabled"
---

# #3920 — `in` answers `false` for a fnctor instance's own property in standalone

## Problem

A property that was assigned to a constructed instance reads back its **value**
correctly in the standalone lane, but the `in` operator reports it **absent**.
The JS-host lane answers correctly on the identical program.

This is the first repro'd instance of the wider reflection hole that
`plan/agent-context/dev-acorn-throughput.md` §7 describes (`for…in` enumerating
0 keys, `Object.keys` returning 0, computed writes `n[k] = v` behaving as no-ops
on fnctor instances) — that note explicitly declined to file an issue **because
there was no failing repro to write a regression test against**. There is one
now, so that blocker is discharged.

## Repro

The fixture already lives in `tests/issue-3780-allocation-lowerings.test.ts`
(`CROSS_WORD_PRESENCE`), where it is currently pinned to the *standalone*
answer with a comment pointing here. Reduced:

```js
function Bag(seed) { this.seed = seed; }
export function main() {
  var bag = new Bag(1);
  if (bag.seed > 0) bag.p = 7;     // conditional ⇒ `p` is presence-tracked
  return (("p" in bag) ? 1000 : 0) + bag.p;
}
```

Run verbatim (compiled once per lane, `target: "standalone"` vs default):

| lane | result |
| --- | ---: |
| JS host | `1007` |
| standalone | `7` |

The value half (`bag.p === 7`) is correct in both lanes; only the presence
predicate differs. On the full 40-property fixture the gap is exactly the
presence term: **830,660 (host) vs 10,660 (standalone)**, i.e. 820 × 1000.

## What is already known

- **Not caused by #3780's presence packing.** It reproduces byte-for-byte with
  `JS2WASM_PACKED_PRESENCE_BITS=0`, which restores the pre-#3780 one-`i32`-per-
  field layout through the identical read/write lowering. Both layouts answer
  `false`. So the bug is upstream of how the flag is *stored*.
- The **write** side does set the flag — `compileStructFieldAssignment` in
  `src/codegen/expressions/assignment.ts` emits the presence write for any
  `presenceTracked` field, and that path is lane-independent.
- So the suspicion is the **read/dispatch** side: the standalone `in` lowering
  is not reaching the closed-struct own-presence predicate that
  `emitClosedStructHasOwn` (`src/codegen/object-runtime.ts`) builds, and is
  instead answering from a path that does not know about fnctor instances.
  `emitStructFieldPresenceGetters` (`src/codegen/struct-field-exports.ts`)
  early-returns on `if (ctx.nativeStrings) return;` — and standalone implies
  `nativeStrings` — which is at least one lane-shaped asymmetry in this exact
  area and is the first thing to check.

## Why it matters beyond the repro

`Object.keys`, `for…in`, `hasOwnProperty` and property enumeration order are
heavily exercised by ES5 test262, which is the current standalone conformance
priority. A general presence/enumeration hole over fnctor instances is a
plausible multi-test bucket rather than a one-off.

## Scope

- [ ] Reduce to the minimal failing program and confirm which predicate the
      standalone `in` actually reaches (WAT, not inference).
- [ ] Check whether `for…in`, `Object.keys` and `hasOwnProperty` share the root
      cause or are three separate holes — §7 of the handoff lists them together
      but that grouping is an observation, not a diagnosis.
- [ ] Fix, and flip `tests/issue-3780-allocation-lowerings.test.ts`'s standalone
      assertion from "agrees with its own paired control" to "agrees with the
      host lane" (`EXPECTED_CROSS_WORD`), removing the pinned-to-the-bug
      constant there.

## Acceptance criteria

- [x] `"p" in instance` agrees across the JS-host and standalone lanes for both
      unconditionally- and conditionally-assigned properties.
- [x] The cross-word fixture in `tests/issue-3780-allocation-lowerings.test.ts`
      asserts `EXPECTED_CROSS_WORD` on the standalone lane.
- [x] Whatever of `for…in` / `Object.keys` / `hasOwnProperty` shares the root
      cause is fixed in the same change; anything that does NOT is split out
      with its own repro rather than left implied.
- [x] No standalone test262 regression.

---

## Resolution (2026-08-08)

### The diagnosis in the "What is already known" section above was wrong

It named `emitStructFieldPresenceGetters`' `if (ctx.nativeStrings) return;` as
"the first thing to check". That is a red herring — those `__shas_*` exports are
a HOST-marshalling surface and are irrelevant to the standalone answer.
`emitClosedStructHasOwn`, also named there, **does not exist**.

### Actual root cause: three predicates, one shared mistake

Own-presence on a conditionally-assigned closed-struct field is a **per-instance
bit** (`$presence_<w>`, #2847/#3780). Every VALUE read consults it. The three
reflective predicates asked the **shape** instead — `structFieldNames
.includes(key)` — and so disagreed with the read on the same line. In **both
directions**:

| surface | receiver | answered | should |
| --- | --- | --- | --- |
| `"p" in bag` | statically the closed struct | **`true`** for an ABSENT field (folded `i32.const 1`) | per-instance bit |
| `bag.hasOwnProperty("p")` | statically the closed struct | **`true`** for an ABSENT field (same fold) | per-instance bit |
| `"p" in bag` | `any`/externref | **`false`** for a PRESENT field | per-instance bit |

The third row is the filed repro. Its cause is narrower than "the `in` lowering
does not reach the closed-struct predicate": the ladder built by
`fillClosedStructHasOwnArms` already served `__hasOwnProperty` /
`__object_hasOwn` / `__propertyIsEnumerable` correctly — **`__extern_has`, the
`key in obj` runtime, was simply not in its target list**, so it fell straight
through to the carrier-bag / proto-companion consult and returned 0.

The first two rows are the more dangerous half and were **not** in the filed
report: they are a bigger-number-with-a-silent-wrong-answer, and they are why
this issue's own recorded repro had gone stale (below).

### The recorded repro numbers were STALE, in the opposite direction

The table above says standalone answers `7` (presence term dropped) and the
40-property fixture `10,660` vs the host's `830,660`. Re-measured on
`main` @ `9ff693ddf` **before any change**: the fixture answers **`1,650,660`** —
40 hits × 41 seeds, i.e. `in` was answering `true` for **every** property,
present or not. `tests/issue-3780-allocation-lowerings.test.ts` was therefore
**already red on main**, pinned to a constant the lane had since moved past. The
reduced two-instance repro still reproduces the `7`; the difference is whether
the receiver's static type resolves to the closed struct (fold ⇒ false positive)
or stays `any` (runtime ⇒ false negative).

### Fix

`src/codegen/closed-struct-presence.ts` (new) holds one derivation, used by all
three sites:

- `binary-ops-in.ts` and `object-ops.ts` — the runtime presence test replaces
  **only a folded `1`**. A folded `0`, and every unconditionally-assigned field,
  keep their constant. The answer therefore narrows and never widens, so this
  cannot manufacture a new `true`.
- `object-runtime.ts` — `__extern_has` joins the `fillClosedStructHasOwnArms`
  target list in a new **affirmative-only** mode (`HasOwnLadderMode`): a set bit
  returns 1, a clear bit **falls through** rather than returning 0, because
  §7.3.12 HasProperty continues onto the prototype chain. A tombstoned field
  skips the arms instead of short-circuiting, for the same reason.

**Name-list source (the #3927 constraint):** the answer comes from the
receiver's **presence words** — `presenceTestInstrs` on `$presence_<w>`, or
`coldFieldPresenceInstrs`' `$cold` hop for a hot/cold-split field — resolved per
owning struct via `presenceSlotOf`. It is **not** derived from the struct field
list, which is layout-dependent and already wrong today for a split field (a
cold field is not in the main struct's field list at all). Sharing the one
derivation across `in` / `hasOwnProperty` / `__extern_has` is what stops the
three from drifting apart again.

### What is NOT this issue, with measurements

- **`for…in` and `Object.keys` over a fnctor instance enumerate 0 keys in BOTH
  lanes** (host and standalone), so they are not this standalone-only
  differential. That is the missing key **producer** for closed structs, and it
  needs the dynamic-write half first — **#4194**, which also warns that widening
  `Object.keys` here measured **-5** (#4071) and must not ride along.
- **`bag.hasOwnProperty("seed")` answers `false` in the JS-HOST lane** for an
  unconditional constructor field (standalone answers `true`, correctly).
  Host-side, opposite lane, separate mechanism — not fixed here.

### Test evidence

`tests/issue-3920.test.ts` — 8 tests. Attribution by reverting the three source
files to `HEAD~1` (kill-switch A/B, no other change):

| | fix arm | base arm |
| --- | --- | --- |
| positive control (instance is observable) | pass | **pass** |
| `in` 4-way matrix, standalone | pass | fail `10` vs `1010` |
| `in` 4-way matrix, JS host | pass | pass |
| `hasOwnProperty` 4-way matrix | pass | pass |
| `Object.hasOwn` 4-way matrix | pass | pass |
| struct-typed receiver, absent field | pass | fail `22` vs `11` |
| runtime `__extern_has` arm | pass | fail `7` vs `1007` |
| unpacked-presence layout control | pass | fail `10` vs `1010` |

The positive control passing on **both** arms is what makes the four failures
attributable rather than an instrument defect. Every presence assertion pins the
full 4-way answer (present/absent × conditional/unconditional), so a predicate
that has degenerated into a constant fails in either direction — an
enumeration-shaped differential over this receiver class otherwise passes
vacuously by comparing "nothing" to "nothing".
