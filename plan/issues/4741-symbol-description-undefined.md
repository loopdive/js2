---
id: 4741
title: "ES2015 standalone Symbol.prototype.description returns null for an absent description"
status: in-progress
sprint: current
created: 2026-08-25
updated: 2026-08-25
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen, conformance
es_edition: es6
language_feature: Symbol.prototype.description
goal: standalone-mode
source_loc_cap: 180
loc-budget-allow:
  - src/codegen/type-coercion.ts
  - tests/issue-4741.test.ts
func-budget-allow:
  - src/codegen/type-coercion.ts::coerceType
related: [2163, 4739, 4740]
---

# #4741 — standalone `Symbol.prototype.description` absent value

## Problem

The native standalone Symbol implementation stores descriptions in a nullable
native-string slot. An absent description (`Symbol()` or
`Symbol(undefined)`) and an out-of-range/unset slot are represented by a null
native-string reference internally, but the public
`Symbol.prototype.description` getter must return JavaScript `undefined`. At
the `ref_null $AnyString` → `externref` boundary, the generic coercion
currently emits `extern.convert_any` directly, which exposes the sentinel as
JavaScript `null`.

This is separate from the active Function descriptor work in #4739/#4740: it
is a native-string-to-externref boundary conversion, and does not change
function descriptor dispatch or Symbol storage.

## Exact baseline (upstream/main `3809cc76e`, 2026-08-25)

The repository's original Test262 runner was used with the pinned Test262
checkout and the exact absolute test path. The host lane passes, while the
standalone lane fails with `SameValue(null, undefined)`:

```
test/built-ins/Symbol/prototype/description/get.js
  host:       pass
  standalone: fail — The value of empty.description is `undefined`;
                 Expected SameValue(«null», «undefined») to be true (line 16)
```

Standalone direct smoke also reproduces the mismatch for `Symbol()` while the
non-empty control `Symbol("x").description === "x"` remains correct. Nearby
candidate controls were checked before selection: Number.isFinite and
Reflect.get abrupt-result rows pass in both lanes, and the failure is therefore
scoped to this Symbol description conversion.

## Bounded implementation plan

1. In the generic `ref`/`ref_null` → `externref` coercion, recognize only a
   nullable native-string value. Preserve the non-null native string through
   `extern.convert_any`; map the null native-string sentinel to the canonical
   standalone/native-strings `undefined` externref.
2. Leave non-null native strings, ordinary GC references, host-only nullable
   references, and Symbol description storage unchanged.
3. Add a focused regression covering the exact Test262 getter plus direct
   empty, `undefined`, and non-empty Symbol descriptions in standalone mode;
   rerun a host-lane control to ensure the boundary remains valid there.

## Acceptance and regression controls

- The exact getter row changes from 0/1 standalone pass to 1/1, with host
  behavior remaining 1/1.
- `Symbol().description` and `Symbol(undefined).description` are strictly
  `undefined`; `Symbol("").description` and `Symbol("x").description` remain
  exact strings.
- Standalone compilation remains host-free (zero imports for the direct
  smoke), and the source diff stays within the 180 production-LOC cap.
- TypeScript 5/7, focused tests, lint/format, issue checks, and LOC/function
  budget checks pass before handoff.

## Implementation Summary

The `coerceType` native-string boundary now tees a nullable `$AnyString`,
checks its null sentinel, and emits `canonicalUndefinedExternInstrs(ctx)` for
the null arm. Non-null native strings still use `extern.convert_any`; no
Symbol storage, property dispatch, or host import path changed.

## Test Results

- Exact Test262 getter: **host 1/1 pass, standalone 1/1 pass** (the baseline
  was host 1/1 and standalone 0/1).
- Focused Test262 controls: **6/6 pass** across host and standalone for
  `description-symboldescriptivestring.js` and
  `keyFor/arg-symbol-registry-miss.js`.
- `tests/issue-4741.test.ts`: **3/3 pass** (exact host/standalone rows plus
  zero-import direct smoke).
- Existing `tests/issue-2163-registry-standalone.test.ts` and
  `tests/issue-2163-tostring-standalone.test.ts`: **19/19 pass**. The older
  `tests/issue-2163.test.ts` remains **13/14**, with its empty-string nested
  ternary failure reproduced on the unpatched upstream base before this
  change; it is not a regression from #4741.
- TypeScript 5 and TypeScript 7 checks: pass.
- Biome lint and Prettier format check: pass.
- LOC budget: **+17 production LOC**, explicitly allowed here and below the
  180-LOC cap. Function budget: **+17** in `coerceType`, explicitly allowed.
- Issue/ID/spec-coverage/done-status/IR-retirement checks: pass (the issue
  scripts retain their existing warnings for unrelated ready issues).
