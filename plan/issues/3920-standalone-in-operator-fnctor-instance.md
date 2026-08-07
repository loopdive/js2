---
id: 3920
title: "standalone: `\"prop\" in fnctorInstance` answers false where the JS-host lane answers true"
status: ready
sprint: current
created: 2026-07-31
updated: 2026-07-31
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

- [ ] `"p" in instance` agrees across the JS-host and standalone lanes for both
      unconditionally- and conditionally-assigned properties.
- [ ] The cross-word fixture in `tests/issue-3780-allocation-lowerings.test.ts`
      asserts `EXPECTED_CROSS_WORD` on the standalone lane.
- [ ] Whatever of `for…in` / `Object.keys` / `hasOwnProperty` shares the root
      cause is fixed in the same change; anything that does NOT is split out
      with its own repro rather than left implied.
- [ ] No standalone test262 regression.

## Measured 2026-08-07 (from #3927) — scope item 2 answered, and it is NOT one hole

Found while validating #3927's hot/cold split: an in-wasm differential over the
acorn self-parse showed `for…in` yielding keys on **15 of 32,506** walked
objects (the 15 are plain RegExp-ish objects, not AST nodes), against **32,487**
for the reference implementation. Scoped afterwards with small standalone
programs — `.tmp/forin-scope.mjs` / `forin-scope2.mjs`, recreate from the table:

| program (`--target standalone`) | answer | correct |
| --- | ---: | ---: |
| `for…in` over an `any` object literal (open `$Object`) | 3 | 3 ✓ |
| `for…in` over a class instance, receiver statically typed AT THE LOOP | 3 | 3 ✓ |
| `for…in` over a class instance, receiver reaches the loop as `any` | **0** | 3 ✗ |
| `for…in` over a fnctor instance, even statically typed | **0** | 3 ✗ |
| `Object.keys(objectLiteral).length` | 3 | 3 ✓ |
| `Object.keys(classInstance).length` | **0** | 3 ✗ |
| `classInstance.hasOwnProperty("a")` | **1** | 1 ✓ |
| `"a" in classInstance` | **0** | 1 ✗ |

**Three things this settles or changes:**

1. **Scope item 2's answer is "not one hole".** `hasOwnProperty` **works** on the
   very receiver where `in`, `for…in` and `Object.keys` all answer nothing. So
   `hasOwnProperty` reaches a working predicate and the other three do not —
   which narrows the search to what those three share and `hasOwnProperty` does
   not, rather than a single presence-read bug. The §7 grouping was indeed an
   observation, and one quarter of it is wrong.
2. **This is wider than fnctor instances.** A **class** instance and a
   shape-inferred object literal fail identically once the receiver reaches the
   consumer as `externref`. The static-unroll path over a statically-typed
   receiver is fine; everything that goes through the dynamic path over a closed
   struct is not. The title's "fnctor instance" is the narrowest case, not the
   boundary.
3. **It makes a whole class of test vacuous, silently.** #3927's differential
   grew an enumeration mode specifically to cover the reflective surface; it
   reported *identical* across all 64 property names, which is `undefined`
   compared against `undefined`. Any enumeration-based differential over a
   closed-struct receiver passes for free today. Two lanes nearly banked that as
   coverage. `tests/dogfood/cold-tail-differential.mjs` now reports
   `enumeratingNodes` and warns VACUOUS; whoever fixes this should expect other
   green enumeration checks to be equally empty.

**Related retraction.** #3927's 2026-08-06 slice attributed a divergence to
acorn's `copyNode` (`for (var prop in node) …`). That routine cannot copy
anything if `for…in` yields nothing, and the per-type-layouts slice separately
measured `copyNode` executing zero times on that corpus. The mechanism there is
unknown; do not carry it into this issue's diagnosis.
