---
id: 6505
title: "Linked body: `arr.hasOwnProperty(\"1\")` with a CONSTANT key answers false for every index but 0"
status: done
sprint: current
created: 2026-09-18
updated: 2026-09-18
completed: 2026-09-18
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: arrays
goal: test262-conformance
related: [6482, 3451, 5225, 4491]
# 2026-09-18 (round 9): +8 COMMENT lines in
# `compilePropertyIntrospection` (583 -> 591). The code change is a single
# condition — the `elemIsRef &&` gate is deleted from the runtime-delegating
# arm. The eight lines record WHY that gate was sound before #6482 round 4's
# `__vec_has_own_index` and is not sound after it; a bare deletion of a
# restriction whose original justification is still written three lines above
# it is the kind of edit a later reader re-adds. No statements added.
func-budget-allow:
  - src/codegen/object-ops.ts::compilePropertyIntrospection
loc-budget-allow:
  - src/codegen/object-ops.ts
---

# #6505 — a constant index key is answered by a path that only knows index 0

## Symptom

In a **linked body** (`TEST262_ORACLE_MODE=linked`, i.e. the test body compiled
against a separately-compiled harness provider), `hasOwnProperty` with a
**string-literal** index key answers `true` for `"0"` and `false` for every
other index — on a fully DENSE array, whatever its length.

Measured 2026-09-18 through the `runLinked` rig in
`tests/issue-6482-r3-sparse-vec-own-indices.test.ts`:

| body | result | correct |
| --- | --- | --- |
| `var arr = [0]; arr.hasOwnProperty("0")` | `true` | `true` |
| `var arr = [0,1]; …("0"), …("1")` | `true, false` | `true, true` |
| `var arr = [0,1,2]; …("0"), …("1"), …("2")` | `true, false, false` | all `true` |
| `var arr = [0,1,2,3]; …"0".."3"` | `true, false, false, false` | all `true` |

## What it is NOT

Two A/Bs bound the defect tightly:

- **Not the round-4 hole oracle, and not #6482 at all.** Identical output on
  `origin/main` (278b5d1aa5) and on the #6482 round-4 tree, verified by checking
  out `main`'s `src/` and re-running the same bodies. It predates that work.
- **Not general codegen.** The same source in a SINGLE-module compile is
  correct (`true,true`) — checked through `assertEquivalent`, which runs the
  compiled module against V8 on the same source. So the wrong answer needs the
  linked split.
- **Not the index rule itself.** The COMPUTED-key form of the same query is
  correct at every length: `for (var i = 0; i < n; i++) arr.hasOwnProperty(String(i))`
  answers `true` n times, for n = 1..5, in the same linked rig. Only the
  constant-key form is wrong.

So: a linked body lowers a constant index key through a different path than a
computed one, and that path is right only for `0`.

## Why it matters

`propertyHelper.js`'s `verifyProperty` / `isEnumerable` and a large family of
ES5 `Object.defineProperty` / `Object.keys` rows ask exactly this question with
a literal key. The count is not established here — the rows that would show it
are currently masked by other failures — but the surface is the same one #6482
round 4 just made correct for every other query shape, so a fix here is
cumulative with it, not overlapping.

It also puts a floor under what a guard test can assert: the #6482 round-4 guard
deliberately asserts through computed keys and says so, because the literal form
would fail for this unrelated reason.

## Where to look

The signature — correct for `0`, false for everything else, computed keys fine,
single-module fine — points at a constant-key fold that resolves the key to an
index once, at compile time, against the READER's own vec types, and falls back
to a "not an own index" answer when the receiver is a foreign/opaque value. That
is the same class of defect #6482 was opened for (a provider-side read
`ref.test`ing a consumer-minted vec and missing), so the fix is likely the same
shape: route the miss through the minting module rather than answering `false`.

Candidate paths, in the order worth checking:

- `src/codegen/vec-named-key-presence.ts` — a constant `"1"` reaching the NAMED
  key arm instead of the index arm would answer exactly `false`.
- `src/codegen/vec-f64-hole-presence.ts` / `__extern_has_idx` — the shared
  presence oracle the three surfaces (`in`, `hasOwnProperty`, `Object.keys`)
  consult (#4491 T11).
- `src/codegen/carrier-bag-hasown.ts`, `src/codegen/vec-overlay.ts` — the
  overlay/bag arms that answer own-ness for a vec with a static key.
- `src/runtime.ts::_wasmStructHasOwn` — verified NOT reached for this shape
  (instrumented; no call), which is itself a clue: the answer never leaves wasm.

## Reproduce

```ts
// in the style of tests/issue-6482-r3-sparse-vec-own-indices.test.ts
await runLinked(
  `${HEADER}var arr = [0, 1];\n` +
    `assert.sameValue(String(arr.hasOwnProperty("0")) + "," + String(arr.hasOwnProperty("1")), "T");`,
);
// => fail: Expected SameValue («"true,false"», «"T"»)
```

Run with a **fresh** `JS2WASM_TEST262_HARNESS_CACHE` if you reproduce through
the test262 runner rather than the in-process rig — the default cache dir is
shared across compiler builds and keyed only by `PROVIDER_COMPILER_ABI_VERSION`
(#6488), which will happily serve a provider built by another compiler.

## Acceptance

- A linked body answers `true` for every in-bounds index of a dense array with a
  constant key, at length 1..5.
- A sparse array still answers `false` for its holes with a constant key
  (`[0, , 2]` → `"1"` is not own) — the #6482 round-4 rule must not be undone.
- Computed-key and single-module behaviour unchanged.
- A guard test in the linked rig covering both directions.

## Resolution (2026-09-18, round 9)

**The index is not the discriminator — the query ORDER is.** `arr.hasOwnProperty("1")`
does not fail because the key is `"1"`; it fails because it is not the FIRST
such query in the program. Reversing the calls moves the single `true` with
them:

```
var arr = [0,1,2]; arr.hasOwnProperty("2"), arr.hasOwnProperty("0")  ->  true,false
```

`provesDenseLiteralOwnIndex` (`src/codegen/object-ops.ts`) proves own-ness from
the dense array literal, and it is deliberately local: it refuses as soon as ANY
identifier reference to the receiver sits between the declaration and the call.
The first query therefore proves and folds to `1`; every later one sees the
earlier query as an intervening reference and the proof fails. Nothing below it
caught the fall-through for an f64-carrier vec — the runtime-delegating arm was
gated on `elemIsRef`, so a NUMERIC vec dropped through to the named-key fold at
the bottom of `compilePropertyIntrospection`, whose key set is
`["length", "data"]`. That fold emits a constant `false`.

**Fix (1 condition, +16 comment lines):** drop the `elemIsRef` gate on the
runtime-delegating arm, so any statically-resolvable canonical index on a vec
receiver is answered by `__hasOwnProperty`. The restriction was correct when
written — the native could not distinguish an f64 hole from a stored `0`/`NaN`
— but #6482 round 4's `__vec_has_own_index` answers from the RAW element before
that boxing, so the native is exact for the numeric carrier now too. The
affirmative fold above it is untouched, so nothing that answers `true` today
changes.

### Measured — correct behaviour, 0 rows moved either way

| lane / slice | rows | before | after | flips |
| --- | --- | --- | --- | --- |
| linked: `Object/prototype/hasOwnProperty/**` + `Array/prototype/**` (`hasOwn`) + the 735-file `defineProperty/15.2.3.6-4-*` control + the 114-row #6482 bucket | 947 | 749 | 749 | **0 / 0** |
| linked: every other corpus file calling `hasOwnProperty` with a LITERAL index | 86 (83 ran) | 53 | 53 | **0 / 0** |
| honest: the same literal-index rows + the two `hasOwn` families | 196 (193 ran) | 122 | 122 | **0 / 0** |

Real runner, fresh `JS2WASM_TEST262_HARNESS_CACHE` per arm, both bundles
rebuilt with `pnpm run -s build:{compiler,runtime}-bundle` between arms.

**0 rows is the honest result, and it was predicted.** #6505 said up front that
"the rows that would show it are currently masked by other failures" and did not
claim a count. It is a correctness fix whose value is cumulative with the rest
of the descriptor family, not a conformance win on its own — and the 0-lost
column is what makes it safe to bank now.

### Acceptance

- [x] Dense array, constant key, lengths 1..5 — `true` at every index.
- [x] Sparse `[0, , 2]` — `"1"` still `false`, `"0"`/`"2"` still `true`
      (the #6482 round-4 rule is not undone).
- [x] Computed-key and single-module behaviour unchanged (0 flips in both lanes).
- [x] Guard: `tests/issue-6505-constant-index-key-presence.test.ts`, 9 linked-lane
      cases; **6 fail** with the codegen reverted.
