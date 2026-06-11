---
id: 1718
title: "Iterator sequencing helpers (Iterator.concat / zip / zipKeyed) + Iterator.prototype.flatMap not implemented (101 fails)"
status: done
created: 2026-05-29
updated: 2026-06-11
priority: high
feasibility: hard
task_type: bugfix
area: codegen
language_feature: iterator-helpers
goal: test262-conformance
sprint: 61
es_edition: 2025
test262_fail: 101
test262_category: built-ins/Iterator
related: [1340, 1320]
claimed_by: codex-developer
claimed_at: 2026-06-07T10:03:03.373Z
pr: 1279
completed: 2026-06-09
---
# #1718 — Iterator sequencing helpers + Iterator.prototype.flatMap (101 fails)

## Problem

101 tests under `built-ins/Iterator/*` fail because newer iterator helpers are
unimplemented or mis-routed:

| Helper | Symptom | Approx count |
|--------|---------|------:|
| `Iterator.concat` | `Iterator helper: argument is not iterable` / `Iterator.concat: argument is not iterable` | ~20 |
| `Iterator.zip` / `Iterator.zipKeyed` | `Iterator helper: argument is not iterable` | ~50 |
| `Iterator.prototype.flatMap` | `flatMap is not a function` | ~31 |

This is **distinct from #1340** (`done` 2026-05-28), which fixed `wasm_compile`
errors in the *existing* Iterator.prototype helpers (map/filter/take/drop/etc.).
The **iterator-sequencing** static methods (`Iterator.concat`, `Iterator.zip`,
`Iterator.zipKeyed` — TC39 iterator-sequencing proposal, ES2025-era) and
`Iterator.prototype.flatMap` are either not defined or fall through to a path
that rejects valid iterables.

Note: `Array.prototype.flatMap` (#1136, done) is a different method — this is the
**Iterator** helper.

## Root-cause hypothesis

- `Iterator.concat(...items)` / `Iterator.zip(iterables)` /
  `Iterator.zipKeyed(iterables)` are missing static methods on the Iterator
  constructor; the generic "iterator helper" dispatch wrongly reports "argument
  is not iterable" because the iterable-coercion (GetIteratorFlattenable /
  GetIteratorDirect) step is not implemented for these inputs.
- `Iterator.prototype.flatMap` is absent from the Iterator prototype method
  table, so the property resolves to undefined and the call traps.

Spec:
[Iterator.prototype.flatMap §27.1.4.x](https://tc39.es/ecma262/#sec-iteratorprototype.flatmap),
[iterator-sequencing proposal (Iterator.concat / zip / zipKeyed)](https://tc39.es/proposal-iterator-sequencing/).

## Example failing tests

- `test/built-ins/Iterator/concat/fresh-iterator-result.js`
- `test/built-ins/Iterator/concat/get-iterator-method-only-once.js`
- `test/built-ins/Iterator/zipKeyed/options.js`
- `test/built-ins/Iterator/prototype/flatMap/callable.js`
- `test/built-ins/Iterator/prototype/flatMap/flattens-iterable.js`

## Acceptance criteria

- `Iterator.prototype.flatMap` is callable; the `flatMap is not a function`
  bucket → 0 (≥ 25 of 31 flatMap tests pass).
- `Iterator.concat` and `Iterator.zip`/`zipKeyed` accept valid iterables (no more
  spurious "argument is not iterable"); ≥ 40 of the ~70 concat/zip tests pass.
- No regression in #1340's now-passing Iterator helper tests.

## Notes

`zip`/`zipKeyed` are a Stage proposal but **not** on the CLAUDE.md skip-filter
list (the deferred features are eval/with/Proxy/SAB/Temporal/WeakRef/FinReg/
dynamic-import/TLA). `flatMap` is shipped ES; prioritise it first. Feasibility
`hard` because the generator-backed helper lowering is involved (see #1340 lineage).

## Source

Filed by product-owner test262 triage 2026-05-29 against main baseline
(`.test262-cache/test262-current.jsonl`, 48,117 records).


## S1 implementation (landed) — Iterator.prototype.flatMap

Two-part fix:

1. **Runtime** (`src/runtime.ts`, `_installIteratorHelperPolyfills`): added an
   `Iterator.prototype.flatMap` polyfill mirroring the existing zip/concat
   helpers (`_makeHelperIterator` + `_getFlattenable`). Implements §27.1.4.x:
   for each outer value, `mapper(value, counter)` →
   GetIteratorFlattenable(..., reject-primitives) → yield every inner value
   before advancing the outer; closes the outer on abrupt mapper/inner
   completion.

Result: the flatMap test262 CE bucket → 0 (was 4); runtime pass 0 → 13/44
locally. `tests/issue-1718-flatmap.test.ts` green: flatten arrays, reject
primitive strings, and skip empty inner values.

The residual `flatMap is not a function` failures are a **prototype-chain
identity** matter: a *compiled* iterator's proto must resolve to the polyfilled
`%Iterator.prototype%`. That is the #1320 iterator-bridge foundation
(`related: [1320]`) and is intentionally NOT forced into this slice. On a host
that ships the native helper (or where the chain is consistent) the polyfill
applies cleanly.

**Remaining (separate slices):** S2 `Iterator.zip`/`zipKeyed` (~50), S3
`Iterator.concat` (~20). Both already have polyfills installed
(`_installIteratorHelperPolyfills`); their residual failures are dominated by
the same #1320 iterator-identity chain — carve + escalate per the issue
guardrail if they need the compiled-value↔host-iterator foundation.


## S2 (landed 2026-06-03) — static-helper arity + property descriptors

Localized spec-compliance fix in `src/runtime.ts`
(`_installIteratorHelperPolyfills`). The polyfilled `Iterator.from` / `zip` /
`zipKeyed` / `concat` were installed via raw `Object.defineProperty`, so the
TS optional param (`options?`) inflated the function `.length` to **2** —
§17/§27 mandate `1` for `from`/`zip`/`zipKeyed` and `0` for the variadic
`concat`. Their own `length`/`name` data-properties were also left with the
default `writable:true`, failing the test262 `verifyProperty` checks.

Added `_installStaticHelper(target, name, length, impl)` (mirrors the existing
`_installBuiltinMethod`): resets `fn.length`/`fn.name` to spec values with
`{writable:false, enumerable:false, configurable:true}` and installs the
property on `Iterator` with `{writable:true, enumerable:false,
configurable:true}` (§17 default data-property attributes). Converted the four
static installs to use it. Runtime iteration behaviour unchanged.

Result (host-runner tally, this Node which ships only native `flatMap`):
`zip` 8→9, `zipKeyed` 8→9 (the `length.js` `verifyProperty` cases now pass),
`concat`/`flatMap` unchanged, **no regressions**. Unit test:
`tests/issue-1718-static-arity.test.ts`.

**Also in S2 — GetOptionsObject validation (+2 tests).** `zip`/`zipKeyed`
silently treated a non-object `options` argument (`null`, boolean, number,
string, symbol, bigint) as "no options" instead of throwing. Added
`_getOptionsObject(options)` per the iterator-sequencing/joint-iteration
proposal (`undefined` → null-proto object; Object → as-is; else TypeError)
and applied it in `zip` (which `zipKeyed` delegates through). Flips
`built-ins/Iterator/{zip,zipKeyed}/options.js` → pass; no iteration involved
so this is independent of the #1320 bridge.

**Remaining (bridge-blocked, NOT this slice):** the dominant residual buckets
are `Iterator helper: argument is not iterable` (concat ~18, zipKeyed ~16) and
`flatMap is not a function` (~7). These all reduce to the same root cause:
a **compiled object literal / generator carrying a `[Symbol.iterator]` (or
`flatMap`) method is opaque to the host polyfill** — the well-known-symbol
method and the `%Iterator.prototype%` chain don't survive the
compiled-value↔host boundary. That is the #1320 / #1665 iterator-bridge
foundation (`related: [1320]`), explicitly escalated as needs-architect and
out of a localized dev's scope. Issue stays `ready` for those slices.

### Type-check lib (lib.esnext.iterator.d.ts) — DEFERRED

Adding lib.esnext.iterator.d.ts to the checker lib set (src/checker/index.ts)
*would* clear the "Property 'flatMap' does not exist on type 'ArrayIterator'"
CE for the whole helper family — but it REGRESSES the equivalence-gate: the new
ES2025 iterator typings change how [].values() / Set/Map iterators and
spread/for-of resolve, breaking existing iterator codegen (e.g.
`for (const x of [1,2,3].values())` started throwing "is not iterable"). Too
broad a blast radius for this localized flatMap slice. The lib was DROPPED from
this PR; the type-check half is a separate follow-up that must land together
with the codegen changes to handle the new iterator types (coordinate with the
#1320 / $ArrayObj iterator-representation work).


## Attempt 22 (2026-06-07) — iterator sequencing spec tightening

Localized runtime follow-up in `src/runtime.ts` against the fetched current
ECMA-262 / Stage 4 iterator sequencing text:

- Added shared `IteratorZip`-style plumbing for `Iterator.zip` and
  `Iterator.zipKeyed`: `mode` is read with `undefined` defaulting only,
  longest-mode `padding` is validated only when relevant, strict mismatches now
  throw `TypeError`, and open iterators are closed on abrupt setup/iteration.
- Applied `GetIteratorFlattenable(..., reject-primitives)` where the algorithms
  require it (`zip` inner values, `zipKeyed` property values, and
  `Iterator.prototype.flatMap` mapper results), so iterable string primitives no
  longer get flattened by the polyfill.
- Reworked `Iterator.zipKeyed` to follow `[[OwnPropertyKeys]]` order, include
  enumerable symbol keys, skip enumerable keys whose value is `undefined`, use
  keyed padding objects for longest mode, and yield null-prototype result
  objects.
- Reworked `Iterator.concat` to fetch each argument's `@@iterator` method once at
  helper creation, open each iterator lazily from the stored method, reject
  primitive arguments per `Iterator.concat`, and return fresh helper iterator
  result objects instead of forwarding the inner iterator result object.

Focused coverage added in `tests/issue-1718.test.ts`; the older flatMap slice
test was corrected to reject primitive string mapper results. Scoped validation:

- `pnpm exec vitest run tests/issue-1718.test.ts tests/issue-1718-static-arity.test.ts tests/issue-1718-flatmap.test.ts tests/issue-1340.test.ts`
- `pnpm exec tsc --noEmit --pretty false`

`test262/` is empty in this worktree, so no local test262 shard was run. This
attempt improves the static helper/polyfill semantics but does not claim the
remaining compiled-value ↔ host-iterator bridge work tracked through #1320.


## Attempt 30 (2026-06-07) — validation and publish refresh

Rechecked the existing implementation on `symphony/1718` after redispatch. No
source changes were needed: the branch already contains the spec-tightening
runtime patch and focused #1718 tests from the prior attempt.

Scoped validation:

- `pnpm exec vitest run tests/issue-1718.test.ts tests/issue-1718-static-arity.test.ts tests/issue-1718-flatmap.test.ts tests/issue-1340.test.ts`
  - 4 files / 47 tests passed.
- `pnpm exec tsc --noEmit --pretty false`
  - passed.

PR #1279 is open and ready for review. The branch was resynced with current
`origin/main`, pushed, and auto-merge was enabled so GitHub can enqueue it as
soon as required checks pass. The previous Test262 Sharded run failed in
`merge shard reports` only because the external `loopdive/js2wasm-baselines`
JSONL was 114 commits behind `origin/main` (threshold 50; see #1668); all
individual js-host and standalone shards passed, and the standalone guard
reported net 0. If the stale-baseline guard recurs on the refreshed run, that is
an external baseline-promotion blocker rather than an iterator helper regression.
