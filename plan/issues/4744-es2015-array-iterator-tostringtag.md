---
id: 4744
title: "ES2015 standalone ArrayIteratorPrototype Symbol.toStringTag"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-26
completed: 2026-08-26
assignee: "codex/4744-es2015-array-iterator-tostringtag"
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
es_edition: es2015
language_feature: array-iterator-prototype
goal: standalone-mode
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/object-proto-tostring.ts
func-budget-allow:
  - src/codegen/array-object-proto.ts::emitIteratorPrototypeSingleton
files:
  - src/codegen/array-object-proto.ts
  - src/codegen/object-proto-tostring.ts
  - tests/issue-4744.test.ts
---

# #4744 — ES2015 standalone `%ArrayIteratorPrototype%[@@toStringTag]`

## Scope and baseline

The authoritative source baseline is `upstream/main` at
`3af52383804fc5d82455e7d50c6fec3e80d97d4a` (2026-08-25). The exact Test262
rows are:

- `test/built-ins/ArrayIteratorPrototype/Symbol.toStringTag/property-descriptor.js`
- `test/built-ins/ArrayIteratorPrototype/Symbol.toStringTag/value-direct.js`
- `test/built-ins/ArrayIteratorPrototype/Symbol.toStringTag/value-from-to-string.js`

Fresh baseline JSONL (oracle version 13, fetched 2026-08-25) records host as
**3/3 pass** and standalone as **0/3 pass**:

| lane | property-descriptor | value-direct | value-from-to-string |
| --- | --- | --- | --- |
| host | pass (7074 ms) | pass (1872 ms) | pass (2271 ms) |
| standalone | fail: expected `"Array Iterator"`, got `undefined` (2412 ms) | fail: expected `"Array Iterator"`, got `undefined` (1480 ms) | fail: expected `"[object Array Iterator]"`, got `"[object Array]"` (707 ms) |

The first two failures share one root: standalone
`Object.getPrototypeOf([][Symbol.iterator]())` already returns the
identity-stable native `%ArrayIteratorPrototype%` `$Object` singleton, but the
singleton has no own `Symbol.toStringTag` descriptor. The third is the direct
`Object.prototype.toString.call(ArrayIterator)` form: the static standalone
tag resolver classifies the native iterator carrier as an Array and does not
recognize the ES2015 `ArrayIterator` tag.

This case is distinct from the open Set/Map iterator work (#4731), Promise
residuals (#4735/#4736), and the other active #4742/#4743 handoff cases. The
host lane is a must-pass control, and the three exact rows are retained as the
regression surface.

## Implementation plan

1. Seed each native iterator-prototype singleton with its own well-known
   `Symbol.toStringTag` data property using the existing native object
   descriptor helper. For the Array singleton the value is `"Array Iterator"`
   with `{ writable: false, enumerable: false, configurable: true }`; the
   generic iterator-kind helper keeps Map/Set/String tags aligned with the
   same intrinsic representation.
2. Teach the standalone direct `Object.prototype.toString.call(...)` static
   resolver that a checker `ArrayIterator` receiver has the
   `"[object Array Iterator]"` tag. Host mode continues to defer to the real
   host classifier, preserving the existing 3/3 host baseline.
3. Add focused host/standalone compiler tests for the exact three semantics,
   including the shared prototype identity and descriptor flags. Keep the
   production change below the 180-line cap and avoid changing generic object
   property or iterator dispatch.

## Risks and non-goals

- Do not alter array iterator construction, `Object.getPrototypeOf` identity,
  or iterator `next()` behavior; those are already covered by #3013.
- Do not make the generic `Object.prototype.toString` fallback claim tags for
  arbitrary iterator-like objects. Only the checker-proven native
  `ArrayIterator` form receives this standalone fold.
- Host behavior must remain on its existing dynamic path so user mutations of
  `Symbol.toStringTag` remain observable there.

## Acceptance criteria

- All three exact Test262 rows pass in standalone and host lanes.
- The `%ArrayIteratorPrototype%` singleton remains identity-stable and its
  descriptor is exactly `{ writable: false, enumerable: false,
  configurable: true }`.
- Focused regression tests, TypeScript 5/7, lint, format, LOC/function
  budgets, issue checks, hooks, and post-upstream-merge validation pass.

## Test Results

Fixed verification on the implementation branch (2026-08-26):

- The exact three files above pass **3/3 host** and **3/3 standalone** through
  `runTest262File`; the host control remains unchanged and standalone changes
  from 0/3 to 3/3.
- `node node_modules/vitest/dist/cli.js run tests/issue-4744.test.ts
  --reporter=verbose`: **7 passed** (six exact lane checks plus the standalone
  identity control).
- Existing `tests/issue-3013-array-iterator-prototype-identity.test.ts`: **8
  passed**, confirming the seeded descriptor does not disturb the shared
  prototype identity or host-free iterator behavior.
- TypeScript 5 (`node node_modules/typescript/lib/tsc.js --noEmit`) and
  TypeScript 7 (`node node_modules/typescript7/lib/tsc.js --noEmit -p
  tsconfig.ts7.json`): pass.
- Biome lint on the two changed codegen files and the focused test: pass.
- Prettier check on the same files: pass; `git diff --check`: pass.
- LOC/function budgets: pass; production net growth is **+31 LOC** (+24 in
  `emitIteratorPrototypeSingleton`, +7 in the tag resolver), below the 180
  LOC cap. Issue-id and issue-ledger checks pass.

The focused control also confirms that `[][Symbol.iterator]()`, `.values()`,
and `.entries()` return iterators whose shared prototype is genuinely distinct
from `Array.prototype`.
